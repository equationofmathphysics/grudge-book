import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,migrateDatabase} from '../server/sqlite.mjs';
import {createAuth} from '../server/auth-node.mjs';
import {handleApi} from '../server/api.mjs';

const ORIGIN='https://grudge.example',PASSWORD='Correct-Horse-77!';
function fixture(t){
 const db=openDatabase(':memory:');migrateDatabase(db);t.after(()=>db.close());
 const f={db,now:Date.parse('2026-10-15T12:00:00Z'),cookie:null,user:null,auth:createAuth(db)};
 f.call=async(path,method='GET',body,extra={})=>{
  const headers={origin:ORIGIN,'content-type':'application/json','x-grudge-request':'1',...(f.cookie?{cookie:f.cookie}:{}),...(f.user?{'x-grudge-owner':f.user.id}:{}),...extra};
  for(const[k,v]of Object.entries(headers))if(v===null)delete headers[k];
  const response=await handleApi(new Request(ORIGIN+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})}),{db,auth:f.auth,mode:'standalone',origin:ORIGIN,now:()=>f.now,clientAddress:'test-127.0.0.1',aggregateEnabled:true});
  return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')};
 };
 f.challenge=async()=>{
  const response=await f.call('/api/auth/challenge');assert.equal(response.status,200);
  const challenge=response.body,parts=challenge.question.match(/^\(\((\d+) \+ (\d+)\) × (\d+) − (\d+)\) ÷ (\d+) = \?$/);
  assert.ok(parts,'math challenge must be explicitly parenthesized and contain all four operations');
  const [a,b,c,d,e]=parts.slice(1).map(Number),answer=((a+b)*c-d)/e;assert.ok(Number.isInteger(answer));
  assert.deepEqual(Object.keys(challenge).sort(),['challengeId','expiresAt','question']);
  return {...challenge,answer};
 };
 f.register=async(username='alice')=>{
  const challenge=await f.challenge();return f.call('/api/auth/register','POST',{username,password:PASSWORD,challengeId:challenge.challengeId,answer:challenge.answer});
 };
 f.login=async(username='alice',password=PASSWORD)=>{
  const response=await f.call('/api/auth/login','POST',{username,password});
  if(response.status===200){f.cookie=response.cookie.split(';')[0];f.user=response.body.user;}
  return response;
 };
 return f;
}

test('registration math challenge is single use, rejects wrong answer and expires server-side',async t=>{
 const f=fixture(t),c=await f.challenge();
 const body={username:'alice',password:PASSWORD,challengeId:c.challengeId,answer:c.answer+1};
 assert.equal((await f.call('/api/auth/register','POST',body)).status,400);
 assert.equal((await f.call('/api/auth/register','POST',{...body,answer:c.answer})).status,400);
 assert.equal(f.db.native.prepare('SELECT count(*) AS n FROM members').get().n,0);
 const expired=await f.challenge();f.now+=5*60000;
 assert.equal((await f.call('/api/auth/register','POST',{...body,challengeId:expired.challengeId,answer:expired.answer})).status,400);
 const valid=await f.challenge();const correct={...body,challengeId:valid.challengeId,answer:valid.answer};
 assert.equal((await f.call('/api/auth/register','POST',correct)).status,200);
 assert.equal((await f.call('/api/auth/register','POST',correct)).status,400);
 assert.equal(f.db.native.prepare('SELECT count(*) AS n FROM members').get().n,1);
 const row=f.db.native.prepare('SELECT * FROM auth_challenges WHERE id=?').get(valid.challengeId);
 assert.ok(row.answer_hash);assert.ok(!Object.hasOwn(row,'answer'));assert.equal(row.consumed_at,f.now);
});

