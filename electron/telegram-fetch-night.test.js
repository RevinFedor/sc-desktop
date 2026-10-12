'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const Database = require('better-sqlite3')
const { createTelegramFetchControl } = require('./telegram-fetch-control')
const { validateTelegramFetchPolicy, checkTelegramMediaStorage, telegramMediaCandidates } = require('./telegram-fetch-policy')
const { createTelegramRagApi } = require('./telegram-rag-api')

const SCHEMA = `CREATE TABLE jobs(id INTEGER PRIMARY KEY, type TEXT, source_id INTEGER, status TEXT,
  items_done INTEGER, items_total INTEGER, parameters_json TEXT, error TEXT, started_at INTEGER, finished_at INTEGER);
CREATE TABLE items(id INTEGER PRIMARY KEY,source_id INTEGER,external_id TEXT,type TEXT,duration_seconds REAL,
  transcribe_status TEXT,transcribe_engine TEXT,transcript_path TEXT,raw_meta_json TEXT);`
function adapter(sql) {
  return { getDb: () => sql, getSource: id => id === 48 ? { id, platform: 'telegram' } : id === 50 ? { id, platform: 'youtube' } : null,
    recordJob(j) { return Number(sql.prepare(`INSERT INTO jobs(type,source_id,status,items_done,items_total,parameters_json,started_at)
      VALUES(?,?,?,?,?,?,?)`).run(j.type,j.source_id,j.status,j.items_done,j.items_total,JSON.stringify(j.params),j.started_at).lastInsertRowid) },
    updateJob(id, patch) {
      const fields = Object.keys(patch).map(key => (key === 'params' ? 'parameters_json' : key) + '=?')
      sql.prepare('UPDATE jobs SET ' + fields.join(',') + ' WHERE id=?').run(...Object.entries(patch).map(([key,value]) => key === 'params' ? JSON.stringify(value) : value),id)
    } }
}
function fixture(t, { startError = null, wrongReservation = false } = {}) {
  const sql = new Database(':memory:'); sql.exec(SCHEMA); t.after(() => sql.close())
  const database = adapter(sql), live = new Map(), starts = [], cancels = []
  let serial = 10
  const runner = {
    startTelegramFetch(params) {
      starts.push(params)
      assert.ok(!params.request_id || sql.prepare('SELECT id FROM jobs WHERE id=?').get(params._reserved_job_row_id), 'reservation is durable before runner entry')
      if (startError) throw startError
      const id = ++serial
      live.set(id,{id,type:'tg_fetch',status:'running',items_done:0,params: wrongReservation ? {...params,_reserved_job_row_id:999} : params})
      return id
    },
    getJobDetail: id => live.get(id), listJobs: () => [...live.values()],
    cancelJob(id, options) { cancels.push({id,options}); const job = [...live.values()].find(j => j.params._reserved_job_row_id === id)
      if (!job) return false; job.status = 'cancelling'; database.updateJob(id,{status:'cancelling'}); return true },
    telegramFetchCapabilities: () => ({ engines: {soniox:true,assemblyai:false,gemini:false}, secrets_exposed:false }),
  }
  const control = createTelegramFetchControl({ database: () => database, jobRunner: runner })
  const api = createTelegramRagApi({database:()=>database,jobRunner:runner,
    indexJob:{subscribe:()=>()=>{},listActiveSnapshots:()=>[]},
    readBody: async req => req.body, sendJson:(res,status,body)=>Object.assign(res,{status,body})})
  t.after(()=>api.close())
  const call = async (method,url,body,headers={}) => {
    const res={};await api.handle({method,headers,body},res,new URL(url,'http://127.0.0.1:53127'));return res
  }
  const finish = (receipt,status='done') => {
    const job=[...live.values()].find(j=>j.params._reserved_job_row_id===receipt.db_job_id)
    if(job)job.status=status
    database.updateJob(receipt.db_job_id,{status,finished_at:123})
  }
  return { sql,database,runner,control,call,live,starts,cancels,finish }
}
const full = request_id => ({request_id,target:'-100123',session:'fixture',mode:'all',full_history:true,
  process_voice:true,voice_types:['voice','audio'],voice_max_duration_sec:1200,reuse_transcripts:true})

