'use strict'

const { randomUUID } = require('node:crypto')
const { fail, authorHandle, projectPost, projectTiers, unfiltered } = require('./boosty-catalog-contract')
const object = value => { try { return JSON.parse(value || '{}') || {} } catch { return {} } }

// Runs inside the existing catalogue-finalizer DB worker. No schema fork,
// extra library, saved-body read or file/clipboard/media action.
function savePublicCatalog(db, { entity, posts = [], summary = {}, params, status }) {
  if (!entity?.author_handle || authorHandle(entity.author_handle) !== params.handle) throw fail('BOOSTY_AUTHOR_MISMATCH', 'Upstream author does not match the catalogue scope')
  const h = db.getDb()
  return h.transaction(() => {
    const sourceId = db.upsertBoostyChannel({ author_id: entity.author_id || null, handle: params.handle,
      display_name: entity.title || params.handle, avatar_url: null, meta: {}, is_explicit: true, mark_synced: false })
    const source = h.prepare('SELECT meta_json FROM sources WHERE id=?').get(sourceId)
    const previous = object(source.meta_json).public_catalog || {}
    const existing = new Map(h.prepare("SELECT id,external_id,type,has_media,raw_meta_json FROM items WHERE source_id=? AND type IN ('boosty_post','boosty_video')").all(sourceId).map(row => [row.external_id, row]))
    const normalized = [...new Map(posts.map(p => projectPost(p, params.handle)).filter(Boolean).map(p => [p.post_id, p])).values()]
    const checkedAt = Number(summary.checked_at) || Math.floor(Date.now() / 1000)
    let videos = 0
    if (!params.tiers_only) for (const post of normalized) {
      const old = existing.get(post.external_id), meta = object(old?.raw_meta_json)
      // A public observation is NEVER an account-access refresh. In particular
      // anonymous locked != lost, and it must not erase a paid saved caption.
      db.upsertItem({ source_id: sourceId, external_id: post.external_id, type: 'boosty_post',
        url: post.canonical_url, title: post.title, caption: null, published_at: post.publish_time || post.created_at,
        has_media: post.declared_video_count > 0 || post.videos.length > 0 || !!old?.has_media,
        raw_meta: { ...meta, platform: 'boosty', entity_kind: 'post', post_id: post.post_id,
          canonical_url: post.canonical_url, has_access: meta.has_access ?? null, access_state: meta.access_state || 'unknown',
          subscription_level: post.subscription_level, price: post.post_price, currency_prices: post.post_currency_prices,
          tags: post.tags, video_count: post.declared_video_count ?? meta.video_count ?? post.videos.length,
          public_catalog: { ...post, checked_at: checkedAt, request_id: params.request_id } },
        parent_external_id: null, depth: 0 })
      for (const video of post.videos) {
        if (!video.video_id) continue
        const oldVideo = existing.get(video.video_id), childMeta = object(oldVideo?.raw_meta_json)
        db.upsertItem({ source_id: sourceId, external_id: video.video_id, type: 'boosty_video', url: post.canonical_url,
          title: video.title || post.title, caption: null, published_at: post.publish_time || post.created_at,
          duration_seconds: video.duration_sec, has_media: true, parent_external_id: post.external_id, depth: 1,
          raw_meta: { ...childMeta, platform: 'boosty', entity_kind: 'video', post_id: post.post_id, post_external_id: post.external_id,
            canonical_url: post.canonical_url, has_access: childMeta.has_access ?? null, access_state: childMeta.access_state || 'unknown',
            position: video.position, video_kind: video.kind,
            public_catalog: { ...video, has_access: post.has_access, access_scope: 'public_anonymous', checked_at: checkedAt } } })
        videos++
      }
      // Absent public children remain untouched, including access/transcripts.
    }
    const complete = !params.tiers_only && status === 'done' && unfiltered(params) && summary.remote_eof === true
      && summary.catalog_complete === true && !summary.invalid_rows
      && (!Number.isFinite(summary.posts_total) || normalized.length === summary.posts_total)
    const latest = { request_id: params.request_id, job_id: params.public_job_id, scope: {
      auth_mode: 'public', order: params.order, limit: params.limit, from_ts: params.from_ts, to_ts: params.to_ts,
      tags: params.tags, only_allowed: params.only_allowed, metadata_only: true },
      status, checked_at: checkedAt, started_at: summary.started_at || null, posts_count: normalized.length,
      fetched: Number(summary.fetched) || 0, duplicates: Number(summary.duplicates) || 0, pages: Number(summary.pages) || 0,
      invalid_rows: Number(summary.invalid_rows) || 0,
      remote_eof: summary.remote_eof === true, complete_visible_feed: complete,
      next_cursor: typeof summary.next_cursor === 'string' ? summary.next_cursor : null,
      stop_reason: status === 'cancelled' ? 'cancelled' : status === 'error' ? (summary.stop_reason || 'error') : summary.stop_reason || 'unknown',
      profile_posts_reference: Number.isFinite(entity.posts_count) ? entity.posts_count : null,
      declared_video_count: normalized.reduce((n, p) => n + (p.declared_video_count || 0), 0),
      visible_video_count: normalized.reduce((n, p) => n + p.visible_video_count, 0), identified_video_count: videos,
      video_posts: normalized.filter(p => p.declared_video_count > 0 || p.visible_video_count > 0).length,
      anonymous_access_counts: Object.fromEntries(['public_access', 'locked_for_anonymous', 'unknown'].map(state => [state, normalized.filter(p => p.access_state === state).length])),
      declared_counts_missing_posts: normalized.filter(p => p.declared_video_count == null).length,
      exposed_durations_missing: normalized.flatMap(p => p.videos).filter(v => v.duration_sec == null).length,
      post_ids: normalized.map(p => p.post_id) }
    const incomingTiers = projectTiers(summary.tiers)
    const tiers = incomingTiers.status === 'not_checked' ? previous.tiers || incomingTiers
      : { ...incomingTiers, checked_at: checkedAt, request_id: params.request_id }
    const state = { ...previous, version: 1, auth_mode: 'public', account_entitlement_verified: false,
      catalog_revision: randomUUID(), metadata_only: true,
      latest: params.tiers_only ? previous.latest || null : latest,
      last_complete: complete ? latest : previous.last_complete || null,
      tiers, last_complete_tiers: tiers.complete ? tiers : previous.last_complete_tiers || null,
      latest_tiers_run: params.tiers_only ? { request_id: params.request_id, job_id: params.public_job_id, status, checked_at: checkedAt } : previous.latest_tiers_run || null }
    db.patchSourceMeta(sourceId, { public_catalog: state }, { mark_synced: false })
    return { sourceId, counts: { posts: normalized.length, videos }, state }
  })()
}

