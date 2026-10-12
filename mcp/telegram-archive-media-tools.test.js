'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { archiveArgs, callTelegramArchiveMediaTool } = require('./telegram-archive-media-tools')

test('exact controller start reuses job, no shell or generic fetch fallback', async () => {
  let observed
  const out = await callTelegramArchiveMediaTool('telegram_archive_media_start', { job_id: 'tg-one' }, async (file, argv, options) => {
    observed = {file,argv,options}; return { stdout: '{"ok":true,"job_id":"tg-one","pid":5}\n' }
  })
  assert.match(observed.file,/\.venv\/bin\/python3$/)
  assert.deepEqual(observed.argv.slice(1), ['background','--job-id','tg-one'])
  assert.equal(observed.options.shell,undefined)
  assert.equal(JSON.parse(out.content[0].text).pid,5)
})
test('reject wrong peer/source and raw key before launching producer', () => {
  const args={job_id:'tg-one',source_ids:[1],session:'session_4531193',expected_account_id:9,
    credential_ref:'boosty-soniox:11111111-1111-1111-1111-111111111111',media_pool_job_id:'same-pool'}
  assert.deepEqual(archiveArgs('telegram_archive_media_plan',args).slice(0,3),['plan','--job-id','tg-one'])
  assert.throws(()=>archiveArgs('telegram_archive_media_plan',{...args,credential_ref:'raw-key'}),/opaque/)
  assert.throws(()=>archiveArgs('telegram_archive_media_plan',{...args,peers:[{source_id:2,peer_id:-100123}]}),/selected source/)
  assert.throws(()=>archiveArgs('telegram_archive_media_status',{job_id:'../another'}),/Stable/)
})