test('same key after lost response/controller recreation returns original, changed payload refuses and session stays unchanged', t => {
  const h=fixture(t), input=full('night-original'); const original=h.control.start(input)
  assert.equal(h.starts[0].session,'fixture');assert.equal(h.starts[0]._tg_session_override,undefined)
  const recreated=createTelegramFetchControl({database:()=>h.database,jobRunner:h.runner})
  assert.equal(recreated.start(input).db_job_id,original.db_job_id)
  assert.equal(recreated.status(input.request_id).job.id,original.desktop_job_id)
  assert.equal(h.starts.length,1)
  assert.throws(()=>recreated.start({...input,voice_max_duration_sec:1201}),{code:'FETCH_REQUEST_PAYLOAD_MISMATCH'})
  h.finish(original)
  assert.equal(recreated.status(input.request_id).completion_is_persisted,true)
})

test('reservation and live id binding prevent borrowing another request; unqualified RAM collision cannot redirect cancel',t=>{
  const h=fixture(t);const a=h.control.start(full('identity'))
  h.live.set(a.db_job_id,{id:a.db_job_id,type:'tg_fetch',status:'running',params:{request_id:'unrelated',_reserved_job_row_id:999}})
  const fresh=createTelegramFetchControl({database:()=>h.database,jobRunner:h.runner})
  assert.equal(fresh.status('identity').job.id,a.desktop_job_id)
  const cancelled=fresh.cancel('identity')
  assert.equal(cancelled.cancel_requested,true)
  assert.deepEqual(h.cancels,[{id:a.db_job_id,options:{identity:'db',type:'tg_fetch'}}])
  assert.equal(cancelled.can_resume,false)
  h.finish(a,'cancelled')
  assert.equal(fresh.status('identity').can_resume,true)
})

test('unknown post-launch exception remains reserved and non-resumable; explicit pre-spawn refusal can resume',t=>{
  const h=fixture(t,{startError:new Error('lost acknowledgement after possible spawn')})
  assert.throws(()=>h.control.start(full('unknown')),{code:'FETCH_START_OUTCOME_UNKNOWN',job_id:'fetch:unknown',accepted:true})
  const state=h.control.status('unknown')
  assert.equal(state.persisted_status,'running');assert.equal(state.launch_outcome,'unknown');assert.equal(state.can_resume,false)
  assert.equal(h.control.start(full('unknown')).idempotent,true);assert.equal(h.starts.length,1)
  assert.throws(()=>h.control.resume('unknown','unknown-retry'),{code:'FETCH_RESUME_NOT_TERMINAL'})
  const refused=fixture(t,{startError:Object.assign(new Error('source busy'),{code:'FETCH_SOURCE_BUSY',pre_spawn:true})})
  assert.throws(()=>refused.control.start(full('refused')),{code:'FETCH_SOURCE_BUSY'})
  assert.equal(refused.control.status('refused').persisted_status,'error')
  assert.equal(refused.control.status('refused').can_resume,true)
})

test('wrong reserved row acknowledgement is unknown and cannot accidentally create a second run',t=>{
  const h=fixture(t,{wrongReservation:true})
  assert.throws(()=>h.control.start(full('wrong-binding')),{code:'FETCH_START_OUTCOME_UNKNOWN'})
  assert.equal(h.control.status('wrong-binding').can_resume,false)
  assert.equal(h.control.start(full('wrong-binding')).job_id,'fetch:wrong-binding')
  assert.equal(h.starts.length,1)
})

