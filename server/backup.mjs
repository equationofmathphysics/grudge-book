import { DatabaseSync,backup } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync,openSync,closeSync } from 'node:fs';
const destination=process.argv[2];
if(!destination){console.error('Usage: DATABASE_PATH=./data/grudge.sqlite node server/backup.mjs /secure/path/backup.sqlite');process.exit(1);}
const source=resolve(process.env.DATABASE_PATH??'./data/grudge.sqlite'),target=resolve(destination);
if(source===target||existsSync(target))throw Error('Choose a new backup destination; existing files are never overwritten.');
closeSync(openSync(target,'wx',0o600));
const db=new DatabaseSync(source,{readOnly:true});
try{await backup(db,target);console.log('Consistent SQLite backup written. It contains private notebooks and credential/session hashes; protect access.');}finally{db.close();}