function resolveSource(db, args) {
  const h = db.getDb()
  const source = args.source_id != null
    ? h.prepare("SELECT * FROM sources WHERE id=? AND platform='boosty'").get(Number(args.source_id))
    : h.prepare("SELECT * FROM sources WHERE platform='boosty' AND lower(handle)=?").get(authorHandle(args.handle || args.url))
  if (!source) throw fail('BOOSTY_CATALOG_SOURCE_NOT_FOUND', 'Saved Boosty source not found; start a public catalogue first')
  return source
}
function sourceState(db, source) {
  const state = object(source.meta_json).public_catalog || null
  const counts = db.getDb().prepare("SELECT SUM(type='boosty_post') AS posts,SUM(type='boosty_video') AS videos FROM items WHERE source_id=?").get(source.id)
  const withoutIds = run => run ? Object.fromEntries(Object.entries(run).filter(([k]) => k !== 'post_ids')) : null
  return { source_id: source.id, handle: source.handle, title: source.display_name, canonical_url: `https://boosty.to/${source.handle}`,
    auth_mode: 'public', account_entitlement_verified: false, catalogue_checked: !!state,
    catalog_revision: state?.catalog_revision || null, latest: withoutIds(state?.latest), last_complete: withoutIds(state?.last_complete),
    tiers: state?.tiers || { status: 'not_checked', tiers: [], complete: false }, last_complete_tiers: state?.last_complete_tiers || null,
    latest_tiers_run: state?.latest_tiers_run || null, known_library_posts: counts.posts || 0, known_library_children: counts.videos || 0,
    freshness: 'saved_snapshot_no_remote_probe',
    interpretation: 'EOF covers the publicly visible feed at the recorded time; saved account texts and historical children are separate' }
}
function bound(value, fallback, max) {
  const n = value == null ? fallback : Number(value)
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw fail('BOOSTY_CATALOG_PAGE_INVALID', 'Invalid metadata pagination')
  return n
}
function readJob(db, args) {
  if (!args.job_id && !args.request_id) throw fail('BOOSTY_JOB_ID_REQUIRED', 'Exact job_id or request_id is required')
  const key = args.job_id ? 'public_job_id' : 'request_id', value = args.job_id || args.request_id
  const row = db.getDb().prepare(`SELECT * FROM jobs WHERE type='boosty_channel_fetch' AND json_valid(parameters_json)
    AND json_extract(parameters_json,'$.auth_mode')='public' AND json_extract(parameters_json,'$.${key}')=? ORDER BY id DESC LIMIT 1`).get(value)
  if (!row) throw fail('BOOSTY_CATALOG_JOB_NOT_FOUND', 'Exact public catalogue job not found; no replacement was started')
  const p = object(row.parameters_json)
  return { ok: true, job: { job_id: p.public_job_id, db_id: row.id, request_id: p.request_id, source_id: row.source_id,
    type: row.type, status: row.status, items_done: row.items_done, started_at: row.started_at, finished_at: row.finished_at,
    error: row.error, params: p, progress: p._boosty_channel || null } }
}
function performRead(db, action, args = {}) {
  try {
    if (action === 'job') return readJob(db, args)
    if (action === 'sources') {
      const rows = db.getDb().prepare("SELECT * FROM sources WHERE platform='boosty' ORDER BY id").all()
      const offset = bound(args.offset, 0, 1000000), limit = bound(args.limit, 50, 500) || 50
      return { ok: true, total: rows.length, sources: rows.slice(offset, offset + limit).map(s => sourceState(db, s)),
        has_more: offset + limit < rows.length,
        next_offset: offset + limit < rows.length ? offset + limit : null }
    }
    return db.getDb().transaction(() => {
      const source = resolveSource(db, args), state = object(source.meta_json).public_catalog
      if (action === 'state' || action === 'tiers') return { ok: true, ...sourceState(db, source) }
      if (action !== 'posts') throw fail('BOOSTY_CATALOG_READ_INVALID', 'Unknown public catalogue read')
      if (!state) throw fail('BOOSTY_PUBLIC_CATALOG_NOT_FETCHED', 'No public metadata snapshot for this source')
      const offset = bound(args.offset, 0, 1000000), limit = bound(args.limit, 50, 500) || 50
      if ((offset && !args.expected_catalog_revision) || (args.expected_catalog_revision && args.expected_catalog_revision !== state.catalog_revision)) throw fail('BOOSTY_CATALOG_REVISION_CHANGED', 'Continue with the same catalogue revision; restart paging after a refresh')
      const view = args.view || 'latest'
      if (!['latest', 'known'].includes(view)) throw fail('BOOSTY_CATALOG_PAGE_INVALID', 'view must be latest or known')
      const rows = db.getDb().prepare("SELECT raw_meta_json FROM items WHERE source_id=? AND type='boosty_post' AND CASE WHEN json_valid(raw_meta_json) THEN json_type(raw_meta_json,'$.public_catalog') ELSE NULL END='object'").all(source.id)
      const byId = new Map(rows.map(r => object(r.raw_meta_json).public_catalog).filter(Boolean).map(p => [p.post_id, p]))
      const posts = view === 'latest' ? (state.latest?.post_ids || []).map(id => byId.get(id)).filter(Boolean) : [...byId.values()].sort((a, b) => (b.publish_time || b.created_at || 0) - (a.publish_time || a.created_at || 0) || a.post_id.localeCompare(b.post_id))
      return { ok: true, source_id: source.id, handle: source.handle, view, catalog_revision: state.catalog_revision,
        ...{ coverage: sourceState(db, source) }, total: posts.length, offset,
        posts: posts.slice(offset, offset + limit), has_more: offset + limit < posts.length,
        next_offset: offset + limit < posts.length ? offset + limit : null,
        snapshot: view === 'known' ? 'known_union_latest_observation_per_post' : 'latest_feed_pass_only' }
    })()
  } catch (e) { return { ok: false, code: e.code || 'BOOSTY_CATALOG_READ_FAILED', error: e.code ? e.message : 'Could not read saved public metadata' } }
}

module.exports = { savePublicCatalog, performRead, readJob }