test('concurrent registration challenge reuse creates at most one account',async t=>{
 const f=fixture(t),c=await f.challenge();
 const results=await Promise.all(['alice','bobby'].map(username=>f.call('/api/auth/register','POST',{username,password:PASSWORD,challengeId:c.challengeId,answer:c.answer})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
 assert.equal(f.db.native.prepare('SELECT count(*) AS n FROM members').get().n,1);
});

test('four failures do not lock, fifth locks exactly thirty minutes, successful login resets earlier failures',async t=>{
 const f=fixture(t);assert.equal((await f.register()).status,200);
 for(let i=0;i<4;i++)assert.equal((await f.login('alice','wrong-password')).status,401);
 let state=f.db.native.prepare('SELECT * FROM auth_failures WHERE username=?').get('alice');assert.equal(state.failure_count,4);assert.equal(state.locked_until,null);
 assert.equal((await f.login()).status,200);assert.equal(f.db.native.prepare('SELECT * FROM auth_failures WHERE username=?').get('alice'),undefined);
 for(let i=0;i<5;i++)assert.equal((await f.login('alice','wrong-password')).status,401);
 state=f.db.native.prepare('SELECT * FROM auth_failures WHERE username=?').get('alice');assert.equal(state.failure_count,5);assert.equal(state.locked_until,f.now+30*60000);
 const lockUntil=state.locked_until;assert.equal((await f.login()).status,401);
 f.now+=15*60000;assert.equal((await f.login('alice','wrong-password')).status,401);
 state=f.db.native.prepare('SELECT * FROM auth_failures WHERE username=?').get('alice');assert.equal(state.failure_count,5);assert.equal(state.locked_until,lockUntil);
 assert.equal(f.db.native.prepare('SELECT count(*) AS n FROM audit_grudges').get().n,1);
 f.now=lockUntil;assert.equal((await f.login()).status,200);
 assert.equal(f.db.native.prepare('SELECT * FROM auth_failures WHERE username=?').get('alice'),undefined);
});

test('concurrent fourth and fifth failures atomically lock once and do not spam audits',async t=>{
 const f=fixture(t);await f.register();
 for(let i=0;i<3;i++)assert.equal((await f.login('alice','wrong-password')).status,401);
 const results=await Promise.all([f.login('alice','wrong-password'),f.login('alice','wrong-password')]);
 assert.deepEqual(results.map(r=>r.status),[401,401]);
 const state=f.db.native.prepare('SELECT * FROM auth_failures WHERE username=?').get('alice');assert.equal(state.failure_count,5);assert.equal(state.locked_until,f.now+30*60000);
 await Promise.all([f.login('alice','wrong-password'),f.login('alice','wrong-password')]);
 const audits=f.db.native.prepare('SELECT * FROM audit_grudges').all();assert.equal(audits.length,1);assert.equal(audits[0].severity,1);assert.equal(audits[0].kind,'five_failed_logins');
 assert.ok(!JSON.stringify(audits).includes(PASSWORD));assert.ok(!JSON.stringify(audits).includes('wrong-password'));
});

test('first incorrect password after lock expiry starts a fresh sequence at one',async t=>{
 const f=fixture(t);await f.register();for(let i=0;i<5;i++)await f.login('alice','wrong-password');
 f.now+=30*60000;assert.equal((await f.login('alice','wrong-password')).status,401);
 const state=f.db.native.prepare('SELECT * FROM auth_failures WHERE username=?').get('alice');assert.equal(state.failure_count,1);assert.equal(state.locked_until,null);
 for(let i=0;i<4;i++)await f.login('alice','wrong-password');
 assert.equal(f.db.native.prepare('SELECT count(*) AS n FROM audit_grudges').get().n,2);
});

test('standalone ignores forged platform headers and cookie names; production session cookie is protected and revocable',async t=>{
 const f=fixture(t);await f.register();
 const forged=await f.call('/api/session','GET',undefined,{'oai-authenticated-user-id':'victim','x-user-id':'victim',cookie:'grudge_session='+'a'.repeat(64)});
 assert.equal(forged.body.user,null);
 const result=await f.login();assert.equal(result.status,200);
 for(const attr of ['HttpOnly','SameSite=Strict','Secure','Path=/'])assert.ok(result.cookie.includes(attr));
 const rawToken=f.cookie.split('=')[1],session=f.db.native.prepare('SELECT * FROM sessions').get();assert.notEqual(session.token_hash,rawToken);assert.ok(!JSON.stringify(session).includes(rawToken));
 const member=f.db.native.prepare('SELECT * FROM members WHERE username=?').get('alice');assert.ok(member.password_hash.startsWith('scrypt$'));assert.ok(!member.password_hash.includes(PASSWORD));
 assert.equal((await f.call('/api/notebook')).status,200);
 const before=f.cookie;assert.equal((await f.call('/api/auth/logout','POST',{})).status,200);
 f.cookie=before;assert.equal((await f.call('/api/session')).body.user,null);
});

test('unknown and wrong-password accounts get same generic login response; duplicate signup does not overwrite account',async t=>{
 const f=fixture(t);await f.register();const existing=await f.login('alice','wrong-password'),absent=await f.login('not-existing','wrong-password');
 assert.equal(existing.status,absent.status);assert.deepEqual(existing.body,absent.body);
 const original=f.db.native.prepare('SELECT password_hash FROM members WHERE username=?').get('alice').password_hash;
 assert.equal((await f.register()).status,200);
 assert.equal(f.db.native.prepare('SELECT password_hash FROM members WHERE username=?').get('alice').password_hash,original);
});

test('a stale tab cannot log out the newly authenticated account',async t=>{
 const f=fixture(t);await f.register();await f.login();const alice=f.user;
 await f.register('bobby');await f.login('bobby');const bob=f.user;
 assert.equal((await f.call('/api/auth/logout','POST',{}, {'x-grudge-owner':alice.id})).status,409);
 assert.equal((await f.call('/api/session')).body.user.id,bob.id);
 assert.equal((await f.call('/api/auth/logout','POST',{}, {'x-grudge-owner':null})).status,409);
 assert.equal((await f.call('/api/auth/logout','POST',{})).status,200);
 assert.equal((await f.call('/api/session')).body.user,null);
});

test('challenge rate limit survives auth adapter recreation',async t=>{
 const f=fixture(t);for(let i=0;i<30;i++)assert.equal((await f.call('/api/auth/challenge')).status,200);
 f.auth=createAuth(f.db);assert.equal((await f.call('/api/auth/challenge')).status,429);
});

test('reserved system principal cannot be befriended or log in and has no seeded notebook',async t=>{
 const f=fixture(t);await f.register();for(let i=0;i<5;i++)await f.login('alice','wrong-password');
 const system=f.db.native.prepare('SELECT * FROM members WHERE is_system=1').get();assert.ok(system);assert.equal(system.username,null);assert.equal(system.password_hash,null);
 assert.equal(f.db.native.prepare('SELECT * FROM notebooks WHERE user_id=?').get(system.id),undefined);
 await f.register('bobby');await f.login('bobby');
 assert.equal((await f.call('/api/friends/requests','POST',{friendCode:system.friend_code})).status,200);
 assert.deepEqual((await f.call('/api/friends')).body,{friends:[],incoming:[],outgoing:[]});
});
