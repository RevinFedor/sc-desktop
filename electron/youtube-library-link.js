'use strict'

// Link an app-owned, already completed result to an EXISTING catalog item.
// No network, worker, file copy, source creation or embedding side effect.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { stripTranscriptHeader } = require('./youtube-semantic')

function failure(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status })
}

function videoIdFromUrl(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) return null
    const id = host === 'youtu.be' ? url.pathname.split('/')[1]
      : url.pathname === '/watch' ? url.searchParams.get('v')
        : /^\/(?:shorts|live|embed)\/([^/]+)/.exec(url.pathname)?.[1]
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null
  } catch { return null }
}

function createYoutubeLibraryLink({ db, libRoot }) {
  function associations(videoId) {
    return db.getDb().prepare(`
      SELECT i.id AS item_id, i.source_id, i.external_id AS video_id, i.type,
             i.url, i.title, i.transcript_path, i.transcribe_status,
             s.external_id AS channel_id, s.handle, s.display_name AS channel_title
        FROM items i JOIN sources s ON s.id=i.source_id
       WHERE s.platform='youtube' AND i.external_id=? ORDER BY i.source_id,i.id
    `).all(videoId)
  }

  function readResult(item) {
    if (item?.platform !== 'youtube') throw failure('YOUTUBE_IMPORT_REQUIRED', 'A YouTube import is required', 422)
    const videoId = videoIdFromUrl(item.url)
    if (!videoId || videoId !== item.externalId) throw failure('VIDEO_ID_MISMATCH', 'Import URL and video identity disagree')
    if (item.status !== 'done') throw failure('RESULT_NOT_READY', 'Import is not done')
    if (!item.resultFile) throw failure('RESULT_FILE_MISSING', 'Import has no result file')
    let filename, raw
    try {
      const root = fs.realpathSync(libRoot)
      filename = fs.realpathSync(item.resultFile)
      const relative = path.relative(root, filename)
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw failure('RESULT_OUTSIDE_LIBRARY', 'Result is outside the application Library')
      }
      if (fs.lstatSync(item.resultFile).isSymbolicLink()) throw failure('RESULT_SYMLINK', 'Result symlinks cannot be linked')
      if (!fs.statSync(filename).isFile()) throw failure('RESULT_NOT_FILE', 'Result is not a regular file')
      raw = fs.readFileSync(filename, 'utf8')
    } catch (error) {
      if (error.code?.startsWith('RESULT_')) throw error
      throw failure('RESULT_FILE_UNAVAILABLE', 'The saved result file is unavailable')
    }
    const header = raw.split(/\r?\n\r?\n/, 1)[0]
    const headerUrl = /^url:\s*(\S+)\s*$/m.exec(header)?.[1]
    if (!header.startsWith('# ') || videoIdFromUrl(headerUrl) !== videoId) {
      throw failure('TRANSCRIPT_IDENTITY_UNVERIFIED', 'Saved transcript header does not prove this video identity')
    }
    const source = /^source:\s*(\S+)\s*$/m.exec(header)?.[1]
    const engine = source === 'subs' ? 'subs' : /^ai:([a-z0-9_-]+)$/i.exec(source || '')?.[1]
    const boundary = /\r?\n\r?\n/.exec(raw)
    if (!engine || !boundary || !raw.slice(boundary.index + boundary[0].length).trim() || !stripTranscriptHeader(raw)) {
      throw failure('TRANSCRIPT_CONTENT_INVALID', 'Saved transcript has no supported text body/provenance')
    }
    return { filename, raw, engine, videoId, sha256: crypto.createHash('sha256').update(raw).digest('hex') }
  }

  function inspect(item) {
    const videoId = videoIdFromUrl(item?.url)
    if (item?.platform !== 'youtube' || !videoId || videoId !== item.externalId) {
      throw failure('VIDEO_ID_MISMATCH', 'A matching YouTube import URL/video identity is required', 422)
    }
    let result = null, resultError = null
    try { result = readResult(item) } catch (error) { resultError = error.code }
    const rows = associations(videoId)
    return {
      import_id: item.id || null,
      video_id: videoId,
      import_status: item.status,
      result: result ? { available: true, sha256: result.sha256, total_chars: result.raw.length, engine: result.engine }
        : { available: false, code: resultError },
      associations: rows.map(row => ({
        item_id: row.item_id, source_id: row.source_id, channel_id: row.channel_id,
        handle: row.handle, channel_title: row.channel_title, title: row.title, type: row.type,
        transcript_path_present: !!row.transcript_path,
        transcript_file_available: !!row.transcript_path && fs.existsSync(row.transcript_path),
        // Existing index SELECT eligibility, not ready RAG coverage.
        index_path_eligible: row.transcript_path != null,
        linked_to_import_result: !!result && !!row.transcript_path && path.resolve(row.transcript_path) === result.filename,
      })),
      association_lookup_complete: true,
      rag_index_started: false,
    }
  }

  function link(item, args = {}) {
    const sourceId = Number(args.source_id)
    const channelId = String(args.expected_channel_id || '')
    const expectedHash = String(args.expected_result_sha256 || '').toLowerCase()
    if (!Number.isSafeInteger(sourceId) || sourceId < 1 || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)
        || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw failure('LINK_PROOF_REQUIRED', 'source_id, expected_channel_id and expected_result_sha256 are required', 422)
    }
    const result = readResult(item)
    if (result.sha256 !== expectedHash) throw failure('RESULT_HASH_CHANGED', 'Saved result changed; reread its state before linking')
    return db.getDb().transaction(() => {
      const row = associations(result.videoId).find(candidate => Number(candidate.source_id) === sourceId)
      if (!row || row.type !== 'video' || row.channel_id !== channelId
          || (row.url && videoIdFromUrl(row.url) !== result.videoId)) {
        throw failure('CATALOG_IDENTITY_MISMATCH', 'Existing catalog item does not match the requested channel/video')
      }
      let idempotent = false
      if (row.transcript_path) {
        let previous
        try { previous = fs.readFileSync(row.transcript_path, 'utf8') }
        catch { throw failure('EXISTING_TRANSCRIPT_UNAVAILABLE', 'An existing transcript cannot be silently replaced') }
        if (crypto.createHash('sha256').update(previous).digest('hex') !== result.sha256) {
          throw failure('EXISTING_TRANSCRIPT_CONFLICT', 'Catalog item already has a different transcript; it was preserved')
        }
        idempotent = true
      }
      if (readResult(item).sha256 !== result.sha256) throw failure('RESULT_HASH_CHANGED', 'Saved result changed before linking')
      if (!idempotent || row.transcribe_status !== 'done') {
        const updated = db.markItemTranscribed({ source_id: sourceId, external_id: result.videoId,
          transcript_path: result.filename, engine: result.engine })
        if (Number(updated) !== Number(row.item_id)) throw failure('CATALOG_ITEM_CHANGED', 'Catalog item changed before linking')
      }
      return { ok: true, linked: true, idempotent, import_id: item.id || null, item_id: row.item_id,
        source_id: sourceId, channel_id: channelId, video_id: result.videoId,
        result_sha256: result.sha256, index_path_eligible: true, rag_index_started: false }
    }).immediate()
  }

  function linkCached(item) {
    const result = readResult(item)
    const rows = associations(result.videoId).filter(row => row.type === 'video')
    // Never infer ownership from a display name in the TXT header.
    if (rows.length !== 1) return { linked: false, code: rows.length ? 'CATALOG_ASSOCIATION_AMBIGUOUS' : 'CATALOG_ITEM_MISSING' }
    return link(item, { source_id: rows[0].source_id, expected_channel_id: rows[0].channel_id,
      expected_result_sha256: result.sha256 })
  }

  return { inspect, link, linkCached }
}

module.exports = { createYoutubeLibraryLink }
