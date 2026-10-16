import { scrypt,timingSafeEqual,randomBytes,randomInt } from 'node:crypto';
import { promisify } from 'node:util';
import { validateCredentials,emptyNotebook,fail,invalid } from './validation.mjs';
import { stmt,one,run,hash,randomHex } from './db.mjs';
import { consumeLimit } from './api.mjs';
const derive=promisify(scrypt),SESSION_AGE=7*86400000,LOCK_AGE=30*60000,PARAMS={N:32768,r:8,p:3,maxmem:64*1024*1024};
const COOKIE='grudge_session',SYSTEM_ID='00000000-0000-4000-8000-000000000000';
const DUMMY='scrypt$32768$8$3$00000000000000000000000000000000$'+'0'.repeat(128);
let activeHashes=0;
async function passwordHash(password,stored){
 if(activeHashes>=2)fail(429,'rate_limited','请求过于频繁，请稍后再试。');activeHashes++;
 try{const salt=stored?Buffer.from(stored.split('$')[4],'hex'):randomBytes(16),key=await derive(password,salt,64,PARAMS);
  if(stored){const expected=Buffer.from(stored.split('$')[5],'hex');return expected.length===key.length&&timingSafeEqual(expected,key);}
  return `scrypt$32768$8$3$${salt.toString('hex')}$${key.toString('hex')}`;
 }finally{activeHashes--;}
}
function tokenFrom(request){const match=(request.headers.get('cookie')??'').match(/(?:^|;\s*)grudge_session=([a-f0-9]{64})(?:;|$)/);return match?.[1]??null;}
const badLogin=()=>fail(401,'invalid_credentials','用户名或密码不正确，或账号暂时无法登录。');
export function createAuth(db,{secureCookies=true}={}){
 const cookie=(token,maxAge)=>`${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies?'; Secure':''}`;
 return {
  async session(request,now){const token=tokenFrom(request);if(!token)return null;return await one(db,'SELECT m.* FROM sessions s JOIN members m ON m.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND m.is_system=0',await hash(token),now);},
  async challenge(now,address){
   await consumeLimit(db,'challenge-ip',address,30,3600000,now);
   const a=randomInt(10,100),b=randomInt(10,100),c=randomInt(2,10),e=randomInt(2,10),answer=Math.floor((a+b)*c/e)-randomInt(1,10),d=(a+b)*c-answer*e,id=randomHex(32),expires=now+5*60000;
   await db.batch([
    stmt(db,'INSERT INTO auth_challenges(id,answer_hash,expires_at,consumed_at) VALUES(?,?,?,NULL)',id,await hash(id+':'+answer),expires),
    stmt(db,'DELETE FROM auth_challenges WHERE id IN (SELECT id FROM auth_challenges WHERE expires_at<? LIMIT 100)',now)
   ]);
   return {challengeId:id,question:`((${a} + ${b}) × ${c} − ${d}) ÷ ${e} = ?`,expiresAt:new Date(expires).toISOString()};
  },
  async register(body,now,address){
   const data=validateCredentials(body,true);
   await consumeLimit(db,'register-ip',address,5,3600000,now);
   if(typeof body.challengeId!=='string'||!/^[a-f0-9]{64}$/.test(body.challengeId)||!['string','number'].includes(typeof body.answer)||!/^[-]?\d{1,8}$/.test(String(body.answer).trim()))invalid();
   // First use consumes the challenge, including a wrong answer; expiry/replay fail alike.
   const challenge=await one(db,'UPDATE auth_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>? RETURNING answer_hash',now,body.challengeId,now);
   const answer=await hash(body.challengeId+':'+Number(String(body.answer).trim()));
   if(!challenge||challenge.answer_hash!==answer)fail(400,'invalid_challenge','算术答案不正确或题目已过期，请换一道题。');
   const password=await passwordHash(data.password),id=crypto.randomUUID();
   await db.batch([
    stmt(db,'INSERT INTO members(id,username,password_hash,display_name,friend_code,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(username) DO NOTHING',id,data.username,password,data.displayName,randomHex(16),now),
    stmt(db,'INSERT INTO notebooks(user_id,body,revision,updated_at) SELECT id,?,0,? FROM members WHERE id=?',JSON.stringify(emptyNotebook()),now,id)
   ]);
   return {ok:true,message:'注册请求已处理，请使用用户名和密码登录。'};
  },
  async login(body,now,address){
   const data=validateCredentials(body,false);
   await consumeLimit(db,'login-ip',address,60,15*60000,now);
   // This is a broad persistent abuse limiter; the separate consecutive counter
   // below provides exactly five attempts and a thirty-minute account lock.
   await consumeLimit(db,'login-name',data.username,60,3600000,now);
   const user=await one(db,'SELECT * FROM members WHERE username=? AND is_system=0',data.username);
   const valid=await passwordHash(data.password,user?.password_hash??DUMMY);
   const state=await one(db,'SELECT * FROM auth_failures WHERE username=?',data.username);
   if(state?.locked_until>now)badLogin();
   if(!user||!valid){
    const until=now+LOCK_AGE,statements=[stmt(db,`INSERT INTO auth_failures(username,failure_count,locked_until,updated_at) VALUES(?,1,NULL,?) ON CONFLICT(username) DO UPDATE SET failure_count=CASE WHEN locked_until IS NOT NULL AND locked_until<=? THEN 1 ELSE failure_count+1 END,locked_until=CASE WHEN locked_until IS NOT NULL AND locked_until<=? THEN NULL WHEN failure_count+1>=5 THEN ? ELSE NULL END,updated_at=? WHERE locked_until IS NULL OR locked_until<=?`,data.username,now,now,now,until,now,now)];
    if(user){
     statements.push(stmt(db,"INSERT INTO members(id,is_system,display_name,friend_code,created_at) VALUES(?,1,'系统守门人',?,?) ON CONFLICT(id) DO NOTHING",SYSTEM_ID,randomHex(16),now));
     statements.push(stmt(db,"INSERT INTO audit_grudges(id,owner_id,target_id,kind,severity,created_at) SELECT ?,?,?,'five_failed_logins',1,? WHERE EXISTS(SELECT 1 FROM auth_failures WHERE username=? AND failure_count=5 AND locked_until=?) ON CONFLICT(id) DO NOTHING",await hash(user.id+':'+until),SYSTEM_ID,user.id,now,data.username,until));
    }
    // Remove old nonexistent-name counters in bounded batches; retain locks.
    statements.push(stmt(db,'DELETE FROM auth_failures WHERE username IN (SELECT username FROM auth_failures WHERE updated_at<? AND (locked_until IS NULL OR locked_until<=?) LIMIT 100)',now-30*86400000,now));
    await db.batch(statements);badLogin();
   }
   const token=randomHex(32);
   const result=await db.batch([
    stmt(db,'INSERT INTO sessions(token_hash,user_id,expires_at,created_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM auth_failures WHERE username=? AND locked_until>?)',await hash(token),user.id,now+SESSION_AGE,now,data.username,now),
    stmt(db,'DELETE FROM auth_failures WHERE username=? AND (locked_until IS NULL OR locked_until<=?)',data.username,now),
    stmt(db,'DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<=? LIMIT 100)',now)
   ]);
   if(result[0].meta.changes!==1)badLogin();
   return {user,cookie:cookie(token,SESSION_AGE/1000)};
  },
  async logout(request){const token=tokenFrom(request);if(token)await run(db,'DELETE FROM sessions WHERE token_hash=?',await hash(token));return cookie('',0);}
 };
}
