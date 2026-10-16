import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync,mkdirSync,chmodSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function openDatabase(filename){
 if(filename!==':memory:')mkdirSync(dirname(resolve(filename)),{recursive:true,mode:0o700});
 const native=new DatabaseSync(filename);if(filename!==':memory:')chmodSync(filename,0o600);native.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
 class Statement{
  constructor(sql,args=[]){this.sql=sql;this.args=args;}
  bind(...args){return new Statement(this.sql,args);}
  async first(){return native.prepare(this.sql).get(...this.args)??null;}
  async all(){return {results:native.prepare(this.sql).all(...this.args)};}
  async run(){const meta=native.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:Number(meta.changes),last_row_id:Number(meta.lastInsertRowid)}};}
 }
 return {native,prepare:sql=>new Statement(sql),async batch(statements){native.exec('BEGIN IMMEDIATE');try{const results=[];for(const s of statements){const r=native.prepare(s.sql).run(...s.args);results.push({success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}});}native.exec('COMMIT');return results;}catch(e){native.exec('ROLLBACK');throw e;}},close(){native.close();}};
}
export function migrateDatabase(db,path=fileURLToPath(new URL('../drizzle/',import.meta.url))){
 db.native.exec('CREATE TABLE IF NOT EXISTS __local_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
 for(const name of readdirSync(path).filter(x=>/^\d+.*\.sql$/.test(x)).sort()){
  if(db.native.prepare('SELECT 1 FROM __local_migrations WHERE name=?').get(name))continue;
  const sql=readFileSync(resolve(path,name),'utf8');
  db.native.exec('BEGIN IMMEDIATE');try{db.native.exec(sql);db.native.prepare('INSERT INTO __local_migrations(name,applied_at) VALUES(?,?)').run(name,Date.now());db.native.exec('COMMIT');}catch(e){db.native.exec('ROLLBACK');throw e;}
 }
}
