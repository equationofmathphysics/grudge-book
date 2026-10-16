import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,migrateDatabase} from '../server/sqlite.mjs';
import {handleApi} from '../server/api.mjs';
import {weekStart,DELAY,WEEK} from '../server/aggregate.mjs';

const ORIGIN='https://grudge.example';
const EMPTY={version:1,entries:[],people:[],appliedMigrations:[]};
function fixture(t){
 const db=openDatabase(':memory:');migrateDatabase(db);t.after(()=>db.close());
 const f={db,now:Date.parse('2026-10-15T12:00:00Z')};
 f.request=async(subject,path='/api/notebook',method='GET',body,extra={})=>{
  const owner=db.native.prepare('SELECT id FROM members WHERE platform_subject=?').get(subject)?.id;
  const headers={'oai-authenticated-user-id':subject,origin:ORIGIN,'x-grudge-request':'1','content-type':'application/json',...(owner?{'x-grudge-owner':owner}:{}),...extra};
  for(const [key,value] of Object.entries(headers))if(value===null)delete headers[key];
  const response=await handleApi(new Request(ORIGIN+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})}),{db,mode:'sites',origin:ORIGIN,now:()=>f.now,aggregateEnabled:true});
  return {status:response.status,headers:response.headers,body:await response.json()};
 };
 f.user=async(subject)=>(await f.request(subject,'/api/session')).body.user;
 f.save=async(subject,entries,revision=0)=>f.request(subject,'/api/notebook','PUT',{expectedRevision:revision,notebook:{...EMPTY,entries}});
 f.friend=async(a,b)=>{
  const A=await f.user(a),B=await f.user(b);
  assert.equal((await f.request(a,'/api/friends/requests','POST',{friendCode:B.friendCode})).status,200);
  assert.equal((await f.request(b,`/api/friends/requests/${A.id}/accept`,'POST')).status,200);
  assert.equal((await f.request(a,`/api/friends/${B.id}`,'PATCH',{alias:'my-private-alias-'+b})).status,200);
  assert.equal((await f.request(b,`/api/friends/${A.id}`,'PATCH',{alias:'my-private-alias-'+a})).status,200);
  return [A,B];
 };
 return f;
}
const entry=(id,extra={})=>({id,target:'同名朋友',title:'私密内容',details:'never disclose this private note',occurred:'2026-10-01T12:00',severity:1,category:'其他恩怨',status:'open',...extra});

test('tenant isolation, arbitrary selector rejection, private aliases, and secure cache headers',async t=>{
 const f=fixture(t),[A,B]=await f.friend('alice','bob');
 assert.equal((await f.save('alice',[entry('secret')])).status,200);
 const own=await f.request('alice'),other=await f.request('bob');
 assert.equal(own.body.entries.length,1);assert.deepEqual(other.body.entries,[]);
 assert.match(own.headers.get('cache-control'),/no-store/);
 assert.equal((await f.request('bob','/api/notebook?userId='+A.id)).status,400);
 assert.equal((await f.request('bob','/api/notebook','PUT',{expectedRevision:0,notebook:EMPTY,userId:A.id})).status,400);
 const bobFriends=await f.request('bob','/api/friends');
 assert.ok(!JSON.stringify(bobFriends.body).includes('my-private-alias-bob'));
 assert.equal(bobFriends.body.friends[0].alias,'my-private-alias-alice');
 await f.user('charlie');assert.equal((await f.request('charlie',`/api/friends/${B.id}`,'PATCH',{alias:'stolen'})).status,404);
 for(const path of ['/api/aggregate/'+A.id,'/api/users/'+A.id+'/notebook'])assert.equal((await f.request('bob',path)).status,404);
});

test('anonymous requests and forged identity selectors cannot access a notebook',async t=>{
 const f=fixture(t);await f.user('alice');
 assert.equal((await f.request('alice','/api/notebook','GET',undefined,{'oai-authenticated-user-id':null,'x-user-id':'alice',cookie:'grudge_session=fake'})).status,401);
});

