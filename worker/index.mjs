import {handleApi} from '../server/api.mjs';
import assets from '../.sites-runtime/assets.mjs';
const security={
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com"
};
export default {async fetch(request,env){
 const url=new URL(request.url);
 try{
  if(url.pathname.startsWith('/api/')){
   if(!env.DB)return new Response(JSON.stringify({error:'service_unavailable',message:'在线书库暂未连接，请稍后再试。'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...security}});
   const response=await handleApi(request,{db:env.DB,mode:'sites',aggregateEnabled:true});
   const headers=new Headers(response.headers);for(const[k,v]of Object.entries(security))headers.set(k,v);
   return new Response(response.body,{status:response.status,headers});
  }
  const asset=assets[url.pathname==='/'?'/index.html':url.pathname];
  if(!asset||!['GET','HEAD'].includes(request.method))return new Response('Not found',{status:404,headers:security});
  return new Response(request.method==='HEAD'?null:asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache',...security}});
 }catch(error){
  console.error('request_failure',{path:url.pathname,name:error?.name});
  return new Response(JSON.stringify({error:'internal_error',message:'书库暂时未能完成请求，请稍后再试。'}),{status:500,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...security}});
 }
}};
