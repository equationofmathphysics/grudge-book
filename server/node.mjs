import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { readFile,stat } from 'node:fs/promises';
import { resolve,extname,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase,migrateDatabase } from './sqlite.mjs';
import { createAuth } from './auth-node.mjs';
import { handleApi } from './api.mjs';
const port=Number(process.env.PORT??3000),host=process.env.HOST??'127.0.0.1';
const origin=new URL(process.env.PUBLIC_ORIGIN??`http://localhost:${port}`).origin;
const parsed=new URL(origin),loopback=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);
if(parsed.protocol!=='https:'&&!loopback)throw Error('PUBLIC_ORIGIN must use HTTPS outside localhost');
const secureCookies=parsed.protocol==='https:';
const db=openDatabase(process.env.DATABASE_PATH??'./data/grudge.sqlite');migrateDatabase(db);
const auth=createAuth(db,{secureCookies}),root=resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const mime={'.txt':'text/plain; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webp':'image/webp','.woff2':'font/woff2'};
const staticHeaders={'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
function trustedAddress(req){
 const peer=req.socket.remoteAddress??'unknown',trusted=process.env.TRUSTED_PROXY_IP;
 const reported=req.headers['x-real-ip'];
 return trusted&&peer===trusted&&typeof reported==='string'&&isIP(reported)?reported:peer;
}
const server=createServer(async(req,res)=>{
 try{
  // Build all routing/origin decisions from configured origin, never forwarded headers.
  const url=new URL(req.url,origin);
  if(url.origin!==origin){res.writeHead(400);res.end('Bad request');return;}
  if(url.pathname.startsWith('/api/')){
   let total=0;const chunks=[];
   for await(const c of req){total+=c.length;if(total>1024*1024+16384){res.writeHead(413,{'Cache-Control':'no-store'});res.end('Request too large');return;}chunks.push(c);}
   const method=req.method??'GET';const headers=new Headers();
   for(const [k,v] of Object.entries(req.headers))if(v!==undefined&&!k.toLowerCase().startsWith('oai-')&&!['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','cf-connecting-ip'].includes(k.toLowerCase()))headers.set(k,Array.isArray(v)?v.join(','):v);
   const request=new Request(url,{method,headers,...(!['GET','HEAD'].includes(method)?{body:Buffer.concat(chunks)}:{})});
   const result=await handleApi(request,{db,mode:'standalone',auth,origin,clientAddress:trustedAddress(req),aggregateEnabled:process.env.ENABLE_AGGREGATE!=='false'});
   res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
  let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{res.writeHead(400);res.end();return;}
  if(pathname.includes('\0')||pathname.includes('\\')||pathname.split('/').some(p=>p.startsWith('.'))){res.writeHead(404);res.end();return;}
  const file=resolve(root,pathname==='/'?'index.html':'.'+pathname),type=mime[extname(file)];
  if(!file.startsWith(root+sep)||!type){res.writeHead(404);res.end();return;}
  const info=await stat(file);if(!info.isFile())throw Error('Not a file');
  res.writeHead(200,{'Content-Type':type,...staticHeaders,...(secureCookies?{'Strict-Transport-Security':'max-age=31536000'}:{})});res.end(req.method==='HEAD'?undefined:await readFile(file));
 }catch(e){if(e.code==='ENOENT'){res.writeHead(404);res.end('Not found');}else{console.error('Request failed:',e.name);if(!res.headersSent)res.writeHead(500);res.end('Internal error');}}
});
server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=50;
server.listen(port,host,()=>console.log(`Grudge Book listening on ${host}:${port}; public origin ${origin}; standalone authentication`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