test('a stale tab cannot read or write another newly authenticated account',async t=>{
 const f=fixture(t),A=await f.user('alice');await f.user('bob');
 for(const path of ['/api/notebook','/api/friends','/api/aggregate']){
  assert.equal((await f.request('bob',path,'GET',undefined,{'x-grudge-owner':A.id})).status,409);
 }
 assert.equal((await f.request('bob','/api/notebook','PUT',{expectedRevision:0,notebook:{...EMPTY,entries:[entry('alice-private-content')]}},{'x-grudge-owner':A.id})).status,409);
 assert.deepEqual((await f.request('bob')).body.entries,[]);
 assert.equal((await f.request('bob','/api/notebook','GET',undefined,{'x-grudge-owner':null})).status,409);
});

test('state-changing calls require exact same origin and application CSRF header',async t=>{
 const f=fixture(t);await f.user('alice');
 const body={expectedRevision:0,notebook:EMPTY};
 for(const headers of [{origin:null},{origin:'https://attacker.example'},{'x-grudge-request':null},{'sec-fetch-site':'cross-site'}]){
  assert.equal((await f.request('alice','/api/notebook','PUT',body,headers)).status,403);
 }
 assert.equal((await f.request('alice','/api/notebook')).body.revision,0);
});

test('concurrent notebook writes have exactly one winner and one conflict, never 500',async t=>{
 const f=fixture(t);await f.user('alice');
 const results=await Promise.all([f.save('alice',[entry('one')]),f.save('alice',[entry('two')])]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal((await f.request('alice')).body.revision,1);
});

test('free text cannot imply identity; existing and imported entries cannot acquire a link',async t=>{
 const f=fixture(t),[,B]=await f.friend('alice','bob');
 let saved=await f.save('alice',[entry('existing',{target:'my-private-alias-bob'})]);
 assert.equal(saved.status,200);assert.equal(saved.body.entries[0].targetUserId,null);assert.equal(saved.body.entries[0].shareInAggregate,false);
 assert.equal((await f.save('alice',[entry('existing',{targetUserId:B.id,shareInAggregate:true})],1)).status,400);
 const imported=await f.request('alice','/api/notebook/import','POST',{expectedRevision:1,notebook:{...EMPTY,entries:[entry('imported',{targetUserId:B.id,shareInAggregate:true})]}});
 assert.equal(imported.status,200);
 const old=imported.body.entries.find(e=>e.id==='imported');assert.equal(old.targetUserId,null);assert.equal(old.shareInAggregate,false);
 assert.equal((await f.save('alice',imported.body.entries.map(e=>e.id==='imported'?{...e,targetUserId:B.id,shareInAggregate:true}:e),2)).status,400);
 assert.equal((await f.save('alice',[...imported.body.entries,entry('demo',{targetUserId:B.id,shareInAggregate:true,personalDemo:true})],2)).status,400);
});

test('omitting and reintroducing an imported entry cannot bypass immutable provenance',async t=>{
 const f=fixture(t),[,B]=await f.friend('alice','bob');
 const imported=await f.request('alice','/api/notebook/import','POST',{expectedRevision:0,notebook:{...EMPTY,entries:[entry('imported')]}});
 assert.equal(imported.status,200);
 const omitted=await f.save('alice',[],1);
 if(omitted.status===400)return; // Rejecting hard removal also preserves provenance.
 assert.equal(omitted.status,200);
 assert.equal((await f.save('alice',[entry('imported',{targetUserId:B.id,shareInAggregate:true})],2)).status,400);
});

test('fresh mutually accepted named friend selection links; pending and unaliased friends cannot',async t=>{
 const f=fixture(t),A=await f.user('alice'),B=await f.user('bob');
 await f.request('alice','/api/friends/requests','POST',{friendCode:B.friendCode});
 assert.equal((await f.save('alice',[entry('new',{targetUserId:B.id,shareInAggregate:true})])).status,400);
 await f.request('bob',`/api/friends/requests/${A.id}/accept`,'POST');
 assert.equal((await f.save('alice',[entry('new',{targetUserId:B.id,shareInAggregate:true})])).status,400);
 await f.request('alice',`/api/friends/${B.id}`,'PATCH',{alias:'本人备注'});
 const result=await f.save('alice',[entry('new',{targetUserId:B.id,shareInAggregate:true})]);
 assert.equal(result.status,200);assert.equal(result.body.entries[0].targetUserId,B.id);
});

async function eligibleFixture(t,{viewerCount=5,friendCount=10,friendEntries=5}={}){
 const f=fixture(t),readAt=f.now,week=weekStart(readAt);f.now=week-DELAY-86400000;
 const viewer=await f.user('viewer');const friends=[];
 for(let n=0;n<friendCount;n++){
  const subject='friend'+n,[,friend]=await f.friend('viewer',subject);friends.push({subject,...friend});
  const save=await f.save(subject,Array.from({length:friendEntries},(_,i)=>entry(`contribution-${n}-${i}`,{targetUserId:viewer.id,shareInAggregate:true})));
  assert.equal(save.status,200);
 }
 if(viewerCount)assert.equal((await f.save('viewer',Array.from({length:viewerCount},(_,i)=>entry('self-'+i,{targetUserId:friends[0].id,shareInAggregate:true})))).status,200);
 f.now=readAt;return Object.assign(f,{readAt,week,viewer,friends});
}

test('aggregate needs viewer five and ten friends with five records each',async t=>{
 for(const options of [{viewerCount:0},{viewerCount:4},{friendCount:9},{friendEntries:4}]){
  const f=await eligibleFixture(t,options);
  assert.deepEqual((await f.request('viewer','/api/aggregate')).body,{status:'locked'});
 }
 const f=await eligibleFixture(t),result=await f.request('viewer','/api/aggregate');
 assert.equal(result.status,200);assert.equal(result.body.status,'ready');assert.equal(result.body.total,50);
 assert.deepEqual(Object.keys(result.body).sort(),['nextUpdateAt','snapshotAt','status','total']);
});

test('withdrawal before the first aggregate read locks this week and cannot reveal withdrawn counts',async t=>{
 const f=await eligibleFixture(t);const friend=f.friends[0];
 const saved=await f.request(friend.subject);saved.body.entries[0].shareInAggregate=false;
 assert.equal((await f.save(friend.subject,saved.body.entries,saved.body.revision)).status,200);
 assert.deepEqual((await f.request('viewer','/api/aggregate')).body,{status:'locked'});
});

test('withdrawal after a ready snapshot permanently locks the week instead of recomputing',async t=>{
 const f=await eligibleFixture(t);assert.equal((await f.request('viewer','/api/aggregate')).body.status,'ready');
 const friend=f.friends[0],saved=await f.request(friend.subject);saved.body.entries[0].deletedAt=new Date(f.readAt).toISOString();
 assert.equal((await f.save(friend.subject,saved.body.entries,saved.body.revision)).status,200);
 assert.deepEqual((await f.request('viewer','/api/aggregate')).body,{status:'locked'});
 saved.body.entries[0].deletedAt=null;
 assert.equal((await f.save(friend.subject,saved.body.entries,saved.body.revision+1)).status,200);
 assert.deepEqual((await f.request('viewer','/api/aggregate')).body,{status:'locked'});
});

test('unfriending after snapshot locks rather than exposes a corrected count',async t=>{
 const f=await eligibleFixture(t);assert.equal((await f.request('viewer','/api/aggregate')).body.status,'ready');
 assert.equal((await f.request('viewer',`/api/friends/${f.friends[0].id}`,'DELETE')).status,200);
 assert.deepEqual((await f.request('viewer','/api/aggregate')).body,{status:'locked'});
});

test('forged client timestamps cannot backdate aggregate publication before cutoff',async t=>{
 const f=await eligibleFixture(t);const friend=f.friends[0],saved=await f.request(friend.subject);
 saved.body.entries.push(entry('forged-old',{targetUserId:f.viewer.id,shareInAggregate:true,createdAt:'2000-01-01T00:00:00Z',updatedAt:'2000-01-01T00:00:00Z'}));
 assert.equal((await f.save(friend.subject,saved.body.entries,saved.body.revision)).status,200);
 const result=await f.request('viewer','/api/aggregate');assert.equal(result.body.status,'ready');assert.equal(result.body.total,50);
});

test('withdrawal during snapshot construction cannot race past the privacy epoch check',async t=>{
 const f=await eligibleFixture(t),friend=f.friends[0],saved=await f.request(friend.subject);
 saved.body.entries[0].shareInAggregate=false;
 const originalPrepare=f.db.prepare.bind(f.db);let interrupted=false;
 f.db.prepare=sql=>{
  const statement=originalPrepare(sql);
  if(!sql.startsWith('INSERT INTO aggregate_snapshots'))return statement;
  return {bind(...args){const bound=statement.bind(...args);return {async run(){
   if(!interrupted){interrupted=true;assert.equal((await f.save(friend.subject,saved.body.entries,saved.body.revision)).status,200);}
   return bound.run();
  }};}};
 };
 assert.deepEqual((await f.request('viewer','/api/aggregate')).body,{status:'locked'});assert.equal(interrupted,true);
});

test('withdrawal lock lasts the week and a later eligible weekly snapshot can reopen',async t=>{
 const f=await eligibleFixture(t),friend=f.friends[0],saved=await f.request(friend.subject);
 assert.equal((await f.request('viewer','/api/aggregate')).body.status,'ready');
 saved.body.entries[0].shareInAggregate=false;
 saved.body.entries.push(entry('new-replacement',{targetUserId:f.viewer.id,shareInAggregate:true}));
 assert.equal((await f.save(friend.subject,saved.body.entries,saved.body.revision)).status,200);
 assert.deepEqual((await f.request('viewer','/api/aggregate')).body,{status:'locked'});
 f.now=f.week+WEEK;
 const next=await f.request('viewer','/api/aggregate');assert.equal(next.body.status,'ready');assert.equal(next.body.total,50);
});

test('ten eligible friends do not need to be ten distinct contributors to the viewer',async t=>{
 const f=await eligibleFixture(t);f.now=f.week-DELAY-86400000;
 for(const friend of f.friends.slice(1)){
  await f.friend(friend.subject,f.friends[0].subject);
  const saved=await f.request(friend.subject);
  saved.body.entries.forEach(e=>e.shareInAggregate=false);
  saved.body.entries.push(...Array.from({length:5},(_,i)=>entry('other-target-'+i,{targetUserId:f.friends[0].id,shareInAggregate:true})));
  assert.equal((await f.save(friend.subject,saved.body.entries,saved.body.revision)).status,200);
 }
 f.now=f.readAt;
 const result=await f.request('viewer','/api/aggregate');assert.equal(result.body.status,'ready');assert.equal(result.body.total,5);
});

test('Sunday withdrawal after next snapshot cutoff also locks Monday publication',async t=>{
 const f=await eligibleFixture(t),friend=f.friends[0],saved=await f.request(friend.subject);
 f.now=f.week+WEEK-12*3600000;
 saved.body.entries[0].shareInAggregate=false;
 assert.equal((await f.save(friend.subject,saved.body.entries,saved.body.revision)).status,200);
 f.now=f.week+WEEK;
 assert.deepEqual((await f.request('viewer','/api/aggregate')).body,{status:'locked'});
});