test('generic restart terminalization cannot turn an unknown post-spawn launch into safe resume/completion', t => {
  const h = fixture(t, { startError: new Error('possible spawn, no acknowledgement') })
  assert.throws(() => h.control.start(full('restart-unknown')), { code: 'FETCH_START_OUTCOME_UNKNOWN' })
  const row = h.control.status('restart-unknown').db_job_id
  for (const status of ['interrupted', 'error', 'done']) {
    h.database.updateJob(row, { status, finished_at: 321 })
    const out = h.control.status('restart-unknown')
    assert.equal(out.launch_outcome, 'unknown')
    assert.equal(out.can_resume, false)
    assert.equal(out.completion_is_persisted, false)
    assert.equal(out.recovery_reason, 'fetch_launch_outcome_unknown')
    assert.throws(() => h.control.resume('restart-unknown', 'not-a-recovery'), { code: 'FETCH_RESUME_NOT_TERMINAL' })
    assert.equal(h.control.start(full('restart-unknown')).db_job_id, row)
  }
  assert.equal(h.starts.length, 1)
})

test('resume key replay is stable, original immutable scope survives runtime report mutation, competing resume is rejected',t=>{
  const h=fixture(t);const a=h.control.start({...full('resume-base'),reuse_transcripts:false})
  assert.throws(()=>h.control.resume('resume-base','resume-one'),{code:'FETCH_RESUME_NOT_TERMINAL'})
  h.finish(a,'cancelled')
  const original=JSON.parse(h.sql.prepare('SELECT parameters_json FROM jobs WHERE id=?').get(a.db_job_id).parameters_json)
  h.database.updateJob(a.db_job_id,{params:{...original,limit:1,_fetch_report:{remote_eof:false},_type_breakdown:{voice:10}}})
  const b=h.control.resume('resume-base','resume-one')
  assert.equal(b.job.params.limit,undefined);assert.equal(b.job.params._fetch_report,undefined)
  assert.equal(b.job.params.reuse_transcripts,true);assert.equal(b.job.params.redo_processed,false)
  assert.equal(b.job.params._fetch_history_request_id,'resume-base')
  assert.equal(h.control.resume('resume-base','resume-one').db_job_id,b.db_job_id)
  assert.throws(()=>h.control.resume('resume-base','resume-two'),{code:'FETCH_RESUME_ALREADY_ACTIVE'})
  assert.throws(()=>h.control.resume('resume-base','resume-base'),{code:'INVALID_FETCH_RESUME_ID'})
  assert.throws(()=>h.control.resume('resume-base',''),{code:'INVALID_FETCH_REQUEST_ID'})
  h.finish(b)
  assert.equal(h.control.resume('resume-base','resume-one').completion_is_persisted,true)
  assert.equal(h.starts.length,2)
})

test('HTTP durable flow, legacy profile alias, capabilities, origin guard and invalid fields precede any spawn',async t=>{
  const h=fixture(t);const initial=await h.call('POST','/telegram-rag/fetch/start',{params:full('http-request')})
  assert.equal(initial.body.job_id,'fetch:http-request');assert.equal(initial.body.completion_is_persisted,false)
  assert.equal((await h.call('GET','/telegram-rag/fetch/status?request_id=http-request')).body.db_job_id,initial.body.db_job_id)
  assert.equal((await h.call('POST','/telegram-rag/fetch/cancel',{request_id:'http-request'})).body.cancel_requested,true)
  assert.equal((await h.call('POST','/telegram-rag/fetch/resume',{request_id:'http-request',resume_id:'http-resume'})).body.code,'FETCH_RESUME_NOT_TERMINAL')
  h.finish(initial.body,'cancelled')
  assert.equal((await h.call('POST','/telegram-rag/fetch/resume',{request_id:'http-request',resume_id:'http-resume'})).body.job_id,'fetch:http-resume')
  const count=h.starts.length
  for(const change of [{request_id:''},{full_history:'true'},{voice_types:['photo']},{voice_max_duration_sec:0},
    {media_cache_dir:'/'},{media_min_free_bytes:0},{limit:1},{message_ids:[1]},{_reserved_job_row_id:99},{_fetch_request_hash:'spoof'},
    {_runtime_source:{id:50}},{_fetch_report:{remote_eof:true}},{_fetch_history_request_id:'spoof'},{_error_code:'spoof'}]){
    assert.equal((await h.call('POST','/telegram-rag/fetch/start',{params:{...full('invalid'),...change}})).status,400)
  }
  assert.equal(h.starts.length,count)
  assert.equal((await h.call('GET','/telegram-rag/fetch/status?request_id=http-request',null,{origin:'https://untrusted.example'})).status,403)
  assert.deepEqual((await h.call('GET','/telegram-rag/fetch/capabilities')).body.engines,{soniox:true,assemblyai:false,gemini:false})
  const legacy=await h.call('POST','/telegram-rag/fetch/start',{params:{target:'@fixture',mode:'last_n',profile:'profile-fixture'}})
  assert.equal(legacy.status,200);assert.equal(h.starts.at(-1).session,'profile-fixture');assert.equal(h.starts.at(-1).profile,undefined)
})

