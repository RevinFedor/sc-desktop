'use strict'

const fs = require('node:fs')
const path = require('node:path')

function invalid(message, code = 'INVALID_TELEGRAM_MEDIA_POLICY') {
  throw Object.assign(new Error(message), { code })
}

function validateTelegramFetchPolicy(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) invalid('fetch params must be an object')
  const out = { ...params }
  for (const name of ['full_history', 'reuse_transcripts', 'download_profile_photo']) {
    if (out[name] != null && typeof out[name] !== 'boolean') invalid(`${name} must be boolean`)
  }
  if (out.expected_account_id != null && (!Number.isSafeInteger(out.expected_account_id) || out.expected_account_id <= 0)) invalid('expected_account_id must be a positive safe integer')
  if (out.expected_peer_id != null && (!Number.isSafeInteger(out.expected_peer_id) || out.expected_peer_id === 0)) invalid('expected_peer_id must be a nonzero marked Telegram ID: positive user, negative basic chat, -100-prefixed channel/supergroup')
  if (out.transcribe_engine != null && !['soniox', 'assemblyai', 'gemini'].includes(out.transcribe_engine)) invalid('transcribe_engine must be soniox/assemblyai/gemini')
  for (const name of ['source_id', 'source_id_hint', '_source_id']) {
    if (out[name] != null && (!Number.isSafeInteger(out[name]) || out[name] <= 0)) invalid(`${name} must be a positive local source ID`)
  }
  if (out.voice_types != null) {
    if (!Array.isArray(out.voice_types) || !out.voice_types.length ||
        out.voice_types.some(x => !['voice', 'audio', 'video'].includes(x))) invalid('voice_types must contain voice/audio/video')
    out.voice_types = [...new Set(out.voice_types)]
  }
  if (out.voice_max_duration_sec != null && (typeof out.voice_max_duration_sec !== 'number' ||
      !Number.isFinite(out.voice_max_duration_sec) || out.voice_max_duration_sec <= 0)) invalid('voice_max_duration_sec must be positive seconds')
  if (out.media_cache_dir != null && (typeof out.media_cache_dir !== 'string' ||
      out.media_cache_dir.includes('\0') || !path.isAbsolute(out.media_cache_dir) ||
      path.resolve(out.media_cache_dir) === path.parse(out.media_cache_dir).root)) invalid('media_cache_dir must be an absolute owned directory')
  if (out.media_min_free_bytes != null && (!Number.isSafeInteger(out.media_min_free_bytes) || out.media_min_free_bytes < 1048576)) invalid('media_min_free_bytes must be at least 1MiB')
  if (out.request_id != null && (typeof out.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(out.request_id))) invalid('request_id must be a stable 1..128 character key')
  if (out.full_history === true) {
    const narrowed = ['limit', 'sinceMessageId', 'date', 'date_to', 'url', 'message_ids', 'min_id', 'max_id', 'offset_id',
      '_media_only_msg_ids', '_comments_only_post_ids', '_comments_only_source_id'].some(key => out[key] != null)
    if (out.mode !== 'all' || narrowed || out.skipDupes === true || out.skip_covered === true ||
        (out.topic_ids && out.topic_ids.length)) invalid('full_history requires mode=all with no limit/date/since/topic filter', 'INVALID_FULL_HISTORY_SCOPE')
    out.skipDupes = false
  }
  if (out.message_ids != null && (!Array.isArray(out.message_ids) || !out.message_ids.length || out.message_ids.length > 5000 ||
      out.message_ids.some(x => !Number.isSafeInteger(x) || x < 1))) invalid('message_ids must contain 1..5000 positive IDs')
  return out
}

