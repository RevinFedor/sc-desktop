'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events')
const {ndjsonWorkerDeadline}=require('./ndjson-worker-deadline')
function child(){const c=new EventEmitter();c.exitCode=null;c.signalCode=null;c.signals=[];c.kill=s=>c.signals.push(s);return c}
test('read-only worker deadline signals only its own child, reports unknown and escalates without waiting forever',async()=>{
 const c=child();let warnings=0;const d=ndjsonWorkerDeadline(c,{timeoutMs:5,graceMs:5,onTimeout:()=>warnings++})
 await new Promise(r=>setTimeout(r,20));assert.equal(d.expired(),true);assert.equal(warnings,1);assert.deepEqual(c.signals,['SIGTERM','SIGKILL']);d.clear()
})
test('normal close clears timers and does not kill another worker',async()=>{
 const c=child();const d=ndjsonWorkerDeadline(c,{timeoutMs:5});c.exitCode=0;c.emit('close',0)
 await new Promise(r=>setTimeout(r,10));assert.equal(d.expired(),false);assert.deepEqual(c.signals,[])
})
test('omitted deadline leaves existing one-shot flows unchanged',()=>{
 const c=child();const d=ndjsonWorkerDeadline(c);assert.equal(d.expired(),false);assert.deepEqual(c.signals,[]);d.clear()
})
