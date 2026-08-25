// Deterministic, credential-free fixture for Electron responsiveness E2E.
// Run through Electron's Node runtime so better-sqlite3 uses the Electron ABI:
//   ELECTRON_RUN_AS_NODE=1 electron scripts/e2e-seed-performance.js

const db = require('../electron/database')

const mainSourceId = db.upsertSource({
  platform: 'telegram',
  handle: 'e2e_big_chat',
  display_name: 'E2E Большой чат',
  external_id: '9900001',
  meta: { kind: 'channel', username: 'e2e_big_chat' },
  is_explicit: true,
  tg_session: null,
})

const itemRows = Array.from({ length: 3000 }, (_, index) => ({
  source_id: mainSourceId,
  external_id: String(index + 1),
  type: index % 11 === 0 ? 'photo' : 'text',
  caption: index % 17 === 0
    ? `E2E long message ${index + 1}\n${'variable height text '.repeat(35)}`
    : `E2E message ${index + 1}`,
  published_at: 1_700_000_000 + Math.floor(index / 3),
  sender: `fixture-user-${index % 500}`,
  has_media: index % 11 === 0,
  reactions: index % 19 === 0 ? [{ e: '👍', n: 3 }] : [],
  reactions_resolved: true,
}))
for (let index = 0; index < itemRows.length; index += 500) {
  db.bulkUpsertItems(itemRows.slice(index, index + 500))
}

const sourceIds = [mainSourceId]
for (let index = 0; index < 1200; index++) {
  sourceIds.push(db.upsertSource({
    platform: 'telegram',
    handle: `e2e_chat_${String(index).padStart(4, '0')}`,
    display_name: `E2E чат ${String(index).padStart(4, '0')}`,
    external_id: String(9_910_000 + index),
    meta: { kind: index % 3 === 0 ? 'user' : index % 3 === 1 ? 'channel' : 'group' },
    is_explicit: false,
    tg_session: null,
  }))
}

const folderId = db.upsertFolder({
  tg_filter_id: 77,
  title: 'E2E папка 1000',
  tg_session: null,
  default_period_days: 0,
  default_types_json: JSON.stringify(['text']),
})
db.setFolderSources(folderId, sourceIds.slice(0, 1000))

for (let index = 0; index < 250; index++) {
  db.recordJob({
    type: index % 5 === 0 ? 'tg_preview' : 'tg_fetch',
    source_id: mainSourceId,
    status: index % 23 === 0 ? 'error' : 'done',
    items_total: 100 + index,
    items_done: 100 + index,
    params: { mode: 'last_n', limit: 100 + index, fixture: true },
    error: index % 23 === 0 ? 'fixture error' : null,
    started_at: 1_710_000_000 + index,
    finished_at: 1_710_000_001 + index,
  })
}

function seedVideoSource({ platform, handle, displayName, count, externalPrefix }) {
  const sourceId = db.upsertSource({
    platform,
    handle,
    display_name: displayName,
    external_id: `${externalPrefix}-source`,
    meta: { kind: 'channel' },
    is_explicit: true,
  })
  const rows = Array.from({ length: count }, (_, index) => ({
    source_id: sourceId,
    external_id: platform === 'instagram'
      ? `reel:${externalPrefix}${String(index).padStart(5, '0')}`
      : `${externalPrefix}${String(index).padStart(7, '0')}`,
    type: 'video',
    title: `${displayName} video ${index + 1}`,
    caption: `${displayName} caption ${index + 1}`,
    published_at: 1_720_000_000 + index,
    duration_seconds: 30 + (index % 1200),
    views: index * 17,
    has_media: true,
  }))
  for (let index = 0; index < rows.length; index += 500) {
    db.bulkUpsertItems(rows.slice(index, index + 500))
  }
  return sourceId
}

const youtubeSourceId = seedVideoSource({
  platform: 'youtube', handle: 'e2e-youtube', displayName: 'E2E YouTube 1000',
  count: 1000, externalPrefix: 'yt',
})
const tiktokSourceId = seedVideoSource({
  platform: 'tiktok', handle: 'e2e-tiktok', displayName: 'E2E TikTok 1000',
  count: 1000, externalPrefix: 'tk',
})
const instagramSourceId = seedVideoSource({
  platform: 'instagram', handle: 'e2e-instagram', displayName: 'E2E Instagram 500',
  count: 500, externalPrefix: 'ig',
})

console.log(JSON.stringify({
  mainSourceId,
  folderId,
  youtubeSourceId,
  tiktokSourceId,
  instagramSourceId,
  telegramSources: sourceIds.length,
  telegramItems: itemRows.length,
  jobs: 250,
}))
db.close()
