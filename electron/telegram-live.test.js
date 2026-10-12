const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeTelegramLiveRequest,
  createTelegramLiveState,
  applyTelegramLiveEvent,
  publicTelegramLiveState,
  telegramMembershipSourcePayload,
  telegramMembershipMutationInFlight,
} = require('./telegram-live')

test('normalizes one search and a bounded cross-product batch', () => {
  const single = normalizeTelegramLiveRequest({
    operation: 'search', chat: 'ОМ: Таиланд', query: 'брекеты', limit: 999,
  })
  assert.equal(single.searches.length, 1)
  assert.equal(single.searches[0].limit, 100)
  assert.equal(single.concurrency, 3)

  const batch = normalizeTelegramLiveRequest({
    operation: 'search', chats: ['a', 'b'], queries: ['x', 'y'], concurrency: 99,
  })
  assert.deepEqual(batch.searches.map(row => `${row.chat}:${row.query}`), [
    'a:x', 'a:y', 'b:x', 'b:y',
  ])
  assert.equal(batch.concurrency, 5)
})

test('rejects ambiguous context/range requests and overlarge search batches', () => {
  assert.throws(
    () => normalizeTelegramLiveRequest({ operation: 'context', chat: 'x' }),
    /context requires/,
  )
  assert.throws(
    () => normalizeTelegramLiveRequest({ operation: 'range', chat: 'x', from_id: 1 }),
    /range requires/,
  )
  assert.throws(
    () => normalizeTelegramLiveRequest({
      operation: 'search',
      chats: Array.from({ length: 7 }, (_, index) => `c${index}`),
      queries: Array.from({ length: 10 }, (_, index) => `q${index}`),
    }),
    /max 60/,
  )
  assert.throws(
    () => normalizeTelegramLiveRequest({ operation: 'attachment', chat: 'x' }),
    /attachment requires/,
  )
  assert.throws(
    () => normalizeTelegramLiveRequest({ operation: 'transcribe', chat: 'x' }),
    /transcribe requires/,
  )
})

test('normalizes one explicit attachment without changing lightweight operations', () => {
  const request = normalizeTelegramLiveRequest({
    operation: 'attachment',
    url: 'https://t.me/c/3861500830/1/3806',
    max_bytes: 9999999999,
    max_text_chars: 9999999,
  })
  assert.equal(request.operation, 'attachment')
  assert.equal(request.url, 'https://t.me/c/3861500830/1/3806')
  assert.equal(request.max_bytes, 2 * 1024 * 1024 * 1024)
  assert.equal(request.max_text_chars, 1000000)
})

test('normalizes one selected live transcription with Soniox defaults', () => {
  const request = normalizeTelegramLiveRequest({
    operation: 'transcribe',
    chat: '3451593250',
    message_id: 37314,
    language_hints: ['RU', 'en', 'ru'],
    context: 'Таиланд и Пхукет',
  })
  assert.equal(request.operation, 'transcribe')
  assert.equal(request.engine, 'soniox')
  assert.deepEqual(request.language_hints, ['ru', 'en'])
  assert.equal(request.context, 'Таиланд и Пхукет')
  assert.throws(
    () => normalizeTelegramLiveRequest({
      operation: 'transcribe', chat: 'x', message_id: 1, engine: 'telegram',
    }),
    /unsupported live transcription engine/,
  )
})

test('membership mutations require explicit confirmation and public search stays read-only', () => {
  assert.throws(
    () => normalizeTelegramLiveRequest({ operation: 'join', target: '@telegram' }),
    /confirm=true/,
  )
  assert.throws(
    () => normalizeTelegramLiveRequest({ operation: 'leave', target: '@telegram', confirm: false }),
    /confirm=true/,
  )
  const join = normalizeTelegramLiveRequest({
    operation: 'join', target: 'https://t.me/+AbCdEf_123', confirm: true,
  })
  assert.equal(join.target, 'https://t.me/+AbCdEf_123')
  assert.equal(join.confirm, true)
  const search = normalizeTelegramLiveRequest({
    operation: 'public_search', query: 'Phuket rentals', limit: 999,
  })
  assert.equal(search.query, 'Phuket rentals')
  assert.equal(search.limit, 50)
})

