import {build} from 'esbuild';
import {readdir,readFile,writeFile,mkdir,cp,rm} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
const files=await readdir(path.join(root,'public'));
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};
const assets={};
for(const file of files){if(!types[path.extname(file)])continue;assets['/'+file]={body:await readFile(path.join(root,'public',file),'utf8'),type:types[path.extname(file)]};}
if(!assets['/index.html'])throw Error('Missing frontend public/index.html');
await mkdir('.sites-runtime',{recursive:true});
await writeFile('.sites-runtime/assets.mjs','export default '+JSON.stringify(assets)+';\n');
await rm('dist',{recursive:true,force:true});
await mkdir('dist/server',{recursive:true});

await build({entryPoints:['worker/index.mjs'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'eof'});
await cp('LICENSE','dist/LICENSE');
await cp('THIRD_PARTY_NOTICES.md','dist/THIRD_PARTY_NOTICES.md');
await cp('drizzle','dist/drizzle',{recursive:true});
console.log('Built generic Worker with embedded frontend, license, and D1 migrations. Hosting configuration must be supplied separately.');
