const test = require('node:test')
const assert = require('node:assert/strict')
const { createResearchNavigation } = require('./research-navigation')
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(options = {}) {
  const events = [], reads = [], focused = []
  const window = { isDestroyed: () => false, isMinimized: () => true, restore: () => focused.push('restore'),
    show: () => focused.push('show'), focus: () => focused.push('focus'),
    webContents: { id: 7, send: (channel, body) => events.push({ channel, body }) } }
  const nav = createResearchNavigation({ getWindow: () => window,
    readJob: async id => { reads.push(id); return { jobId: id, status: 'done' } }, ...options })
  return { nav, events, reads, focused }
}
test('read-only navigation focuses the existing window; exact rendered ACK, not publication, owns success', async t => {
  const f=fixture();t.after(() => f.nav.dispose())
  let resolved=false
  const result=f.nav.open({jobId:'noted_job',requestId:'nav'}).then(value => {resolved=true;return value})
  await tick();assert.equal(resolved,false)
  assert.deepEqual(f.reads,['noted_job']);assert.deepEqual(f.focused,['restore','show','focus'])
  assert.equal(f.events[0].channel,'research:open-job-request')
  assert.deepEqual(f.nav.ready(7),{jobId:'noted_job',requestId:'nav',sequence:1})
  assert.equal(f.nav.acknowledge(8,{jobId:'noted_job',requestId:'nav',success:true}).ok,false)
  assert.equal(f.nav.acknowledge(7,{jobId:'foreign',requestId:'nav',success:true}).ok,false)
  assert.equal(resolved,false)
  f.nav.acknowledge(7,{jobId:'noted_job',requestId:'nav',success:true})
  assert.deepEqual(await result,{ok:true,opened:true,jobId:'noted_job',requestId:'nav'})
})
test('request replay is deduplicated but cannot address another job',async t => {
  const f=fixture();t.after(() => f.nav.dispose())
  const first=f.nav.open({jobId:'job',requestId:'nav'}),second=f.nav.open({jobId:'job',requestId:'nav'})
  await tick();assert.equal(f.reads.length,1);assert.equal(f.events.length,1)
  await assert.rejects(f.nav.open({jobId:'other',requestId:'nav'}),/conflict/)
  f.nav.acknowledge(7,{jobId:'job',requestId:'nav',success:true})
  assert.deepEqual(await first,await second)
})
test('a newer command supersedes a slow earlier lookup and its late ACK',async t => {
  let release
  const f=fixture({readJob:id => id==='slow'?new Promise(resolve => {release=resolve}):{jobId:id}})
  t.after(() => f.nav.dispose())
  const first=f.nav.open({jobId:'slow',requestId:'a'}),second=f.nav.open({jobId:'new',requestId:'b'})
  await tick();release({jobId:'slow'});await tick()
  assert.equal((await first).error,'research_navigation_superseded')
  assert.equal(f.events.length,1);assert.equal(f.events[0].body.jobId,'new')
  f.nav.acknowledge(7,{jobId:'new',requestId:'b',success:true});assert.equal((await second).ok,true)
})
test('missing and foreign jobs cannot focus a window or change a job status',async t => {
  for (const readJob of [() => null,() => ({jobId:'other'})]) {
    const f=fixture({readJob});t.after(() => f.nav.dispose())
    assert.equal((await f.nav.open({jobId:'missing',requestId:'nav'})).error,'research_job_not_found')
    assert.equal(f.focused.length,0);assert.equal(f.events.length,0)
  }
})
test('a missing renderer ACK expires with no late ready/ACK success',async t => {
  const f=fixture({deadlineMs:5});t.after(() => f.nav.dispose())
  const result=await f.nav.open({jobId:'job',requestId:'nav'})
  assert.equal(result.error,'research_navigation_timeout');assert.equal(f.nav.ready(7),null)
  assert.equal(f.nav.acknowledge(7,{jobId:'job',requestId:'nav',success:true}).ok,false)
})
test('dispose cancels pending commands and empty identifiers refuse before read/focus',async () => {
  const f=fixture()
  await assert.rejects(f.nav.open({jobId:'',requestId:'nav'}),/invalid/)
  const waiting=f.nav.open({jobId:'job',requestId:'nav'});await tick();f.nav.dispose()
  assert.equal((await waiting).error,'research_navigation_disposed')
})
