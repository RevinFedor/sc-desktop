'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'asr-runner-'))
process.env.SC_DESKTOP_DIR=tmp;process.env.SC_DESKTOP_DB=path.join(tmp,'library.db');process.env.SONIOX_API_KEY='fixture-only'
const cp=require('node:child_process'),oldSpawn=cp.spawn;let payload
cp.spawn=(command,args,options)=>{
 const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.kill=()=>true
 let input='';c.stdin.on('data',v=>{input+=v});c.stdin.on('finish',()=>{
  payload={command,args,options,request:JSON.parse(input)}
  process.nextTick(()=>{c.stdout.write(JSON.stringify({type:'result',result:{ok:true,items:[{message_id:7,state:'not_started',unknown:false}],safe_message_ids:[7],blocked_message_ids:[]}})+'\n');c.stdout.end();c.emit('close',0)})
 });return c
}
const db=require('./database'),runner=require('./job-runner')
test.after(()=>{cp.spawn=oldSpawn;db.close();fs.rmSync(tmp,{recursive:true,force:true})})
test('ASR checkpoint worker uses the existing visible runner, namespace fence and stdin, not Telegram or a sidecar',async()=>{
 const result=await runner.runTelegramAsrCheckpointCommand({original_request_id:'original',action:'inspect',message_ids:[7]},
  {_tg_session_override:'fixture-session',expected_account_id:1033,expected_peer_id:-100123})
 assert.equal(result.ok,true);assert.ok(Number.isSafeInteger(result.desktop_job_id));assert.ok(Number.isSafeInteger(result.db_job_id))
 assert.equal(runner.getJobDetail(result.desktop_job_id).status,'done')
 assert.match(payload.args[0],/telegram\/tg_asr_recovery_ndjson\.py$/)
 assert.deepEqual(payload.args.slice(1),[]);assert.equal(payload.options.stdio[0],'pipe')
 assert.equal(payload.request.expected_peer_id,-100123)
 assert.match(payload.request.state_dir,/telegram-asr-state\/[0-9a-f]{32}$/)
 assert.equal(payload.request.message_ids[0],7)
 assert.equal(runner.listJobs().some(j=>j.id===result.desktop_job_id),true)
})