test('membership result stays compact and maps to canonical Telegram source identity', () => {
  const request = normalizeTelegramLiveRequest({
    operation: 'join', target: '@phuket_rentals', confirm: true,
  })
  const job = {
    params: request,
    tg_live: createTelegramLiveState(request),
    items_done: 0,
    items_total: 1,
  }
  const result = {
    operation: 'join',
    status: 'joined',
    joined: true,
    already_member: false,
    ready_for_fetch: true,
    source_id: 42,
    source_registered: true,
    chat: {
      id: 123456789,
      title: 'Phuket Rentals',
      username: 'phuket_rentals',
      type: 'supergroup',
      source_kind: 'group',
      participants_count: 3210,
      has_discussion: false,
      public: true,
      member: true,
    },
    hits: 1,
    unique_hits: 1,
  }
  applyTelegramLiveEvent(job, { type: 'result', result })
  assert.equal(job.tg_live_membership.chat.type, 'supergroup')
  assert.equal(job.tg_live_membership.source_id, 42)
  assert.equal(job.tg_live_membership.ready_for_fetch, true)
  const payload = telegramMembershipSourcePayload(result, 'session_fixture')
  assert.equal(payload.handle, 'phuket_rentals')
  assert.equal(payload.external_id, '123456789')
  assert.equal(payload.meta.kind, 'group')
  assert.equal(payload.meta.tg_membership.status, 'member')
  assert.equal(payload.tg_session, 'session_fixture')

  const privateResult = {
    operation: 'join', ready_for_fetch: true,
    chat: { id: 987, title: 'Private', username: null, source_kind: 'chat' },
  }
  assert.equal(telegramMembershipSourcePayload(privateResult, 's').handle, '-987')
})

test('FloodWait retry is visible in the compact live state', () => {
  const request = normalizeTelegramLiveRequest({
    operation: 'join', target: '@telegram', confirm: true,
  })
  const job = { params: request, tg_live: createTelegramLiveState(request) }
  applyTelegramLiveEvent(job, {
    type: 'error', code: 'telegram_flood_wait',
    message: 'retry later', retry_after_seconds: 123,
  })
  const summary = publicTelegramLiveState(job.tg_live)
  assert.equal(job.error_code, 'telegram_flood_wait')
  assert.equal(summary.retry_after_seconds, 123)
})

test('membership cancellation becomes unsafe only after the Telegram RPC is sent', () => {
  assert.equal(telegramMembershipMutationInFlight({
    type: 'tg_live_join', tg_live: { stage: 'resolving_membership' },
  }), false)
  assert.equal(telegramMembershipMutationInFlight({
    type: 'tg_live_join', tg_live: { stage: 'updating_membership' },
  }), true)
  assert.equal(telegramMembershipMutationInFlight({
    type: 'tg_live_leave', tg_live: { stage: 'updating_membership' },
  }), true)
  assert.equal(telegramMembershipMutationInFlight({
    type: 'tg_live_search', tg_live: { stage: 'updating_membership' },
  }), false)
})

test('keeps full live result private while exposing compact progress', () => {
  const request = normalizeTelegramLiveRequest({
    operation: 'search', chat: 'chat', query: 'secret query',
  })
  const job = {
    params: request,
    tg_live: createTelegramLiveState(request),
    items_done: 0,
    items_total: 1,
  }
  applyTelegramLiveEvent(job, { type: 'progress', done: 1, total: 1, hits: 3 })
  applyTelegramLiveEvent(job, {
    type: 'result',
    result: { messages: [{ message_id: 7, text: 'private body' }], hits: 3 },
  })
  const summary = publicTelegramLiveState(job.tg_live)
  assert.equal(summary.result_available, true)
  assert.equal(summary.unique_hits, 1)
  assert.equal(JSON.stringify(summary).includes('private body'), false)
  assert.equal(job._tgLiveResult.messages[0].text, 'private body')
})

