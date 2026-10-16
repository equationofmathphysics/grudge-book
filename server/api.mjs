import { ApiError,fail,invalid,exactKeys,normalizeNotebook,emptyNotebook,MAX_BYTES,validateAlias,personKey } from './validation.mjs';
import { stmt,one,all,run,randomHex,hash,publicUser } from './db.mjs';
import { countContributions,hasWithdrawal,invalidateStatement,mutualIds,getAggregate,weekStart,epochStatement,revokeStatement,DELAY } from './aggregate.mjs';
const JSON_HEADERS={'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{...JSON_HEADERS,...headers}});
export async function consumeLimit(db,scope,key,limit,windowMs,now){
 const window=Math.floor(now/windowMs),bucket=scope+':'+window+':'+await hash(key);
 const row=await one(db,'INSERT INTO rate_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count',bucket,(window+1)*windowMs);
 if(row.count>limit)fail(429,'rate_limited','请求过于频繁，请稍后再试。');
 // Bounded cleanup avoids one request deleting an unbounded number of rows.
 await run(db,'DELETE FROM rate_limits WHERE bucket IN (SELECT bucket FROM rate_limits WHERE expires_at<? LIMIT 100)',now);
}
async function readJson(request){
 if(!(request.headers.get('content-type')??'').toLowerCase().startsWith('application/json'))fail(415,'json_required','请发送 JSON。');
 if(Number(request.headers.get('content-length'))>MAX_BYTES+16384)fail(413,'request_too_large','请求过大。');
 const reader=request.body?.getReader();if(!reader)invalid();
 let size=0;const chunks=[];
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES+16384){await reader.cancel();fail(413,'request_too_large','请求过大。');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{invalid();}
}
function checkCsrf(request,origin){
 if(request.headers.get('origin')!==origin||request.headers.get('x-grudge-request')!=='1')fail(403,'csrf_rejected','请求来源验证失败，请刷新后重试。');
 const site=request.headers.get('sec-fetch-site');if(site&&site!=='same-origin'&&site!=='none')fail(403,'csrf_rejected','请求来源验证失败。');
}
async function sitesUser(db,request,now){
 const subject=request.headers.get('oai-authenticated-user-id');
 if(!subject)return null;if(subject.length>500||/[\x00-\x20\x7f]/.test(subject))fail(401,'unauthenticated','请登录。');
 let user=await one(db,'SELECT * FROM members WHERE platform_subject=?',subject);
 if(!user){
  const id=crypto.randomUUID();
  await db.batch([
   stmt(db,'INSERT INTO members(id,platform_subject,display_name,friend_code,created_at) VALUES(?,?,?,?,?) ON CONFLICT(platform_subject) DO NOTHING',id,subject,'矮人',randomHex(16),now),
   stmt(db,'INSERT INTO notebooks(user_id,body,revision,updated_at) SELECT id,?,0,? FROM members WHERE platform_subject=? ON CONFLICT(user_id) DO NOTHING',JSON.stringify(emptyNotebook()),now,subject)
  ]);
  user=await one(db,'SELECT * FROM members WHERE platform_subject=?',subject);
 }
 return user;
}
async function notebookRow(db,id){return await one(db,'SELECT body,revision FROM notebooks WHERE user_id=?',id);}
const notebookOut=row=>({...JSON.parse(row.body),revision:row.revision});
async function saveNotebook(ctx,user,body,importing){
 exactKeys(body,['expectedRevision','notebook']);if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)invalid();
 const row=await notebookRow(ctx.db,user.id);if(row.revision!==body.expectedRevision)fail(409,'revision_conflict','另一处已有新版本，请重新载入后合并。');
 const before=JSON.parse(row.body);let next=normalizeNotebook(body.notebook,ctx.now,{importing});
 if(importing){
  const ids=new Set(before.entries.map(e=>e.id)),pids=new Set(before.people.map(p=>p.id)),names=new Set(before.people.map(p=>personKey(p.name)));
  next=normalizeNotebook({version:1,entries:[...before.entries,...next.entries.filter(e=>!ids.has(e.id))],people:[...before.people,...next.people.filter(p=>!pids.has(p.id)&&!names.has(personKey(p.name)))],appliedMigrations:[...new Set([...before.appliedMigrations,...next.appliedMigrations])]},ctx.now);
 }else{
  const old=new Map(before.entries.map(e=>[e.id,e]));
  const origins=new Map((await all(ctx.db,"SELECT entry_id,target_user_id FROM entry_origins WHERE user_id=? AND entry_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))",user.id,JSON.stringify(next.entries))).map(e=>[e.entry_id,e.target_user_id]));
  const friends=await mutualIds(ctx.db,user.id),aliases=await all(ctx.db,'SELECT friend_id FROM aliases WHERE owner_id=? AND length(trim(alias))>0',user.id),named=new Set(aliases.map(a=>a.friend_id));
  for(const e of next.entries){
   const prior=old.get(e.id);
   if(e.targetUserId){
    if((prior&&prior.targetUserId!==e.targetUserId)||(origins.has(e.id)&&origins.get(e.id)!==e.targetUserId))fail(400,'invalid_link','旧条目不能重新关联账号。');
    if(!prior&&(!friends.has(e.targetUserId)||!named.has(e.targetUserId)||e.example||e.personalDemo))fail(400,'invalid_link','新条目只能关联已接受且设过备注的好友。');
    if(prior&&!friends.has(e.targetUserId))e.shareInAggregate=false;
    if(e.shareInAggregate&&(!friends.has(e.targetUserId)||e.example||e.personalDemo))fail(400,'invalid_link','只有双方同意的好友新条目可以计数。');
   }else if(e.shareInAggregate)fail(400,'invalid_link','未关联好友的条目不能计数。');
  }
 }
 const serialized=JSON.stringify(next);if(serialized===row.body)return notebookOut(row);
 const token=randomHex(),revision=row.revision+1,counts=JSON.stringify(countContributions(next));
 const batch=[
  stmt(ctx.db,'INSERT INTO aggregate_revisions(user_id,revision,published_at,mutation_id,counts) SELECT user_id,revision+1,?,?,? FROM notebooks WHERE user_id=? AND revision=?',ctx.now,token,counts,user.id,row.revision),
  stmt(ctx.db,'UPDATE notebooks SET body=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=? AND EXISTS(SELECT 1 FROM aggregate_revisions WHERE user_id=? AND revision=? AND mutation_id=?)',serialized,ctx.now,user.id,row.revision,user.id,revision,token)
 ];
 if(hasWithdrawal(before,next))batch.push(invalidateStatement(ctx.db,[user.id],weekStart(ctx.now),'AND EXISTS(SELECT 1 FROM aggregate_revisions WHERE user_id=? AND revision=? AND mutation_id=?)',[user.id,revision,token]));
 batch.push(stmt(ctx.db,"INSERT INTO entry_origins(user_id,entry_id,target_user_id,created_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.targetUserId'),? FROM json_each(?) WHERE EXISTS(SELECT 1 FROM aggregate_revisions WHERE user_id=? AND revision=? AND mutation_id=?) ON CONFLICT(user_id,entry_id) DO NOTHING",user.id,ctx.now,JSON.stringify(next.entries),user.id,revision,token));
 if(hasWithdrawal(before,next))for(const week of new Set([weekStart(ctx.now),weekStart(ctx.now+DELAY)]))batch.push(revokeStatement(ctx.db,user.id,week,'WHERE EXISTS(SELECT 1 FROM aggregate_revisions WHERE user_id=? AND revision=? AND mutation_id=?)',[user.id,revision,token]));
 batch.push(epochStatement(ctx.db));
 const result=await ctx.db.batch(batch);
 if(result[1].meta.changes!==1)fail(409,'revision_conflict','另一处已有新版本，请重新载入后合并。');
 return {...next,revision};
}
const pair=(a,b)=>a<b?[a,b]:[b,a];
async function listFriends(db,id){
 const rows=await all(db,`SELECT m.id,m.display_name,f.status,f.requester_id,a.alias FROM friendships f JOIN members m ON m.id=CASE WHEN f.low_id=? THEN f.high_id ELSE f.low_id END LEFT JOIN aliases a ON a.owner_id=? AND a.friend_id=m.id WHERE f.low_id=? OR f.high_id=? ORDER BY lower(coalesce(a.alias,m.display_name)),m.id`,id,id,id,id);
 const result={friends:[],incoming:[],outgoing:[]};
 for(const r of rows){const item={id:r.id,displayName:r.display_name};if(r.status==='accepted')result.friends.push({...item,alias:r.alias??''});else result[r.requester_id===id?'outgoing':'incoming'].push(item);}
 return result;
}
export async function handleApi(request,options){
 let ctx;
 try{
  if(!options?.db||!['sites','standalone'].includes(options.mode))throw Error('Invalid server configuration');
  ctx={...options,now:typeof options.now==='function'?options.now():Date.now()};
  const url=new URL(request.url),path=url.pathname,method=request.method.toUpperCase();
  if(url.search)fail(400,'query_not_supported','接口不接受其他用户或查询参数。');
  if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))fail(405,'method_not_allowed','不支持此请求方式。');
  if(method!=='GET')checkCsrf(request,options.origin??url.origin);
  if(method!=='GET'&&(request.headers.get('content-length')!=='0'||method!=='DELETE')){ /* JSON parsed only where required below. */ }
  const user=ctx.mode==='sites'?await sitesUser(ctx.db,request,ctx.now):await ctx.auth.session(request,ctx.now);
  if(path==='/api/session'&&method==='GET')return response({mode:ctx.mode,user:publicUser(user)});
  if(path.startsWith('/api/auth/')){
   if(ctx.mode!=='standalone')fail(404,'platform_auth','请使用平台登录。');
   if(path==='/api/auth/challenge'&&method==='GET')return response(await ctx.auth.challenge(ctx.now,ctx.clientAddress??'unknown'));
   if(method!=='POST')fail(405,'method_not_allowed','不支持此请求方式。');
   if(path==='/api/auth/register')return response(await ctx.auth.register(await readJson(request),ctx.now,ctx.clientAddress??'unknown'));
   if(path==='/api/auth/login'){const result=await ctx.auth.login(await readJson(request),ctx.now,ctx.clientAddress??'unknown');return response({mode:ctx.mode,user:publicUser(result.user)},200,{'Set-Cookie':result.cookie});}
   if(path==='/api/auth/logout'){if(user&&request.headers.get('x-grudge-owner')!==user.id)fail(409,'account_changed','登录账号已变化，请重新打开账号书库。');const cookie=await ctx.auth.logout(request);return response({ok:true},200,{'Set-Cookie':cookie});}
   fail(404,'not_found','接口不存在。');
  }
  if(!user)fail(401,'unauthenticated','请登录后打开账号书库。');
  if(request.headers.get('x-grudge-owner')!==user.id)fail(409,'account_changed','登录账号已变化，请重新打开账号书库。');
  if(path==='/api/notebook'&&method==='GET')return response(notebookOut(await notebookRow(ctx.db,user.id)));
  if((path==='/api/notebook'&&method==='PUT')||(path==='/api/notebook/import'&&method==='POST')){
   await consumeLimit(ctx.db,'write',user.id,120,60000,ctx.now);
   return response(await saveNotebook(ctx,user,await readJson(request),path.endsWith('/import')));
  }
  if(path==='/api/friends'&&method==='GET')return response(await listFriends(ctx.db,user.id));
  if(path==='/api/friends/requests'&&method==='POST'){
   const body=await readJson(request);exactKeys(body,['friendCode']);if(typeof body.friendCode!=='string'||!/^[a-f0-9]{32}$/i.test(body.friendCode))invalid();
   await consumeLimit(ctx.db,'friend-request',user.id,20,3600000,ctx.now);
   const other=await one(ctx.db,'SELECT id FROM members WHERE friend_code=? AND is_system=0',body.friendCode.toLowerCase());
   if(!other||other.id===user.id) return response({ok:true});
   const count=await one(ctx.db,'SELECT count(*) AS n FROM friendships WHERE low_id=? OR high_id=?',user.id,user.id);const recipientCount=await one(ctx.db,'SELECT count(*) AS n FROM friendships WHERE low_id=? OR high_id=?',other.id,other.id);if(count.n>=500||recipientCount.n>=500)fail(400,'friend_limit','好友与待处理邀请最多 500 位。');
   const [low,high]=pair(user.id,other.id);
   await run(ctx.db,"INSERT INTO friendships(low_id,high_id,requester_id,status,created_at,accepted_at) VALUES(?,?,?,'pending',?,NULL) ON CONFLICT(low_id,high_id) DO NOTHING",low,high,user.id,ctx.now);
   return response({ok:true});
  }
  const requestMatch=path.match(/^\/api\/friends\/requests\/([a-zA-Z0-9-]{1,100})\/(accept|reject)$/);
  if(requestMatch&&method==='POST'){
   const other=requestMatch[1],action=requestMatch[2],[low,high]=pair(user.id,other);
   if(action==='accept')await ctx.db.batch([stmt(ctx.db,"UPDATE friendships SET status='accepted',accepted_at=? WHERE low_id=? AND high_id=? AND status='pending' AND requester_id=?",ctx.now,low,high,other),epochStatement(ctx.db)]);
   else await run(ctx.db,"DELETE FROM friendships WHERE low_id=? AND high_id=? AND status='pending' AND requester_id=?",low,high,other);
   return response({ok:true});
  }
  const friendMatch=path.match(/^\/api\/friends\/([a-zA-Z0-9-]{1,100})$/);
  if(friendMatch&&method==='PATCH'){
   const other=friendMatch[1],[low,high]=pair(user.id,other),body=await readJson(request);exactKeys(body,['alias']);const alias=validateAlias(body.alias);
   const relation=await one(ctx.db,"SELECT 1 AS yes FROM friendships WHERE low_id=? AND high_id=? AND status='accepted'",low,high);if(!relation)fail(404,'not_found','好友不存在。');
   await run(ctx.db,'INSERT INTO aliases(owner_id,friend_id,alias,alias_key) VALUES(?,?,?,?) ON CONFLICT(owner_id,friend_id) DO UPDATE SET alias=excluded.alias,alias_key=excluded.alias_key',user.id,other,alias,personKey(alias));return response({ok:true});
  }
  if(friendMatch&&method==='DELETE'){
   const other=friendMatch[1],[low,high]=pair(user.id,other);
   const changes=[invalidateStatement(ctx.db,[user.id,other],weekStart(ctx.now),'AND EXISTS(SELECT 1 FROM friendships WHERE low_id=? AND high_id=?)',[low,high])];
   for(const [owner,target] of [[user.id,other],[other,user.id]]){
    for(const week of new Set([weekStart(ctx.now),weekStart(ctx.now+DELAY)]))changes.push(revokeStatement(ctx.db,owner,week,'WHERE EXISTS(SELECT 1 FROM friendships WHERE low_id=? AND high_id=?)',[low,high]));
    const token=randomHex();
    changes.push(stmt(ctx.db,`INSERT INTO aggregate_revisions(user_id,revision,published_at,mutation_id,counts) SELECT user_id,revision+1,?,?,json_remove(coalesce((SELECT counts FROM aggregate_revisions a WHERE a.user_id=notebooks.user_id ORDER BY revision DESC LIMIT 1),'{}'),?) FROM notebooks WHERE user_id=? AND EXISTS(SELECT 1 FROM json_each(body,'$.entries') WHERE json_extract(value,'$.targetUserId')=? AND json_extract(value,'$.shareInAggregate')=1)`,ctx.now,token,'$."'+target+'"',owner,target));
    changes.push(stmt(ctx.db,`UPDATE notebooks SET body=json_set(body,'$.entries',json((SELECT json_group_array(json(CASE WHEN json_extract(value,'$.targetUserId')=? THEN json_set(value,'$.shareInAggregate',json('false')) ELSE value END)) FROM json_each(body,'$.entries')))),revision=revision+1,updated_at=? WHERE user_id=? AND EXISTS(SELECT 1 FROM aggregate_revisions a WHERE a.user_id=notebooks.user_id AND a.revision=notebooks.revision+1 AND a.mutation_id=?)`,target,ctx.now,owner,token));
   }
   changes.push(stmt(ctx.db,'DELETE FROM aliases WHERE (owner_id=? AND friend_id=?) OR (owner_id=? AND friend_id=?)',user.id,other,other,user.id),stmt(ctx.db,'DELETE FROM friendships WHERE low_id=? AND high_id=?',low,high),epochStatement(ctx.db));
   await ctx.db.batch(changes);return response({ok:true});
  }
  if(path==='/api/aggregate'&&method==='GET')return response(await getAggregate(ctx.db,user.id,ctx.now,ctx.aggregateEnabled===true));
  fail(404,'not_found','接口不存在。');
 }catch(error){
  if(error instanceof ApiError)return response({error:{code:error.code,message:error.message}},error.status,error.status===429?{'Retry-After':'900'}:{});
  // Never log cookies, notebook content, passwords or identity headers.
  console.error('API failure:',error?.name??'Error',String(error?.message??'').slice(0,160));
  return response({error:{code:'internal_error',message:'暂时无法处理，请稍后重试。'}},500);
 }
}