test('HTTP unknown outcome retains original request identity rather than an accepted receipt claiming completion',async t=>{
  const h=fixture(t,{startError:new Error('unknown ack')})
  const out=await h.call('POST','/telegram-rag/fetch/start',{params:full('http-unknown')})
  assert.equal(out.status,400);assert.equal(out.body.accepted,true);assert.equal(out.body.job_id,'fetch:http-unknown')
  assert.equal(out.body.code,'FETCH_START_OUTCOME_UNKNOWN')
  assert.equal((await h.call('GET','/telegram-rag/fetch/status?request_id=http-unknown')).body.can_resume,false)
})

test('marked expected peer/account IDs are strict and participate in durable payload identity',t=>{
  const h=fixture(t),input={...full('bound-account'),expected_account_id:1033012338,expected_peer_id:-1002369738868}
  const started=h.control.start(input)
  assert.equal(started.job.params.expected_peer_id,-1002369738868)
  assert.equal(started.job.params.expected_account_id,1033012338)
  assert.throws(()=>h.control.start({...input,expected_peer_id:-1002479041528}),{code:'FETCH_REQUEST_PAYLOAD_MISMATCH'})
  for(const field of [{expected_account_id:0},{expected_account_id:-1},{expected_account_id:'1033012338'},
    {expected_peer_id:0},{expected_peer_id:'-1002369738868'},{expected_peer_id:1.5},{expected_peer_id:Infinity}]){
    assert.throws(()=>validateTelegramFetchPolicy({...full('bad-account'),...field}))
  }
  assert.equal(h.starts.length,1)
})

test('profile photo opt-out is explicit boolean, preserves default and is part of a durable request payload',t=>{
  const h=fixture(t),input={...full('no-avatar'),download_profile_photo:false}
  const out=h.control.start(input)
  assert.equal(out.job.params.download_profile_photo,false)
  assert.equal(validateTelegramFetchPolicy({target:'legacy',mode:'all'}).download_profile_photo,undefined)
  assert.throws(()=>validateTelegramFetchPolicy({...input,download_profile_photo:'false'}))
  assert.throws(()=>h.control.start({...input,download_profile_photo:true}),{code:'FETCH_REQUEST_PAYLOAD_MISMATCH'})
})

test('confirmed terminal ASR unknown-delivery errors remain non-resumable and cannot reserve a replacement',async t=>{
  const h=fixture(t),a=h.control.start(full('asr-unknown'))
  h.finish(a,'error')
  const params=JSON.parse(h.sql.prepare('SELECT parameters_json FROM jobs WHERE id=?').get(a.db_job_id).parameters_json)
  h.database.updateJob(a.db_job_id,{params:{...params,_error_code:'media_delivery_unknown'}})
  const state=h.control.status('asr-unknown')
  assert.equal(state.can_resume,false);assert.equal(state.recovery_reason,'media_delivery_unknown')
  const out=await h.call('POST','/telegram-rag/fetch/resume',{request_id:'asr-unknown',resume_id:'do-not-spawn'})
  assert.equal(out.body.code,'FETCH_RESUME_MEDIA_DELIVERY_UNKNOWN')
  assert.equal(out.body.recovery_reason,'media_delivery_unknown')
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,1);assert.equal(h.starts.length,1)
})

