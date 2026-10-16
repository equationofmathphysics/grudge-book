import { all,one,run,stmt } from './db.mjs';
export const WEEK=7*86400000,DELAY=48*3600000;
export const weekStart=now=>Math.floor((now-4*86400000)/WEEK)*WEEK+4*86400000;
export function countContributions(notebook){
 const counts=Object.create(null);
 for(const e of notebook.entries)if(e.targetUserId&&e.shareInAggregate&&!e.example&&!e.personalDemo&&!e.deletedAt)counts[e.targetUserId]=(counts[e.targetUserId]??0)+1;
 return counts;
}
export function hasWithdrawal(before,after){
 const live=new Map(after.entries.filter(e=>e.targetUserId&&e.shareInAggregate&&!e.example&&!e.personalDemo&&!e.deletedAt).map(e=>[e.id,e.targetUserId]));
 return before.entries.some(e=>e.targetUserId&&e.shareInAggregate&&!e.example&&!e.personalDemo&&!e.deletedAt&&live.get(e.id)!==e.targetUserId);
}
export const epochStatement=db=>stmt(db,'INSERT INTO privacy_state(id,epoch) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET epoch=epoch+1');
export function revokeStatement(db,user,week,guardSql='',guardArgs=[]){return stmt(db,`INSERT INTO aggregate_revocations(user_id,week) SELECT ?,? ${guardSql} ON CONFLICT(user_id,week) DO NOTHING`,user,week,...guardArgs);}
export function invalidateStatement(db,users,week,guardSql='',guardArgs=[]){
 const marks=users.map(()=>'?').join(',');
 return stmt(db,`UPDATE aggregate_snapshots SET invalidated=1 WHERE week>=? AND (user_id IN (${marks}) OR EXISTS (SELECT 1 FROM json_each(aggregate_snapshots.cohort) WHERE value IN (${marks}))) ${guardSql}`,week,...users,...users,...guardArgs);
}
export async function mutualIds(db,id,cutoff=Infinity){
 const rows=await all(db,"SELECT low_id,high_id FROM friendships WHERE status='accepted' AND (low_id=? OR high_id=?) AND accepted_at<=?",id,id,Number.isFinite(cutoff)?cutoff:Number.MAX_SAFE_INTEGER);
 return new Set(rows.map(r=>r.low_id===id?r.high_id:r.low_id));
}
async function historicalCounts(db,id,cutoff){const row=await one(db,'SELECT counts FROM aggregate_revisions WHERE user_id=? AND published_at<=? ORDER BY revision DESC LIMIT 1',id,cutoff);return row?JSON.parse(row.counts):{};}
const validCount=(counts,mutual)=>Object.entries(counts).reduce((sum,[target,n])=>sum+(mutual.has(target)?n:0),0);
export async function getAggregate(db,userId,now,enabled){
 if(!enabled)return {status:'locked'};
 const week=weekStart(now),cutoff=week-DELAY;
 for(let attempt=0;attempt<3;attempt++){
  let snap=await one(db,'SELECT * FROM aggregate_snapshots WHERE user_id=? AND week=?',userId,week);
  if(snap){if(snap.invalidated||snap.status!=='ready')return {status:'locked'};return {status:'ready',total:snap.total,snapshotAt:new Date(week).toISOString(),nextUpdateAt:new Date(week+WEEK).toISOString()};}
  await run(db,'INSERT INTO privacy_state(id,epoch) VALUES(1,0) ON CONFLICT(id) DO NOTHING');
  const {epoch}=await one(db,'SELECT epoch FROM privacy_state WHERE id=1');
  const friends=await mutualIds(db,userId,cutoff),viewerCounts=await historicalCounts(db,userId,cutoff);
  const revoked=new Set((await all(db,'SELECT user_id FROM aggregate_revocations WHERE week=?',week)).map(r=>r.user_id));
  let cohort=[],total=0,withdrawn=revoked.has(userId);
  if(friends.size>=10&&validCount(viewerCounts,friends)>=5){
   for(const friend of friends)if(revoked.has(friend))withdrawn=true;
   // One bounded set query, rather than two D1 calls for every friend.
   const candidates=await all(db,`WITH viewer_friends AS (
    SELECT CASE WHEN low_id=? THEN high_id ELSE low_id END AS friend_id FROM friendships
    WHERE (low_id=? OR high_id=?) AND status='accepted' AND accepted_at<=?
   ), latest AS (
    SELECT a.user_id,a.counts FROM aggregate_revisions a JOIN viewer_friends v ON v.friend_id=a.user_id
    WHERE a.revision=(SELECT max(b.revision) FROM aggregate_revisions b WHERE b.user_id=a.user_id AND b.published_at<=?)
   ) SELECT l.user_id,coalesce(json_extract(l.counts,?),0) AS target_count,
    sum(CASE WHEN f.status='accepted' AND f.accepted_at<=? THEN cast(j.value AS INTEGER) ELSE 0 END) AS valid_count
   FROM latest l JOIN json_each(l.counts) j LEFT JOIN friendships f
    ON f.low_id=min(l.user_id,j.key) AND f.high_id=max(l.user_id,j.key)
   GROUP BY l.user_id`,userId,userId,userId,cutoff,cutoff,'$."'+userId+'"',cutoff);
   for(const candidate of candidates)if(candidate.valid_count>=5){cohort.push(candidate.user_id);total+=candidate.target_count;}

  }
  const status=cohort.length>=10&&!withdrawn?'ready':'locked';
  // CAS against all contribution/relationship mutations closes the read-build-write race.
  const inserted=await run(db,'INSERT INTO aggregate_snapshots(user_id,week,status,total,cohort,invalidated,created_at) SELECT ?,?,?,?,?,0,? WHERE (SELECT epoch FROM privacy_state WHERE id=1)=? ON CONFLICT(user_id,week) DO NOTHING',userId,week,status,status==='ready'?total:null,JSON.stringify(cohort),now,epoch);
  if(inserted.meta.changes===0)continue;
 }
 return {status:'locked'};
}
