import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

const ignored = new Set(['.git','node_modules','dist','.sites-runtime']);
async function walk(dir='.') {
  const result=[];
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    if(ignored.has(entry.name)) continue;
    const file=path.join(dir,entry.name);
    if(entry.isDirectory()) result.push(...await walk(file));
    else result.push(file);
  }
  return result;
}
let files;
try { files=execFileSync('git',['ls-files','-z'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).split('\0').filter(Boolean); }
catch { files=await walk(); }
if(!files.length) files=await walk();
const forbidden=/(^|\/)(?:node_modules|dist|\.sites-runtime|\.openai|artifacts|backups|exports|data|qa)(?:\/|$)|\.(?:sqlite(?:-wal|-shm)?|db|log|zip|tar|gz|pdf|docx)$/i;
const secrets=/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|appgprj_[a-z0-9]{20,}|libfile_[a-z0-9]{20,})/;
for(const file of files) {
  assert.ok(!forbidden.test(file),`Private/generated file in release: ${file}`);
  assert.ok(!/(^|\/)\.env(?:\.|$)/.test(file)||file==='.env.example',`Environment file in release: ${file}`);
  const text=await readFile(file,'utf8');
  assert.ok(!secrets.test(text),`Potential secret or private identifier: ${file}`);
}
const license=await readFile('LICENSE','utf8');
assert.match(license,/^WH Covenant Public License\nVersion 1\.0\n/);
assert.equal(await readFile('public/LICENSE.txt','utf8'),license,'Public license must remain exact');
assert.equal(await readFile('dist/LICENSE','utf8'),license,'Build license must remain exact');
assert.ok(!files.includes('.git/config'),'Do not include private Git configuration');
console.log(`PASS: checked ${files.length} release files, generated-data exclusions, identifier patterns and complete license copies.`);
