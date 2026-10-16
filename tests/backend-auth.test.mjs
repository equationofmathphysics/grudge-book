import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase,migrateDatabase} from '../server/sqlite.mjs';
import {createAuth} from '../server/auth-node.mjs';
import {handleApi} from '../server/api.mjs';
const ORIGIN='https://book.example',PASSWORD='Correct Horse 8123!';
function solve(question){const m=question.match(/\(\((\d+) \+ (\d+)\) × (\d+) − (\d+)\) ÷ (\d+)/);assert.ok(m);const [,a,b,c,d,e]=m.map(Number);return String(((a+b)*c-d)/e);}
function fixture(t,file=':memory:'){
 const f={now:Date.parse('2026-10-15T12:00:00Z'),db:openDatabase(file),ip:'203.0.113.1'};migrateDatabase(f.db);f.auth=createAuth(f.db);t.after(()=>f.db?.close());
 f.request=async(path,method='GET',body,{cookie='',owner='',headers={}}={})=>{
  const response=await handleApi(new Request(ORIGIN+path,{method,headers:{origin:ORIGIN,'content-type':'application/json','x-grudge-request':'1','x-grudge-owner':owner,cookie,...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})}),{mode:'standalone',db:f.db,auth:f.auth,origin:ORIGIN,clientAddress:f.ip,now:()=>f.now,aggregateEnabled:true});
  return {status:response.status,body:await response.json(),headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
 };
 f.challenge=async()=>{const result=await f.request('/api/auth/challenge');assert.equal(result.status,200);return {...result.body,answer:solve(result.body.question)};};
 f.register=async(username='alice')=>{const c=await f.challenge();return f.request('/api/auth/register','POST',{username,password:PASSWORD,challengeId:c.challengeId,answer:c.answer});};
 f.login=(username='alice',password=PASSWORD)=>f.request('/api/auth/login','POST',{username,password});return f;
}
test('registration is non-enumerating; passwords salted scrypt; session private and logout invalidates',async t=>{
 const f=fixture(t);const created=await f.register(),duplicate=await f.register();assert.equal(created.status,200);assert.deepEqual(created.body,duplicate.body);assert.equal(created.cookie,undefined);
 const row=f.db.native.prepare('SELECT * FROM members WHERE username=?').get('alice');assert.match(row.password_hash,/^scrypt\$32768\$8\$3\$/);assert.ok(!row.password_hash.includes(PASSWORD));
 const login=await f.login();assert.equal(login.status,200);for(const attr of ['HttpOnly','Secure','SameSite=Strict'])assert.ok(login.headers.get('set-cookie').includes(attr));
 const stored=f.db.native.prepare('SELECT token_hash FROM sessions').get().token_hash;assert.notEqual(stored,login.cookie.split('=')[1]);
 assert.equal((await f.request('/api/session','GET',undefined,{cookie:login.cookie})).body.user.id,row.id);
 assert.equal((await f.request('/api/auth/logout','POST',{}, {cookie:login.cookie,owner:row.id})).status,200);
 assert.equal((await f.request('/api/session','GET',undefined,{cookie:login.cookie})).body.user,null);
});
test('math challenge includes all four operations, expires, consumes wrong and replay attempts',async t=>{
 const f=fixture(t);const c=await f.challenge();for(const op of ['+','−','×','÷'])assert.ok(c.question.includes(op));
 const body={username:'alice',password:PASSWORD,challengeId:c.challengeId,answer:Number(c.answer)+1};
 assert.equal((await f.request('/api/auth/register','POST',body)).status,400);body.answer=c.answer;
 assert.equal((await f.request('/api/auth/register','POST',body)).status,400);
 const second=await f.challenge();f.now+=5*60000+1;
 assert.equal((await f.request('/api/auth/register','POST',{...body,challengeId:second.challengeId,answer:second.answer})).status,400);
});
test('five consecutive failed passwords lock for30minutes, correct credentials cannot bypass, one system minor grievance',async t=>{
 const f=fixture(t);await f.register();
 for(let n=0;n<4;n++)assert.equal((await f.login('alice','bad password')).status,401);
 assert.equal(f.db.native.prepare('SELECT locked_until FROM auth_failures').get().locked_until,null);
 assert.equal((await f.login('alice','bad password')).status,401);
 const locked=f.db.native.prepare('SELECT * FROM auth_failures').get();assert.equal(locked.failure_count,5);assert.equal(locked.locked_until,f.now+30*60000);
 assert.equal((await f.login()).status,401);assert.equal((await f.login('alice','bad password')).status,401);
 const audit=f.db.native.prepare('SELECT * FROM audit_grudges').all();assert.equal(audit.length,1);assert.equal(audit[0].severity,1);assert.equal(audit[0].kind,'five_failed_logins');
 const system=f.db.native.prepare('SELECT * FROM members WHERE is_system=1').get();assert.equal(system.username,null);assert.equal(system.password_hash,null);
 assert.equal(f.db.native.prepare('SELECT count(*) AS n FROM aggregate_revisions WHERE user_id=?').get(system.id).n,0);
 f.now+=30*60000;assert.equal((await f.login()).status,200);assert.equal(f.db.native.prepare('SELECT count(*) AS n FROM auth_failures').get().n,0);
});
test('successful login resets consecutive failures; nonexistent accounts return same failure and lock response',async t=>{
 const f=fixture(t);await f.register();
 for(let i=0;i<4;i++)await f.login('alice','wrong');assert.equal((await f.login()).status,200);
 for(let i=0;i<4;i++)await f.login('alice','wrong');assert.equal(f.db.native.prepare('SELECT locked_until FROM auth_failures WHERE username=?').get('alice').locked_until,null);
 const unknown=await f.login('nonexistent','wrong'),wrong=await f.login('alice','wrong');assert.deepEqual(unknown.body,wrong.body);
 for(let i=0;i<5;i++)assert.deepEqual((await f.login('nonexistent','wrong')).body,wrong.body);
 assert.equal(f.db.native.prepare('SELECT count(*) AS n FROM audit_grudges').get().n,1);
});
test('standalone ignores every forged platform identity header and stale owner prevents cross-tab leakage',async t=>{
 const f=fixture(t);await f.register();f.ip='203.0.113.2';await f.register('bobby');const a=await f.login(),b=await f.login('bobby');
 const forged=await f.request('/api/session','GET',undefined,{headers:{'oai-authenticated-user-id':a.body.user.id,'oai-authenticated-user-email':'owner@example.com','x-user-id':a.body.user.id}});assert.equal(forged.body.user,null);
 assert.equal((await f.request('/api/notebook','GET',undefined,{cookie:b.cookie,owner:a.body.user.id})).status,409);
 const write=await f.request('/api/notebook','PUT',{expectedRevision:0,notebook:{version:1,entries:[],people:[{id:'leak',name:'Alice secret',nemesis:false}],appliedMigrations:[]}},{cookie:b.cookie,owner:a.body.user.id});assert.equal(write.status,409);
 assert.deepEqual((await f.request('/api/notebook','GET',undefined,{cookie:b.cookie,owner:b.body.user.id})).body.people,[]);
});
test('SQLite restart preserves sessions, notebook, lock counters and rate limits',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'grudge-auth-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'book.sqlite');const f=fixture(t,file);await f.register();const login=await f.login();await f.login('alice','wrong');
 const owner=login.body.user.id;assert.equal((await f.request('/api/notebook','PUT',{expectedRevision:0,notebook:{version:1,entries:[],people:[{id:'person1',name:'保留',nemesis:true}],appliedMigrations:[]}},{cookie:login.cookie,owner})).status,200);
 f.db.close();f.db=openDatabase(file);migrateDatabase(f.db);f.auth=createAuth(f.db);
 assert.equal((await f.request('/api/session','GET',undefined,{cookie:login.cookie})).body.user.id,owner);
 assert.equal((await f.request('/api/notebook','GET',undefined,{cookie:login.cookie,owner})).body.people[0].name,'保留');
 assert.equal(f.db.native.prepare('SELECT failure_count FROM auth_failures').get().failure_count,1);assert.ok(f.db.native.prepare('SELECT count(*) AS n FROM rate_limits').get().n>0);
});
test('registration rate limit persists across process/connection restart',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'grudge-limit-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'book.sqlite'),f=fixture(t,file);
 for(let i=0;i<5;i++){const c=await f.challenge();await f.request('/api/auth/register','POST',{username:'user'+i,password:PASSWORD,challengeId:c.challengeId,answer:'-1'});}
 f.db.close();f.db=openDatabase(file);f.auth=createAuth(f.db);const c=await f.challenge();assert.equal((await f.request('/api/auth/register','POST',{username:'user6',password:PASSWORD,challengeId:c.challengeId,answer:c.answer})).status,429);
});
