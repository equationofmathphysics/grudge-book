export const stmt=(db,sql,...args)=>db.prepare(sql).bind(...args);
export const one=(db,sql,...args)=>stmt(db,sql,...args).first();
export const all=async(db,sql,...args)=>(await stmt(db,sql,...args).all()).results;
export const run=(db,sql,...args)=>stmt(db,sql,...args).run();
export const randomHex=(bytes=16)=>Array.from(crypto.getRandomValues(new Uint8Array(bytes)),b=>b.toString(16).padStart(2,'0')).join('');
export async function hash(text){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');}
export const publicUser=row=>row?{id:row.id,displayName:row.display_name,friendCode:row.friend_code}:null;