test('selected original survives the public result channel without raising preview caps', () => {
  const request = normalizeTelegramLiveRequest({
    operation: 'context', chat: '-100111', message_id: 7,
    caption_chars: 1000000, before: 0, after: 0, max_depth: 0, max_replies: 0,
  })
  assert.equal(request.caption_chars, 8000)
  const original = { native: { text: 'a'.repeat(9001), total_chars: 9001, truncated: false } }
  const job = { params: request, tg_live: createTelegramLiveState(request) }
  applyTelegramLiveEvent(job, {
    type: 'result', result: {
      operation: 'context', hit: { text: 'a'.repeat(8000), text_truncated: true },
      selected_original: original, hits: 1, unique_hits: 1, truncated: false,
    },
  })
  assert.equal(job._tgLiveResult.selected_original, original)
  assert.equal(publicTelegramLiveState(job.tg_live).result_available, true)
  assert.equal(JSON.stringify(publicTelegramLiveState(job.tg_live)).includes('aaaa'), false)
})

test('attachment progress exposes bytes while keeping extracted text private', () => {
  const request = normalizeTelegramLiveRequest({
    operation: 'attachment', chat: '3861500830', message_id: 3806,
  })
  const job = {
    params: request,
    tg_live: createTelegramLiveState(request),
    items_done: 0,
    items_total: 1,
  }
  applyTelegramLiveEvent(job, {
    type: 'progress', stage: 'downloading_attachment', done: 0, total: 1,
    bytes_done: 500, bytes_total: 1000, file_name: 'screen.jpg',
  })
  applyTelegramLiveEvent(job, {
    type: 'result',
    result: {
      operation: 'attachment', media_downloaded: true, file_path: '/tmp/screen.jpg',
      attachment: { file_name: 'screen.jpg', bytes: 1000, extracted_text: 'private file body' },
      hits: 1, unique_hits: 1,
    },
  })
  const summary = publicTelegramLiveState(job.tg_live)
  assert.equal(summary.bytes_done, 1000)
  assert.equal(summary.bytes_total, 1000)
  assert.equal(summary.file_name, 'screen.jpg')
  assert.equal(summary.media_downloaded, true)
  assert.equal(JSON.stringify(summary).includes('private file body'), false)
  assert.equal(job.file_path, '/tmp/screen.jpg')
  assert.equal(job.tg_live_attachment.extraction, null)
})

test('live transcription exposes only compact provider state in job snapshots', () => {
  const request = normalizeTelegramLiveRequest({
    operation: 'transcribe', chat: '3451593250', message_id: 37314,
  })
  const job = {
    params: request,
    tg_live: createTelegramLiveState(request),
    items_done: 0,
    items_total: 1,
  }
  applyTelegramLiveEvent(job, {
    type: 'progress', stage: 'transcribing_soniox', done: 0, total: 1,
    bytes_done: 7868, bytes_total: 7868, provider: 'soniox',
  })
  applyTelegramLiveEvent(job, {
    type: 'result',
    result: {
      operation: 'transcribe',
      attachment_found: true,
      media_downloaded: true,
      file_path: '/tmp/voice.oga',
      transcript_path: '/tmp/voice__soniox.txt',
      attachment: { content_type: 'audio/ogg', bytes: 7868 },
      transcription: {
        status: 'transcribed', engine: 'soniox', model: 'stt-async-v5',
        text: 'private spoken body', chars: 19, returned_chars: 19,
        token_count: 4, truncated: false,
      },
      hits: 1,
      unique_hits: 1,
    },
  })
  const summary = publicTelegramLiveState(job.tg_live)
  assert.equal(summary.provider, 'soniox')
  assert.equal(summary.media_downloaded, true)
  assert.equal(JSON.stringify(summary).includes('private spoken body'), false)
  assert.equal(job.file_path, '/tmp/voice__soniox.txt')
  assert.equal(job.tg_live_attachment.file_path, '/tmp/voice.oga')
  assert.equal(job.tg_live_transcription.chars, 19)
  assert.equal(JSON.stringify(job.tg_live_transcription).includes('private spoken body'), false)
})