// Synchronous worker-side primitive. Electron Main must use the bounded
// telegram-media-storage-check service: permission prompts/stat/mkdir can stall.
function checkTelegramMediaStorage(directory, minFreeBytes = 268435456, fileSystem = fs) {
  const clean = path.resolve(validateTelegramFetchPolicy({ media_cache_dir: directory, media_min_free_bytes: minFreeBytes }).media_cache_dir)
  let volume = null, mounted = null
  const checkMount = () => {
    if (!volume) return
    const current = fileSystem.statSync(volume)
    if (current.dev === fileSystem.statSync('/Volumes').dev ||
        (mounted && (current.dev !== mounted.dev || current.ino !== mounted.ino))) invalid('Selected media volume is not mounted', 'MEDIA_STORAGE_UNAVAILABLE')
    mounted ||= current
  }
  try {
  if (clean.startsWith('/Volumes/')) {
    volume = path.join('/Volumes', clean.split('/')[2])
    if (!fileSystem.existsSync(volume)) invalid('Selected media volume is not mounted', 'MEDIA_STORAGE_UNAVAILABLE')
    checkMount()
    // Never recursively recreate a disappeared mountpoint on the system disk.
    let parent = volume
    for (const part of path.relative(volume, clean).split(path.sep).filter(Boolean)) {
      checkMount()
      parent = path.join(parent, part)
      if (!fileSystem.existsSync(parent)) fileSystem.mkdirSync(parent, { mode: 0o700 })
    }
  } else {
    fileSystem.mkdirSync(clean, { recursive: true, mode: 0o700 })
  }
  checkMount()
  fileSystem.accessSync(clean, fs.constants.W_OK)
  const stats = fileSystem.statfsSync(clean)
  const free = Number(stats.bavail) * Number(stats.bsize)
  if (!Number.isFinite(free) || free < minFreeBytes) invalid('Selected media directory has insufficient free space', 'MEDIA_STORAGE_UNAVAILABLE')
  const resolved = fileSystem.realpathSync(clean)
  checkMount()
  if (volume) {
    const resolvedVolume = fileSystem.realpathSync(volume)
    if (fileSystem.statSync(clean).dev !== mounted.dev ||
        (resolved !== resolvedVolume && !resolved.startsWith(resolvedVolume + path.sep))) invalid('Selected media directory resolves outside its mounted volume', 'MEDIA_STORAGE_UNAVAILABLE')
  }
  return { directory: resolved, free_bytes: free, min_free_bytes: minFreeBytes, writable: true }
  } catch (error) {
    if (error.code === 'MEDIA_STORAGE_UNAVAILABLE') throw error
    invalid(`Selected media storage is unavailable (${error.code || 'filesystem error'})`, 'MEDIA_STORAGE_UNAVAILABLE')
  }
}

function telegramMediaCandidates(database, { sourceId, afterItemId = 0, limit = 500,
  voiceTypes = ['voice', 'audio'], maxDurationSec = 1200 } = {}) {
  if (!Number.isSafeInteger(sourceId) || sourceId < 1 || !Number.isSafeInteger(afterItemId) || afterItemId < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid('Candidates require source_id>0, after_item_id>=0, limit 1..1000')
  if (!Array.isArray(voiceTypes) || !voiceTypes.length || voiceTypes.some(kind => !['voice', 'audio'].includes(kind))) invalid('Candidates voice_types may contain voice/audio only')
  if (typeof maxDurationSec !== 'number' || !Number.isFinite(maxDurationSec) || maxDurationSec <= 0) invalid('Candidates max_duration_sec must be positive seconds')
  const types = [...new Set(voiceTypes)]
  return database.getDb().transaction(() => {
    const source = database.getSource(sourceId)
    if (!source || source.platform !== 'telegram') invalid('Telegram source not found')
    const rows = database.getDb().prepare(`SELECT id, external_id, type, duration_seconds, transcribe_status,
      transcribe_engine, transcript_path, raw_meta_json FROM items WHERE source_id=? AND id>?
      AND type IN (${types.map(() => '?').join(',')}) ORDER BY id LIMIT ?`).all(sourceId, afterItemId, ...types, limit + 1)
    const complete = rows.length <= limit, page = rows.slice(0, limit)
    const counts = { scanned: page.length, eligible: 0, skipped_unknown_duration: 0, skipped_over_duration: 0, already_transcribed: 0 }
    const metadata = page.map(row => {
      let media = null
      try { media = JSON.parse(row.raw_meta_json || '{}').media?.[0] } catch {}
      const itemDuration = row.duration_seconds, mediaDuration = media?.duration_seconds
      const fromItem = typeof itemDuration === 'number' && Number.isFinite(itemDuration) && itemDuration > 0
      const fromMedia = typeof mediaDuration === 'number' && Number.isFinite(mediaDuration) && mediaDuration > 0
      // Telegram's file metadata is authoritative; the generic item column
      // may carry an older/provider-derived duration from another pipeline.
      const duration = fromMedia ? mediaDuration : fromItem ? itemDuration : null
      const skip = duration == null ? 'unknown_duration' : duration > maxDurationSec ? 'duration_exceeded' : null
      if (skip === 'unknown_duration') counts.skipped_unknown_duration++
      else if (skip) counts.skipped_over_duration++
      else counts.eligible++
      const transcribed = row.transcribe_status === 'done'
      if (transcribed) counts.already_transcribed++
      return { item_id: row.id, external_id: row.external_id, type: row.type, duration_seconds: duration,
        duration_source: fromMedia ? 'media_metadata' : fromItem ? 'item' : 'unknown', eligible: skip == null, skip_reason: skip,
        transcribe_status: row.transcribe_status, transcribe_engine: row.transcribe_engine,
        transcript_saved: Boolean(row.transcript_path), transcribed }
    })
    return { source_id: sourceId, after_item_id: afterItemId, limit, voice_types: types,
      max_duration_sec: maxDurationSec, scope: 'saved_local_media_metadata_only', rows: metadata,
      candidates: metadata.filter(row => row.eligible), counts,
      next_item_id: complete ? null : page.at(-1).id, complete }
  }).deferred()
}

module.exports = { validateTelegramFetchPolicy, checkTelegramMediaStorage, telegramMediaCandidates }
