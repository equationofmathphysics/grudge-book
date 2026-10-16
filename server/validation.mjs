export const MAX_BYTES=1024*1024;
const categories=['临时加活','会议结界','甩锅艺术','办公室日常','神秘设备','其他恩怨'];
export const emptyNotebook=()=>({version:1,entries:[],people:[],appliedMigrations:[]});
export class ApiError extends Error { constructor(status,code,message){super(message);this.status=status;this.code=code;} }
export const fail=(status,code,message)=>{throw new ApiError(status,code,message);};
export const invalid=()=>fail(400,'invalid_request','请求内容无效。');
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const str=(v,max,required=false)=>typeof v==='string'&&v.length<=max&&(!required||v.trim().length>0)&&!/[\u0000]/u.test(v);
const stamp=v=>str(v,40,true)&&!Number.isNaN(Date.parse(v));
const optionalBool=(o,k)=>o[k]===undefined||typeof o[k]==='boolean';
export function exactKeys(v,keys){if(!plain(v)||Object.keys(v).some(k=>!keys.includes(k)))invalid();}
export function normalizeNotebook(raw,now,{importing=false}={}){
 if(!plain(raw)||raw.version!==1||!Array.isArray(raw.entries)||raw.entries.length>1000||!Array.isArray(raw.people)||raw.people.length>1000)invalid();
 const ids=new Set(),pids=new Set(),names=new Set();
 const entries=raw.entries.map(e=>{
  if(!plain(e)||!str(e.id,150,true)||ids.has(e.id)||!str(e.target,40,true)||!str(e.title,80,true)||!str(e.details,2000)||!str(e.occurred,16)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(e.occurred)||Number.isNaN(Date.parse(e.occurred))||![1,2,3].includes(e.severity)||!categories.includes(e.category)||!['open','settled','forgiven'].includes(e.status)||!['example','personalDemo','occurredDateOnly','noReconciliation','shareInAggregate'].every(k=>optionalBool(e,k))||(e.createdAt!==undefined&&!stamp(e.createdAt))||(e.updatedAt!==undefined&&!stamp(e.updatedAt))||(e.deletedAt!=null&&!stamp(e.deletedAt))||(e.engravedAt!==undefined&&!stamp(e.engravedAt))||(e.engravingHits!==undefined&&e.engravingHits!==9)||(e.engravingRitualId!==undefined&&!str(e.engravingRitualId,150,true))||(e.targetUserId!=null&&!str(e.targetUserId,100,true)))invalid();
  if(e.noReconciliation===true&&e.status==='forgiven')invalid();
  ids.add(e.id);
  return {id:e.id,target:e.target.trim(),title:e.title.trim(),details:e.details,occurred:e.occurred,severity:e.severity,category:e.category,status:e.status,example:e.example===true,personalDemo:e.personalDemo===true,occurredDateOnly:e.occurredDateOnly===true,noReconciliation:e.noReconciliation===true,createdAt:e.createdAt??new Date(now).toISOString(),updatedAt:e.updatedAt??new Date(now).toISOString(),deletedAt:e.deletedAt??null,targetUserId:importing?null:e.targetUserId??null,shareInAggregate:importing?false:e.shareInAggregate===true,...(e.engravedAt?{engravedAt:e.engravedAt,engravingHits:9,...(e.engravingRitualId?{engravingRitualId:e.engravingRitualId}:{})}:{})};
 });
 const people=raw.people.map(p=>{
  if(!plain(p)||!str(p.id,150,true)||!str(p.name,40,true)||typeof p.nemesis!=='boolean'||(p.createdAt!==undefined&&!stamp(p.createdAt)))invalid();
  const key=personKey(p.name);if(pids.has(p.id)||names.has(key))invalid();pids.add(p.id);names.add(key);
  return {id:p.id,name:p.name.trim(),nemesis:p.nemesis,createdAt:p.createdAt??new Date(now).toISOString()};
 });
 const migrations=raw.appliedMigrations??[];
 if(!Array.isArray(migrations)||migrations.length>100||!migrations.every(x=>str(x,150,true)))invalid();
 const result={version:1,entries,people,appliedMigrations:[...new Set(migrations)]};
 if(new TextEncoder().encode(JSON.stringify(result)).length>MAX_BYTES)fail(413,'notebook_too_large','整本数据不能超过 1 MiB。');
 return result;
}
export const personKey=s=>s.trim().normalize('NFKC').toLowerCase();
export function validateAlias(value){if(!str(value,40))invalid();return value.trim();}
export function validateDisplayName(value,fallback){if(value===undefined)return fallback;if(!str(value,40,true))invalid();return value.trim();}
export function validateCredentials(body,register=false){
 exactKeys(body,register?['username','password','displayName','challengeId','answer']:['username','password']);
 if(typeof body.username!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(body.username)||typeof body.password!=='string'||body.password.length<(register?12:1)||body.password.length>128||new TextEncoder().encode(body.password).length>512)invalid();
 return {username:body.username.toLowerCase(),password:body.password,displayName:validateDisplayName(body.displayName,body.username)};
}