test('active API separates all main job types and an unbounded durable ledger including orphan reservations',async t=>{
  const h=fixture(t);const started=h.control.start(full('active'))
  const list=h.runner.listJobs
  h.runner.listJobs=()=>[...list(),{id:77,type:'yt_channel_fetch',status:'running'},{id:78,type:'ig_profile_fetch',status:'done'}]
  h.sql.prepare(`INSERT INTO jobs(id,type,source_id,status,items_done,parameters_json)VALUES(10000,'new_future_job_type',NULL,'running',0,'{}')`).run()
  const out=await h.call('GET','/telegram-rag/jobs/active')
  assert.equal(out.body.enumeration_complete,true);assert.equal(out.body.durable_enumeration_complete,true)
  assert.deepEqual(out.body.jobs.map(j=>j.type),['tg_fetch','yt_channel_fetch'])
  assert.equal(out.body.durable_scope,'all_persisted_job_types_unbounded')
  assert.deepEqual(out.body.durable_jobs.map(j=>j.id),[started.db_job_id,10000])
  assert.equal(out.body.durable_active_count,2)
})

test('local candidate cursor includes skipped rows, allows1200 but skips1201/unknown/video, reports existing transcription without reads/downloads',async t=>{
  const h=fixture(t), insert=h.sql.prepare('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?)')
  for(const row of [[1,48,'1','voice',1200,'none',null,null,null],[2,48,'2','audio',1201,'none',null,null,null],
    [3,48,'3','voice',null,'none',null,null,'{"media":[{"duration_seconds":30}]}'],
    [4,48,'4','voice',null,'none',null,null,'bad-json'],[5,48,'5','video',1,'none',null,null,null],
    [6,48,'6','audio',12,'done','soniox','/unread/fixture.txt',null],[7,49,'7','voice',12,'none',null,null,null]])insert.run(...row)
  const first=await h.call('GET','/telegram-rag/fetch/candidates?source_id=48&limit=2')
  assert.equal(first.body.complete,false);assert.equal(first.body.next_item_id,2)
  assert.deepEqual(first.body.candidates.map(r=>r.item_id),[1]);assert.equal(first.body.counts.skipped_over_duration,1)
  const second=await h.call('GET','/telegram-rag/fetch/candidates?source_id=48&after_item_id=2&limit=3')
  assert.equal(second.body.complete,true);assert.equal(second.body.next_item_id,null)
  assert.deepEqual(second.body.rows.map(r=>r.item_id),[3,4,6])
  assert.equal(second.body.counts.skipped_unknown_duration,1);assert.equal(second.body.counts.already_transcribed,1)
  assert.equal(second.body.rows[0].duration_source,'media_metadata')
  assert.equal(second.body.rows[2].transcript_saved,true)
  insert.run(8,48,'8','voice',1200,'none',null,null,'{"media":[{"duration_seconds":1201}]}')
  const conflict=telegramMediaCandidates(h.database,{sourceId:48,afterItemId:7})
  assert.equal(conflict.rows[0].duration_seconds,1201)
  assert.equal(conflict.rows[0].eligible,false)
  for(const query of ['source_id=50','source_id=48&limit=1001','source_id=48&after_item_id=-1',
    'source_id=48&voice_types=video','source_id=48&max_duration_sec=0'])assert.equal((await h.call('GET','/telegram-rag/fetch/candidates?'+query)).status,400)
  assert.equal(h.starts.length,0)
})

