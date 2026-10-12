'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'asr-recovery-control-'))
process.env.SC_DESKTOP_DIR=tmp;process.env.SC_DESKTOP_DB=path.join(tmp,'library.db')
const db=require('./database'),{createTelegramFetchControl}=require('./telegram-fetch-control')
const live=new Map();let calls=0,probeResult
const runner={startTelegramFetch(params){const job={id:++calls,db_id:params._reserved_job_row_id,type:'tg_fetch',status:'running',params};live.set(job.id,job);live.set('db-'+job.db_id,job);return job.id},
getJobDetail:id=>live.get(id),listJobs:()=>[...live.values()],async runTelegramAsrCheckpointCommand(){return probeResult}}
const control=createTelegramFetchControl({database:()=>db,jobRunner:runner})
test.after(()=>{db.close();fs.rmSync(tmp,{recursive:true,force:true})})
function failed(key){const started=control.start({request_id:key,target:'-100123',mode:'id_list',message_ids:[7,8],process_voice:true,
transcribe_engine:'soniox',session:'fixture',expected_peer_id:-100123,expected_account_id:1033});const job=live.get(started.desktop_job_id)
job.status='error';job.params._error_code='media_delivery_unknown';job.params._media_phase={voice:{current:{msg_id:'7',stage:'uploading'}}}
db.updateJob(started.db_job_id,{status:'error',params:job.params,finished_at:Math.floor(Date.now()/1000),error:'upload ACK unknown'})
return started}
function unknownProbe(){return{ok:true,items:[{message_id:7,state:'uploading',unknown:true},{message_id:8,state:'not_started',unknown:false}],blocked_message_ids:[7],safe_message_ids:[8]}}
test('unknown fence is preserved; authoritative partial resume never includes the uncertain media',async()=>{
const original=failed('original');const before=control.status('original').job.params._fetch_request_hash
assert.equal(control.status('original').can_resume,false)
assert.throws(()=>control.resume('original','unsafe'),e=>e.code==='FETCH_RESUME_MEDIA_DELIVERY_UNKNOWN')
probeResult=unknownProbe();await control.asrCheckpoint('original')
assert.equal(control.status('original').can_resume,false);assert.equal(control.status('original').can_resume_partial,true)
const resumed=control.resume('original','safe',{skipUnknownMedia:true})
assert.deepEqual(resumed.job.params.message_ids,[8]);assert.deepEqual(resumed.job.params.resume_quarantined_message_ids,[7])
assert.equal(control.status('original').job.params._fetch_request_hash,before)
assert.equal(control.status('original').recovery_reason,'media_delivery_unknown')
assert.equal(original.db_job_id,control.status('original').db_job_id)
})
test('positive known-provider proof permits full resume without rewriting the original error or payload',async()=>{
failed('positive');probeResult={...unknownProbe(),items:[{message_id:7,state:'uploaded',unknown:false,has_file_id:true},{message_id:8,state:'not_started',unknown:false}],blocked_message_ids:[],safe_message_ids:[7,8]}
await control.asrCheckpoint('positive');assert.equal(control.status('positive').can_resume,true)
const resumed=control.resume('positive','positive-resume');assert.deepEqual(resumed.job.params.message_ids,[7,8])
assert.equal(control.status('positive').job.params._error_code,'media_delivery_unknown')
})
test('expired, wrong-scope and unknown-launch proofs cannot bypass the fence',async()=>{
const started=failed('expired');probeResult=unknownProbe();await control.asrCheckpoint('expired')
const row=db.getDb().prepare('SELECT parameters_json FROM jobs WHERE id=?').get(started.db_job_id);const params=JSON.parse(row.parameters_json)
params._asr_checkpoint_probe.checked_at_ms=Date.now()-300001;db.updateJob(started.db_job_id,{params})
assert.equal(control.status('expired').can_resume_partial,false)
assert.throws(()=>control.resume('expired','expired-resume',{skipUnknownMedia:true}),e=>e.code==='ASR_PARTIAL_RESUME_NOT_PROVEN')
probeResult={...unknownProbe(),safe_message_ids:[999]};await assert.rejects(control.asrCheckpoint('expired'),e=>e.code==='ASR_CHECKPOINT_SCOPE_MISMATCH')
params._fetch_launch_unknown=true;db.updateJob(started.db_job_id,{params});await assert.rejects(control.asrCheckpoint('expired'),e=>e.code==='ASR_RECOVERY_SCOPE_REQUIRED')
})
