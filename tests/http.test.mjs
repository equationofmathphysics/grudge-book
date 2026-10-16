import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const port=38471,origin=`http://127.0.0.1:${port}`;
async function start(db){const child=spawn(process.execPath,['server/node.mjs'],{cwd:process.cwd(),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:origin,DATABASE_PATH:db},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',d=>errors+=d);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('HTTP server startup timeout '+errors)),10000);child.stdout.on('data',d=>{if(String(d).includes('Grudge Book listening')){clearTimeout(timer);resolve();}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code+' '+errors));});});return child;}
async function stop(child){if(child.exitCode!==null)return;await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});}
test('real HTTP transport serves app, rejects source/header impersonation, authenticates, persists across restart, logs out',{timeout:30000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'grudge-http-'));let server;
 try{
  const db=path.join(dir,'store.sqlite');server=await start(db);
  let r=await fetch(origin);assert.equal(r.status,200);assert.match(await r.text(),/至高王/);assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);
  r=await fetch(origin+'/LICENSE.txt');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/plain/);assert.equal(await r.text(),await readFile('LICENSE','utf8'));
  for(const p of ['/server/auth-node.mjs','/.env','/.git/config','/data/grudge.sqlite'])assert.equal((await fetch(origin+p)).status,404);
  r=await fetch(origin+'/api/session',{headers:{'oai-authenticated-user-id':'forged-owner','cf-connecting-ip':'1.2.3.4'}});assert.equal((await r.json()).user,null);
  const challenge=await(await fetch(origin+'/api/auth/challenge')).json();
  const nums=challenge.question.match(/\d+/g).map(Number);assert.equal(nums.length,5);const answer=((nums[0]+nums[1])*nums[2]-nums[3])/nums[4];assert.ok(Number.isInteger(answer));
  const base={Origin:origin,'X-Grudge-Request':'1','Content-Type':'application/json'};
  r=await fetch(origin+'/api/auth/register',{method:'POST',headers:base,body:JSON.stringify({username:'http_synthetic',password:'synthetic-test-passphrase',challengeId:challenge.challengeId,answer})});assert.equal(r.status,200,await r.clone().text());
  r=await fetch(origin+'/api/auth/login',{method:'POST',headers:base,body:JSON.stringify({username:'http_synthetic',password:'synthetic-test-passphrase'})});assert.equal(r.status,200);const user=(await r.json()).user;const cookie=r.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
  const auth={...base,Cookie:cookie.split(';')[0],'X-Grudge-Owner':user.id};
  const notebook=await(await fetch(origin+'/api/notebook',{headers:auth})).json();assert.deepEqual(notebook.entries,[]);
  const entry={id:'http-entry',target:'synthetic target',title:'synthetic private record',details:'testing only',occurred:'2026-10-15T12:00',severity:1,category:'其他恩怨',status:'open'};
  r=await fetch(origin+'/api/notebook',{method:'PUT',headers:auth,body:JSON.stringify({expectedRevision:0,notebook:{version:1,entries:[entry],people:[],appliedMigrations:[]}})});assert.equal(r.status,200,await r.clone().text());
  await stop(server);server=await start(db);
  r=await fetch(origin+'/api/notebook',{headers:auth});assert.equal(r.status,200);assert.equal((await r.json()).entries[0].title,entry.title);
  r=await fetch(origin+'/api/auth/logout',{method:'POST',headers:auth,body:'{}'});assert.equal(r.status,200);
  assert.equal((await fetch(origin+'/api/notebook',{headers:auth})).status,401);
 }finally{if(server)await stop(server);await rm(dir,{recursive:true,force:true});}
});
