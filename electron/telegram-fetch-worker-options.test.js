'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { telegramFetchWorkerOptions } = require('./telegram-fetch-worker-options')

test('omitted optional policy keeps old unbounded/default worker flags unchanged', () => {
  assert.deepEqual(telegramFetchWorkerOptions({ process_voice: true, transcribe_engine: 'assemblyai' }, { jobsDir: '/owned/jobs' }), [])
})

test('exact night options pass inclusive1200, voice/audio, externalcache and account/peer fences', () => {
  const args = telegramFetchWorkerOptions({ expected_account_id: 1033012338, expected_peer_id: -1002369738868, download_profile_photo: false,
    voice_types: ['voice', 'audio'], voice_max_duration_sec: 1200,
    media_cache_dir: '/Volumes/digma512/sc-desktop-career-night-2026-10-07/media',
    media_min_free_bytes: 268435456, reuse_transcripts: true }, { jobsDir: '/owned/jobs', session: 'session_4531193' })
  for (const [flag, value] of [['--expected-account-id','1033012338'], ['--expected-peer-id','-1002369738868'],
    ['--voice-types','voice,audio'], ['--voice-max-duration-sec','1200'],
    ['--media-cache-dir','/Volumes/digma512/sc-desktop-career-night-2026-10-07/media']]) {
    assert.equal(args[args.indexOf(flag) + 1], value)
  }
  assert.ok(args.includes('--reuse-transcripts'))
  assert.ok(args.includes('--skip-profile-photo'))
  assert.equal(args.includes('--full-history-report'), false)
  assert.ok(args[args.indexOf('--media-state-dir') + 1].startsWith('/owned/jobs/telegram-asr-state/'))
})

test('full resume preserves original snapshot key and always replays metadata from a safe owned namespace', () => {
  const args = telegramFetchWorkerOptions({ full_history: true, request_id: 'resume-1', _fetch_history_request_id: 'original' },
    { jobsDir: '/owned/jobs', session: '../../another-app' })
  assert.ok(args.includes('--full-history-report'))
  assert.equal(args[args.indexOf('--traversal-request-id') + 1], 'original')
  const directory = args[args.indexOf('--traversal-state-dir') + 1]
  assert.equal(path.dirname(directory), '/owned/jobs/telegram-history-state')
  assert.equal(args.includes('--offset-id'), false)
  assert.equal(args.includes('--since-msgid'), false)
})

test('actual runner source wires the optional helper once before spawn and never makes durable requests coverage noops', () => {
  const source = fs.readFileSync(path.join(__dirname, 'job-runner.js'), 'utf8')
  const start = source.slice(source.indexOf('function startTelegramFetch(params)'), source.indexOf('const spawnStartedMs', source.indexOf('function startTelegramFetch(params)')))
  assert.match(start, /telegramFetchWorkerOptions\(params, \{ jobsDir: JOBS_DIR, session: tgSession \}\)/)
  const planner = source.slice(source.indexOf('function telegramCoveragePlannerAllowed'), source.indexOf('function isSourceWideTelegramCoverageParams'))
  assert.match(planner, /if \(params\.request_id\) return false/)
})
