'use strict'

const crypto = require('node:crypto')
const fail = (code, message) => Object.assign(new Error(message), { code })
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const bool = value => typeof value === 'boolean' ? value : null
const text = (value, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : null
const id = value => typeof value === 'number' && Number.isSafeInteger(value) ? String(value)
  : typeof value === 'string' && /^[\w-]{1,100}$/.test(value) ? value : null
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

function authorHandle(value) {
  let handle = String(value || '').trim()
  if (/^https?:\/\//i.test(handle)) {
    let url
    try { url = new URL(handle) } catch { throw fail('BOOSTY_AUTHOR_REQUIRED', 'A Boosty author URL or handle is required') }
    if (!['boosty.to', 'www.boosty.to'].includes(url.hostname) || url.username || url.password
        || !/^\/[\w.-]+\/?$/.test(url.pathname) || url.search || url.hash) throw fail('BOOSTY_AUTHOR_REQUIRED', 'Use the author URL, not a post or purchase URL')
    handle = url.pathname.replace(/^\/|\/$/g, '')
  }
  if (!/^[\w.-]{1,80}$/.test(handle) || handle === '.' || handle === '..') throw fail('BOOSTY_AUTHOR_REQUIRED', 'A Boosty author handle is required')
  return handle.toLowerCase()
}
function integer(value, fallback, min, max, field) {
  if (value == null) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail('BOOSTY_CATALOG_SCOPE_INVALID', `Invalid ${field}`)
  return value
}
function normalizeRequest(args = {}) {
  if (args.auth_mode !== 'public') throw fail('BOOSTY_PUBLIC_MODE_REQUIRED', 'This API supports explicit auth_mode: public only; no account fallback')
  if (['download_media', 'thumbnails', 'transcribe', 'index', 'save_video'].some(k => args[k] === true)
      || ['authCookie', 'cookie', 'token', 'engine'].some(k => args[k] != null)) throw fail('BOOSTY_METADATA_ONLY_REQUIRED', 'Metadata-only API: no credentials, media, ASR or indexing')
  if (typeof args.request_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(args.request_id)) throw fail('BOOSTY_REQUEST_ID_REQUIRED', 'A stable request_id is required')
  const handle = authorHandle(args.handle || args.url || args.target)
  if (args.order != null && !['asc', 'desc'].includes(args.order)) throw fail('BOOSTY_CATALOG_SCOPE_INVALID', 'Invalid order')
  const tags = args.tags == null ? [] : args.tags
  if (!Array.isArray(tags) || tags.length > 100 || tags.some(n => !Number.isSafeInteger(n) || n <= 0)) throw fail('BOOSTY_CATALOG_SCOPE_INVALID', 'Invalid tags')
  for (const k of ['only_allowed', 'tiers_only']) if (args[k] != null && typeof args[k] !== 'boolean') throw fail('BOOSTY_CATALOG_SCOPE_INVALID', `Invalid ${k}`)
  const out = { handle, target: `https://boosty.to/${handle}`, auth_mode: 'public', metadata_only: true,
    origin: 'mcp', autoCopy: false, download_media: false, thumbnails: false,
    request_id: args.request_id, public_job_id: `boosty-catalog:${args.request_id}`,
    limit: integer(args.limit, 0, 0, 100000, 'limit'), order: args.order || 'desc',
    page_size: integer(args.page_size, 100, 1, 100, 'page_size'),
    max_pages: integer(args.max_pages, 1000, 1, 10000, 'max_pages'),
    from_ts: integer(args.from_ts, null, 1, 4102444800, 'from_ts'),
    to_ts: integer(args.to_ts, null, 1, 4102444800, 'to_ts'),
    tags: [...new Set(tags)].sort((a, b) => a - b), only_allowed: args.only_allowed === true, tiers_only: args.tiers_only === true }
  if (out.from_ts && out.to_ts && out.from_ts > out.to_ts) throw fail('BOOSTY_CATALOG_SCOPE_INVALID', 'from_ts must not exceed to_ts')
  return out
}
const requestKey = params => JSON.stringify(Object.fromEntries(Object.entries(params).filter(([k]) => !['request_id', 'public_job_id'].includes(k))))
const unfiltered = p => p.limit === 0 && !p.from_ts && !p.to_ts && !p.tags.length && !p.only_allowed && !p.tiers_only
function prices(value) {
  return Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([k, v]) => /^[A-Z]{3}$/.test(k) && number(v) != null).sort(([a], [b]) => a.localeCompare(b)))
}
function tier(value) {
  if (!value || typeof value !== 'object') return null
  const period = value.price_period ?? value.period
  return { id: id(value.id), name: text(value.name), price: number(value.price),
    currency_prices: prices(value.currency_prices || value.currencyPrices),
    is_archived: bool(value.is_archived ?? value.isArchived), is_hidden: bool(value.is_hidden ?? value.isHidden), deleted: bool(value.deleted),
    price_period: typeof period === 'string' ? text(period, 80) : number(period),
    price_period_provenance: typeof period === 'string' || number(period) != null ? 'upstream_period' : 'not_exposed' }
}
function projectPost(value, handle) {
  const postId = id(value?.post_id)
  if (!postId) return null
  const access = bool(value.has_access)
  const counters = Object.fromEntries(Object.entries(value.content_counters || {}).filter(([k, v]) => /^[a-z_]{1,40}$/.test(k) && number(v) != null))
  const videos = (Array.isArray(value.videos) ? value.videos : []).map(v => ({ video_id: id(v.video_id), kind: ['ok_video', 'video'].includes(v.kind) ? v.kind : 'video',
    title: text(v.title), position: number(v.position), duration_sec: number(v.duration_sec) }))
  const result = { post_id: postId, external_id: `post:${postId}`, canonical_url: `https://boosty.to/${handle}/posts/${postId}`,
    title: text(value.title, 5000), created_at: number(value.created_at), publish_time: number(value.publish_time), updated_at: number(value.updated_at),
    has_access: access, access_state: access === true ? 'public_access' : access === false ? 'locked_for_anonymous' : 'unknown',
    access_scope: 'public_anonymous', account_entitlement_verified: false,
    subscription_level: tier(value.subscription_level), post_price: number(value.price ?? value.post_price), post_currency_prices: prices(value.currency_prices || value.post_currency_prices),
    is_pinned: bool(value.is_pinned), is_published: bool(value.is_published), is_deleted: bool(value.is_deleted), is_blocked: bool(value.is_blocked),
    tags: (Array.isArray(value.tags) ? value.tags : []).map(t => ({ id: id(t.id), title: text(t.title) })),
    content_counters: counters, content_counters_available: value.content_counters_available !== false,
    declared_video_count: value.content_counters_available === false ? null : number(value.declared_video_count) ?? ((counters.video || 0) + (counters.ok_video || 0)),
    visible_video_count: videos.length, identified_video_count: videos.filter(v => v.video_id).length,
    videos, duration_availability: videos.length ? 'only_exposed_media_nodes' : 'not_exposed', metadata_only: true }
  return { ...result, metadata_hash: hash(result) }
}
function projectTiers(value = {}) {
  const status = ['available', 'empty', 'unavailable', 'not_checked'].includes(value.status) ? value.status : 'not_checked'
  return { status, complete: value.complete === true, tiers: (Array.isArray(value.tiers) ? value.tiers : []).map(tier).filter(Boolean),
    next_id: id(value.next_id), stop_reason: text(value.stop_reason, 100), http_status: number(value.http_status), scope: 'public_anonymous' }
}

module.exports = { fail, authorHandle, normalizeRequest, requestKey, unfiltered, projectPost, projectTiers, hash }
