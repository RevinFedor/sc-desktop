'use strict'

// Application-owned comments-only jobs and evidence reader. Saved snapshots
// stay separate from video speech and from the channel transcript index.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const PROFILE = 'youtube-comment-full-body-lexical-v1'
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const parse = raw => { try { return JSON.parse(raw || '{}') } catch { return {} } }
function fail(code, message, status = 409) { throw Object.assign(new Error(message), { code, status }) }
function id(value) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) fail('SOURCE_REQUIRED', 'A positive source_id is required', 422); return n }
function video(value) { if (!/^[A-Za-z0-9_-]{11}$/.test(value || '')) fail('VIDEO_REQUIRED', 'An exact YouTube video_id is required', 422); return value }
function requestId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) fail('REQUEST_ID_REQUIRED', 'A stable request_id is required', 422); return value }

function createYoutubeCommentsControl({ db, jobRunner, libRoot }) {
  const instance = crypto.randomUUID()
  function source(sourceId, channelId) {
    const row = db.getSource(id(sourceId))
    if (!row || row.platform !== 'youtube' || (channelId && row.external_id !== channelId)) {
      fail('CHANNEL_IDENTITY_MISMATCH', 'Existing YouTube source/channel identity does not match')
    }
    return row
  }
  function rowForRequest(key) {
    return db.getDb().prepare(`SELECT * FROM jobs WHERE type='yt_comments'
      AND json_valid(parameters_json) AND json_extract(parameters_json,'$._comments_request_id')=?
      ORDER BY id DESC LIMIT 1`).get(requestId(key))
  }
  function snapshot(row) {
    const p = parse(row.parameters_json)
    if (!p._comments_archive_path || !p._comments_archive_sha256) fail('ARCHIVE_NOT_READY', 'No persisted structured comment original is ready')
    let raw, filename
    try {
      filename = fs.realpathSync(p._comments_archive_path)
      const root = fs.realpathSync(libRoot), relative = path.relative(root, filename)
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
          || fs.lstatSync(p._comments_archive_path).isSymbolicLink()) fail('ARCHIVE_PATH_INVALID', 'Archive is outside the app Library or is a symlink')
      raw = fs.readFileSync(filename)
    } catch (error) {
      if (error.code === 'ARCHIVE_PATH_INVALID') throw error
      fail('ARCHIVE_UNAVAILABLE', 'Persisted comment archive is unavailable')
    }
    if (hash(raw) !== p._comments_archive_sha256) fail('ARCHIVE_HASH_CHANGED', 'Persisted comment original changed; it was not silently reused')
    const value = parse(raw.toString('utf8'))
    const owner = source(row.source_id, p._comments_expected_channel_id)
    if (value.version !== 1 || value.video_id !== p.video_id || value.channel_id !== owner.external_id
        || !Array.isArray(value.comments) || value.params?.limit !== 0 || value.params?.include_replies !== true) {
      fail('ARCHIVE_IDENTITY_MISMATCH', 'Comment archive video/channel/shape does not match its reserved job')
    }
    const complete = value.report?.remote_eof === true
      && value.report?.eof_proof === 'all_root_and_reply_continuations_exhausted_v1'
      && !value.report?.warnings?.length
      && !value.report?.missing_parent_ids?.length && !value.report?.duplicate_conflicts?.length
      && !value.report?.unidentified_indices?.length
    return { row, p, owner, value, filename, raw_text: raw.toString('utf8'), snapshot_hash: hash(raw), complete }
  }
  function status(args) {
    const row = rowForRequest(args.request_id)
    if (!row) fail('COMMENTS_REQUEST_NOT_FOUND', 'No accepted comments request with this identity', 404)
    const p = parse(row.parameters_json)
    let state = row.status
    const live = p._comments_app_instance === instance
      ? jobRunner.getJobDetail?.(p._comments_desktop_job_id) : null
    const boundLive = live?.params?._comments_request_id === args.request_id ? live : null
    if (['pending', 'running', 'cancelling'].includes(state) && !boundLive) state = 'launch_or_completion_unknown'
    const out = { request_id: args.request_id, db_job_id: row.id, desktop_job_id: boundLive?.id || null,
      source_id: row.source_id, video_id: p.video_id, status: state, persisted_status: row.status,
      live: !!boundLive, items_done: boundLive?.items_done || row.items_done || 0,
      error: row.error || null, completion_is_persisted: !['pending', 'running', 'cancelling'].includes(row.status),
      outcome_unknown: state === 'launch_or_completion_unknown' || String(row.error || '').startsWith('COMMENTS_LAUNCH_UNKNOWN:'),
      search_profile: PROFILE, semantic_embeddings: false }
    if (row.status === 'done') {
      try {
        const saved = snapshot(row)
        out.archive = { snapshot_hash: saved.snapshot_hash, path: saved.filename, report: saved.value.report,
          comments: saved.value.comments.length, complete: saved.complete }
      } catch (error) { out.archive_error = { code: error.code, message: error.message } }
    }
    return out
  }
  function archives(sourceIds, videoIds = null) {
    const ids = sourceIds.map(id)
    if (!ids.length) fail('SOURCE_REQUIRED', 'At least one source_id is required', 422)
    ids.forEach(sid => source(sid))
    const rows = db.getDb().prepare(`SELECT * FROM jobs WHERE type='yt_comments' AND status='done'
      AND source_id IN (${ids.map(() => '?').join(',')}) AND json_valid(parameters_json)
      AND json_extract(parameters_json,'$._comments_archive_sha256') IS NOT NULL ORDER BY id DESC`).all(...ids)
    const seen = new Set(), saved = [], errors = []
    for (const row of rows) {
      const p = parse(row.parameters_json), key = `${row.source_id}:${p.video_id}`
      if (videoIds && !videoIds.includes(p.video_id)) continue
      if (seen.has(key)) continue
      seen.add(key)
      try { saved.push(snapshot(row)) }
      catch (error) { errors.push({ source_id: row.source_id, video_id: p.video_id, code: error.code }) }
    }
    return { saved, errors }
  }
  function state(args) {
    const owner = source(args.source_id, args.expected_channel_id)
    const ids = [...new Set((args.video_ids || []).map(video))]
    if (!ids.length || ids.length > 100) fail('VIDEOS_REQUIRED', '1..100 video_ids are required', 422)
    const data = archives([owner.id], ids)
    const legacy = db.findYoutubeCommentsByVideoIds(ids)
    return { source_id: owner.id, channel_id: owner.external_id, enumeration_complete: true,
      search_profile: PROFILE, videos: ids.map(vid => {
        const saved = data.saved.find(s => s.value.video_id === vid)
        const error = data.errors.find(e => e.video_id === vid)
        return { video_id: vid, structured_available: !!saved, complete: saved?.complete || false,
          snapshot_hash: saved?.snapshot_hash || null, comment_count: saved?.value.comments.length ?? null,
          report: saved?.value.report || null, archive_error: error || null,
          legacy_text_available: !!legacy.get(vid), legacy_completeness: 'not_proven_by_flat_txt' }
      }) }
  }
  function start(args) {
    const key = requestId(args.request_id), vid = video(args.video_id)
    const owner = source(args.source_id, args.expected_channel_id)
    if (!/^UC[A-Za-z0-9_-]{22}$/.test(args.expected_channel_id || '')) fail('CHANNEL_PROOF_REQUIRED', 'expected_channel_id is required', 422)
    // The machine contract is fixed: ALL comments + replies, no speech/media.
    const canonical = { source_id: owner.id, video_id: vid, channel_id: owner.external_id,
      sort: 'new', limit: 0, include_replies: true, origin: 'mcp', autoCopy: false, archive_version: 1 }
    const payloadHash = hash(JSON.stringify(canonical))
    const old = rowForRequest(key)
    if (old) {
      if (parse(old.parameters_json)._comments_payload_hash !== payloadHash) fail('REQUEST_PAYLOAD_MISMATCH', 'request_id already belongs to another immutable scope')
      return { accepted: true, idempotent: true, ...status({ request_id: key }) }
    }
    const unresolved = db.getDb().prepare(`SELECT * FROM jobs WHERE type='yt_comments'
      AND source_id=? AND json_valid(parameters_json)
      AND json_extract(parameters_json,'$.video_id')=?
      AND json_extract(parameters_json,'$._comments_request_id') IS NOT NULL
      AND (status IN ('pending','running','cancelling') OR error LIKE 'COMMENTS_LAUNCH_UNKNOWN:%')
      ORDER BY id DESC LIMIT 1`).get(owner.id, vid)
    if (unresolved) fail('COMMENTS_PREVIOUS_OUTCOME_UNKNOWN', 'An earlier request for this video is unresolved; recover its original identity, not a new key')
    const cache = archives([owner.id], [vid]).saved.find(s => s.complete)
    if (cache) return { accepted: false, reused: true, complete: true, source_id: owner.id,
      video_id: vid, original_request_id: cache.p._comments_request_id, snapshot_hash: cache.snapshot_hash }
    const active = jobRunner.listJobs().filter(j => ['yt_comments', 'yt_batch_comments'].includes(j.type)
      && ['pending', 'running', 'cancelling'].includes(j.status))
    if (active.length) fail('COMMENTS_PRODUCER_BUSY', 'Another YouTube comment producer is active; keep collection sequential')
    const archivePath = path.join(libRoot, 'transcripts', 'youtube_comments', 'originals', `${vid}__${hash(key)}.json`)
    const params = { ...canonical, url: `https://www.youtube.com/watch?v=${vid}`, includeReplies: true,
      _comments_request_id: key, _comments_payload_hash: payloadHash,
      _comments_expected_channel_id: owner.external_id, _comments_source_id: owner.id,
      _comments_archive_path: archivePath, _comments_app_instance: instance }
    const reserved = db.getDb().transaction(() => {
      const existing = rowForRequest(key)
      if (existing) return { existing: true, row: existing }
      return { existing: false, row_id: db.recordJob({ type: 'yt_comments', source_id: owner.id,
        status: 'pending', items_done: 0, started_at: Math.floor(Date.now() / 1000), params }) }
    }).immediate()
    if (reserved.existing) {
      if (parse(reserved.row.parameters_json)._comments_payload_hash !== payloadHash) fail('REQUEST_PAYLOAD_MISMATCH', 'request_id raced with a different scope')
      return { accepted: true, idempotent: true, ...status({ request_id: key }) }
    }
    params._comments_db_row_id = reserved.row_id
    try {
      const desktopId = jobRunner.startYoutubeComments(params)
      params._comments_desktop_job_id = desktopId
      const live = jobRunner.getJobDetail(desktopId)
      if (!live || live.params?._comments_request_id !== key) fail('COMMENTS_LAUNCH_UNKNOWN', 'Producer ownership could not be verified; do not repeat the launch')
      // close-handler owns terminal state and may already have committed it.
      const current = rowForRequest(key)
      if (current?.status === 'pending') db.updateJob(reserved.row_id, { status: 'running', params })
      return { accepted: true, idempotent: false, ...status({ request_id: key }) }
    } catch (error) {
      // A thrown launch can still have spawned a child. Never label it safe
      // to resend or allocate a new automatic retry key.
      db.updateJob(reserved.row_id, { status: 'interrupted', params,
        error: `COMMENTS_LAUNCH_UNKNOWN: ${error.message}` })
      throw Object.assign(error, { code: 'COMMENTS_LAUNCH_UNKNOWN', status: 503 })
    }
  }
  function selected(args) {
    const row = rowForRequest(args.request_id)
    if (!row || row.status !== 'done') fail('ARCHIVE_NOT_READY', 'A persisted done comment request is required')
    const saved = snapshot(row)
    if (args.expected_snapshot_hash !== saved.snapshot_hash) fail('SNAPSHOT_HASH_REQUIRED', 'Use the exact snapshot hash from search/state')
    return saved
  }
  function publicComment(saved, row) {
    return { ...row, raw: undefined, source_id: saved.owner.id, channel_id: saved.owner.external_id,
      video_id: saved.value.video_id, video_url: saved.value.video_url,
      comment_url: `${saved.value.video_url}&lc=${encodeURIComponent(row.comment_id)}`,
      request_id: saved.p._comments_request_id, snapshot_hash: saved.snapshot_hash,
      evidence_kind: 'youtube_comment', text_origin: 'saved_public_comment',
      channel_owner_attribution_proven: row.author_is_uploader === true, corpus_complete: saved.complete }
  }
  function original(args) {
    const saved = selected(args)
    const row = saved.value.comments.find(c => c.comment_id === args.comment_id)
    if (!row) fail('COMMENT_NOT_FOUND', 'Comment ID is not in this snapshot', 404)
    const chars = Array.from(String(row.text || ''))
    const offset = Number(args.offset || 0), max = Number(args.max_chars || 16000)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max) || max < 1 || max > 200000) fail('PAGE_INVALID', 'Invalid Unicode codepoint page', 422)
    const end = Math.min(chars.length, offset + max)
    return { ...publicComment(saved, row), text: chars.slice(offset, end).join(''), offset,
      total_chars: chars.length, next_offset: end < chars.length ? end : null,
      truncated: end < chars.length, offsets_unit: 'unicode_codepoints', source_path: saved.filename }
  }
  function archiveOriginal(args) {
    const saved = selected(args), chars = Array.from(saved.raw_text)
    const offset = Number(args.offset || 0), max = Number(args.max_chars || 50000)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max) || max < 1 || max > 200000) fail('PAGE_INVALID', 'Invalid archive Unicode page', 422)
    const end = Math.min(chars.length, offset + max)
    return { video_id: saved.value.video_id, channel_id: saved.owner.external_id,
      snapshot_hash: saved.snapshot_hash, source_path: saved.filename,
      format: 'saved_original_json', text: chars.slice(offset, end).join(''),
      offsets_unit: 'unicode_codepoints', offset, total_chars: chars.length,
      next_offset: end < chars.length ? end : null, truncated: end < chars.length }
  }
  function thread(args) {
    const saved = selected(args), map = new Map(saved.value.comments.map(c => [c.comment_id, c]))
    const center = map.get(args.comment_id)
    if (!center) fail('COMMENT_NOT_FOUND', 'Comment ID is not in this snapshot', 404)
    let root = center, stop = null; const seen = new Set([root.comment_id])
    while (root.parent_comment_id) {
      if (seen.has(root.parent_comment_id)) { stop = 'cycle'; break }
      if (seen.size >= 100) { stop = 'depth_limit'; break }
      const parent = map.get(root.parent_comment_id)
      if (!parent) { stop = 'missing_parent'; break }
      root = parent; seen.add(root.comment_id)
    }
    const included = new Set([root.comment_id]), rows = [root]
    for (let pass = 0; pass < 100; pass++) {
      let changed = false
      for (const row of saved.value.comments) {
        if (!included.has(row.comment_id) && included.has(row.parent_comment_id)) {
          included.add(row.comment_id); rows.push(row); changed = true
        }
      }
      if (!changed) break
    }
    const offset = Number(args.offset || 0), limit = Number(args.limit || 100)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('PAGE_INVALID', 'Invalid thread page', 422)
    return { video_id: saved.value.video_id, snapshot_hash: saved.snapshot_hash,
      center_comment_id: center.comment_id, root_comment_id: root.comment_id,
      ancestor_stop_reason: stop, relation_quality: 'saved_parent_ids',
      corpus_complete: saved.complete, total: rows.length,
      results: rows.slice(offset, offset + limit).map(row => publicComment(saved, row)),
      next_offset: offset + limit < rows.length ? offset + limit : null }
  }
  function search(args) {
    const ids = args.source_ids || [args.source_id]
    const requested = Array.isArray(args.video_ids) ? [...new Set(args.video_ids.map(video))] : null
    const tokens = [...new Set(String(args.query || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [])]
    if (!tokens.length || tokens.length > 32) fail('QUERY_REQUIRED', 'Use 1..32 literal query terms', 422)
    const limit = Number(args.limit || 20), budget = Number(args.budget || 100000)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(budget) || budget < 1 || budget > 1000000) fail('SEARCH_WINDOW_INVALID', 'Invalid limit/budget', 422)
    const data = archives(ids, requested), hits = []
    let scanned = 0, exhausted = false
    outer: for (const saved of data.saved) for (const row of saved.value.comments) {
      if (scanned >= budget) { exhausted = true; break outer }
      scanned++
      const text = String(row.text || '').toLowerCase().normalize('NFKC')
      const matched = tokens.filter(token => text.includes(token))
      if (matched.length && (args.match !== 'all' || matched.length === tokens.length)) {
        hits.push({ ...publicComment(saved, row), matched_terms: matched, lexical_score: matched.length / tokens.length })
      }
    }
    hits.sort((a, b) => b.lexical_score - a.lexical_score || a.source_id - b.source_id
      || a.video_id.localeCompare(b.video_id) || a.comment_id.localeCompare(b.comment_id))
    const availableVideos = new Set(data.saved.map(saved => saved.value.video_id))
    const missing = requested ? requested.filter(vid => !availableVideos.has(vid)) : null
    return { search_profile: PROFILE, search_mode: 'literal_full_body', semantic_embeddings: false,
      score_is_probability: false, scanned_comments: scanned, search_budget_exhausted: exhausted,
      snapshot_count: data.saved.length, archive_errors: data.errors,
      completeness_scope: requested ? 'explicit_requested_video_ids' : 'channel_scope_not_proven',
      missing_requested_video_ids: missing,
      corpus_complete: !!requested?.length && !missing.length && !data.errors.length
        && data.saved.every(saved => saved.complete),
      results: hits.slice(0, limit), returned: Math.min(hits.length, limit),
      next: 'Read original and same-snapshot thread with request_id/comment_id/expected_snapshot_hash; scores are not evidence.' }
  }
  return { start, status, state, search, original, archive: archiveOriginal, thread,
    capabilities: () => ({ comments_only: true, all_requested: true, include_replies: true,
      media_download: false, paid_asr: false, auto_copy: false, durable_request_id: true,
      originals: 'structured_json', search_profile: PROFILE, semantic_embeddings: false,
      remote_eof_proof: 'not_exposed_by_yt_dlp_cli', legacy_txt_is_complete_proof: false }) }
}

module.exports = { createYoutubeCommentsControl, PROFILE }