test('storage validation checks low space, invalid threshold and vanished external mounts without creating mountpoints',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sc-night-media-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  assert.equal(checkTelegramMediaStorage(path.join(root,'cache'),1048576).writable,true)
  assert.throws(()=>checkTelegramMediaStorage(path.join(root,'cache'),Number.MAX_SAFE_INTEGER),{code:'MEDIA_STORAGE_UNAVAILABLE'})
  assert.throws(()=>checkTelegramMediaStorage(path.join(root,'never-created'),0))
  assert.equal(fs.existsSync(path.join(root,'never-created')),false)
  const mkdir=[];let checks=0
  const fake={existsSync:()=>true,statSync:p=>{
    if(p==='/Volumes')return{dev:1,ino:1};if(++checks>1)throw Object.assign(new Error('unmounted'),{code:'ENOENT'});return{dev:2,ino:2}},
    mkdirSync:p=>mkdir.push(p),accessSync(){},statfsSync:()=>({bavail:9999999,bsize:4096}),realpathSync:p=>p}
  assert.throws(()=>checkTelegramMediaStorage('/Volumes/night-fixture/owned/cache',1048576,fake),{code:'MEDIA_STORAGE_UNAVAILABLE'})
  assert.deepEqual(mkdir,[])
  const redirect={existsSync:()=>true,statSync:p=>({dev:p==='/Volumes'||p.includes('owned')?1:2,ino:2}),
    mkdirSync(){},accessSync(){},statfsSync:()=>({bavail:9999999,bsize:4096}),realpathSync:p=>p.includes('owned')?'/tmp/redirected':p}
  assert.throws(()=>checkTelegramMediaStorage('/Volumes/night-fixture/owned/cache',1048576,redirect),{code:'MEDIA_STORAGE_UNAVAILABLE'})
})

test('full-history masks all narrowing aliases while legacy non-full flows remain untouched',()=>{
  const old={target:'fixture',mode:'last_n',limit:10,process_voice:true}
  assert.deepEqual(validateTelegramFetchPolicy(old),old)
  for(const key of ['limit','sinceMessageId','date','date_to','url','message_ids','min_id','max_id','offset_id','_media_only_msg_ids','_comments_only_post_ids','skipDupes','skip_covered']){
    assert.throws(()=>validateTelegramFetchPolicy({...full('scope'),[key]:key.startsWith('skip')?true:1}),{code:'INVALID_FULL_HISTORY_SCOPE'})
  }
})

test('two native WAL connections concurrently reserve one request before the fake external launch',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sc-night-reserve-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const file=path.join(root,'jobs.db'),sql=new Database(file);sql.exec(SCHEMA);sql.pragma('journal_mode=WAL')
  const shared=new SharedArrayBuffer(8),counts=new Int32Array(shared)
  const code=`const{parentPort,workerData}=require('node:worker_threads');const Database=require(workerData.sqlite);const{createTelegramFetchControl}=require(workerData.control);
    const sql=new Database(workerData.file);sql.pragma('busy_timeout=5000');const shared=new Int32Array(workerData.shared);const rows=new Map();
    const db={getDb:()=>sql,recordJob:j=>Number(sql.prepare('INSERT INTO jobs(type,source_id,status,items_done,items_total,parameters_json,started_at)VALUES(?,?,?,?,?,?,?)').run(j.type,j.source_id,j.status,j.items_done,j.items_total,JSON.stringify(j.params),j.started_at).lastInsertRowid),updateJob(){}};
    const runner={startTelegramFetch:p=>{Atomics.add(shared,1,1);rows.set(1,{id:1,type:'tg_fetch',status:'running',params:p});return 1},getJobDetail:id=>rows.get(id)};
    parentPort.postMessage({ready:true});Atomics.wait(shared,0,0);try{const r=createTelegramFetchControl({database:()=>db,jobRunner:runner}).start(workerData.input);parentPort.postMessage({result:r})}catch(e){parentPort.postMessage({error:e.message})}sql.close();`
  const workers=[0,1].map(()=>new Worker(code,{eval:true,workerData:{file,shared,input:full('two-writers'),sqlite:require.resolve('better-sqlite3'),control:require.resolve('./telegram-fetch-control')}}))
  const ready=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);const listen=m=>{if(m.ready){w.off('message',listen);resolve()}};w.on('message',listen)}))
  const results=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.on('message',m=>{if(m.result||m.error)resolve(m)})}))
  await Promise.all(ready);Atomics.store(counts,0,1);Atomics.notify(counts,0,2)
  const out=await Promise.all(results)
  assert.ok(out.every(r=>r.result),JSON.stringify(out));assert.equal(out[0].result.db_job_id,out[1].result.db_job_id)
  assert.equal(Atomics.load(counts,1),1);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,1)
  sql.close();await Promise.all(workers.map(w=>w.terminate()))
})
