'use strict'

// Saved text only. This adapter never resolves a player, contacts Boosty or
// reads media. The same bounded Unicode splitter and vec corpus serve TG/YT.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { splitCaption } = require('./telegram-rag-index')
const { stripTranscriptHeader, timestampSeconds } = require('./youtube-semantic')
const { MODEL, OUTPUT_DIM } = require('./embedder')

const INDEX_VERSION = `boosty-saved-full-text-v1:${MODEL}:${OUTPUT_DIM}:unit-l2:bytes1360-overlap160`
const sha = text => crypto.createHash('sha256').update(text).digest('hex')
const error = (code, message) => Object.assign(new Error(message), { code })

function savedFile(filename, root) {
  if (!filename) return null
  const base = fs.realpathSync(root)
  const requested = path.resolve(root, filename)
  const relative = path.relative(path.resolve(root), requested)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw error('BOOSTY_TEXT_PATH_REJECTED', 'Saved text must be inside the library')
  try {
    const actual = fs.realpathSync(requested)
    const rel = path.relative(base, actual)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw error('BOOSTY_TEXT_PATH_REJECTED', 'Saved text must be inside the library')
    const stat = fs.statSync(actual)
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw error('BOOSTY_TEXT_FILE_REJECTED', 'Saved text is not a bounded regular file')
    return fs.readFileSync(actual, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw e
  }
}

function parseTimedText(raw) {
  const cues = []
  let text = ''
  for (const block of String(raw || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n')
    const at = lines.findIndex(line => line.includes('-->'))
    if (at < 0) continue
    const [left, right] = lines[at].split(/\s*-->\s*/)
    const start = timestampSeconds(left)
    const end = timestampSeconds(String(right || '').split(/\s+/)[0])
    const value = lines.slice(at + 1).join('\n').replace(/<[^>]+>/g, '').trim()
    if (start == null || end == null || end <= start || !value) continue
    if (text) text += '\n'
    const startChar = text.length
    text += value
    cues.push({ cue_index: cues.length, start_seconds: start, end_seconds: end,
      start_char: startChar, end_char: text.length, text: value, speaker: null })
  }
  return { text, cues }
}

function cueRange(cues, start, end) {
  let low = 0, high = cues.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (cues[mid].end_char <= start) low = mid + 1
    else high = mid
  }
  const first = low
  while (low < cues.length && cues[low].start_char < end) low++
  return first < low ? { first, last: low - 1 } : null
}

function timedRange(doc, chunk) {
  const direct = cueRange(doc.cues, chunk.start_char, chunk.end_char)
  if (direct) return { ...direct, basis: 'direct_saved_srt' }
  if (!doc.cues.length) return null
  // TXT/SRT may differ elsewhere, yet this exact passage can still have a
  // unique counterpart in the SAME saved SRT version. Remove only whitespace,
  // never words/punctuation/case and never use similarity as a timestamp.
  if (!doc._timedAlignment) {
    const end = doc.cues.at(-1).end_char, value = doc.text.slice(0, end), offsets = []
    let normalised = '', at = 0
    for (const point of value) {
      if (!/\s/u.test(point)) {
        normalised += point
        for (let i = 0; i < point.length; i++) offsets.push(at + i)
      }
      at += point.length
    }
    doc._timedAlignment = { normalised, offsets }
  }
  const needle = String(chunk.text || doc.text.slice(chunk.start_char, chunk.end_char)).replace(/\s/gu, '')
  if (needle.length < 80) return null
  const { normalised, offsets } = doc._timedAlignment
  const first = normalised.indexOf(needle)
  if (first < 0 || normalised.indexOf(needle, first + 1) !== -1) return null
  const alignedStart = offsets[first], alignedEnd = offsets[first + needle.length - 1] + 1
  const range = cueRange(doc.cues, alignedStart, alignedEnd)
  return range ? { ...range, basis: 'unique_exact_non_whitespace_in_same_saved_srt',
    aligned_start_char: alignedStart, aligned_end_char: alignedEnd } : null
}

function buildDocument(row, source, root) {
  let text = '', cues = [], rawTxt = null, rawSrt = null, reason = null
  const segments = []
  const kind = row.type === 'boosty_post' ? 'post' : row.type === 'boosty_asset' ? 'asset' : 'transcript'
  let asset = null, originalBinaryHash = null
  if (kind === 'post') {
    text = String(row.caption || '')
    segments.push({ offset: 0, text, representation: 'author_post' })
  }
  else if (kind === 'asset') {
    try { asset = JSON.parse(row.raw_meta_json || '{}') } catch {}
    // A filename/caption is not attachment content. Partial/OCR-pending text
    // stays readable via the asset CLI but is not reported as fully indexed.
    if (asset?.extraction_state !== 'text_extracted_complete') reason = 'asset_text_incomplete_or_unsupported'
    rawTxt = savedFile(row.transcript_path, root)
    text = rawTxt || ''
    if (!reason && !text.trim()) reason = 'asset_saved_text_missing_or_empty'
    if (!reason && !asset?.text_sha256) reason = 'asset_extraction_text_proof_missing'
    if (!reason && sha(rawTxt) !== asset.text_sha256) reason = 'asset_extraction_text_changed'
    if (!reason) {
      try {
        const resolved = row.media_path && fs.realpathSync(row.media_path)
        const rel = resolved && path.relative(fs.realpathSync(root), resolved)
        if (!resolved || rel.startsWith('..') || path.isAbsolute(rel) || fs.statSync(resolved).size > 128 * 1024 * 1024) reason = 'asset_original_missing_or_unsafe'
        else originalBinaryHash = sha(fs.readFileSync(resolved))
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') reason = 'asset_original_missing'
        else throw e
      }
      if (!reason && originalBinaryHash !== asset.original_sha256) reason = 'asset_original_changed_since_extraction'
    }
    segments.push({ offset: 0, text, representation: 'saved_attachment_extracted_text' })
  }
  else {
    rawTxt = savedFile(row.transcript_path, root)
    if (row.transcript_path && /\.txt$/i.test(row.transcript_path)) {
      rawSrt = savedFile(row.transcript_path.replace(/\.txt$/i, '.srt'), root)
    }
    if (rawSrt) ({ text, cues } = parseTimedText(rawSrt))
    if (text) segments.push({ offset: 0, text, representation: 'saved_srt' })
    const txtBody = rawTxt == null ? '' : stripTranscriptHeader(rawTxt)
    if (!text && txtBody) {
      text = txtBody
      segments.push({ offset: 0, text, representation: 'saved_txt' })
    } else if (txtBody && txtBody.replace(/\s+/g, ' ').trim() !== text.replace(/\s+/g, ' ').trim()) {
      // A TXT may contain a tail/alternate ASR wording absent in the SRT.
      // Keep its FULL body, separately labelled and untimed; never silently
      // discard it or invent a cue alignment between two text versions.
      text += '\n\n'
      segments.push({ offset: text.length, text: txtBody, representation: 'saved_txt_unaligned' })
      text += txtBody
    }
    if (!text.trim()) reason = row.transcript_path ? 'saved_transcript_missing_or_empty' : 'no_saved_transcript'
  }
  if (!text.trim()) reason ||= 'no_saved_post_text'
  const provenance = kind === 'asset' ? { kind: 'saved_author_attachment_extracted_text', original_binary_sha256: originalBinaryHash,
    extraction: asset?.extraction_state || 'unknown', speaker: null, is_fedor_employment_evidence: false } : kind === 'post'
    ? { kind: 'saved_author_post', speaker: 'post_author', remote_freshness: 'not_checked' }
    : { kind: 'saved_transcript', engine: row.transcribe_engine || 'unknown',
        speaker: null, speaker_assignment: 'unknown_not_inferred_from_title',
        words_are_asr_or_saved_subtitles_not_verified_verbatim_audio: true }
  // A change to either saved original also invalidates continuations, even if
  // the preferred SRT body stays equal. Cue endpoints are part of the version.
  const fingerprint = { item_id: row.id, source_id: row.source_id, external_id: String(row.external_id),
    parent_external_id: row.parent_external_id || null, kind,
    title: row.title || null, url: row.url || null, published_at: row.published_at || null,
    text_hash: sha(text), txt_hash: rawTxt == null ? null : sha(rawTxt), srt_hash: rawSrt == null ? null : sha(rawSrt),
    provenance, ...(kind === 'asset' ? { asset_id: asset?.asset_id || null, original_binary_sha256: originalBinaryHash,
      page_map: (asset?.pages || []).map(p => ({ page: p.page, text_sha256: p.text_sha256 || null, method: p.method || null })) } : {}) }
  const documentHash = sha(JSON.stringify(fingerprint))
  const chunks = reason ? [] : segments.flatMap(segment => splitCaption(segment.text).map(chunk => ({
    ...chunk, start_char: chunk.start_char + segment.offset, end_char: chunk.end_char + segment.offset,
    representation: segment.representation,
  }))).map((chunk, index) => {
    const range = cueRange(cues, chunk.start_char, chunk.end_char)
    return { ...chunk, chunk_index: index, cue_start: range?.first ?? null, cue_end: range?.last ?? null,
      start_seconds: range ? cues[range.first].start_seconds : null,
      end_seconds: range ? cues[range.last].end_seconds : null,
      position_approximate: false }
  })
  const postId = kind === 'post' ? String(row.external_id) : String(row.parent_external_id || '')
  const postUuid = postId.replace(/^post:/, '')
  const handle = String(source.handle || '').replace(/^@/, '')
  const url = handle && postUuid ? `https://boosty.to/${encodeURIComponent(handle)}/posts/${encodeURIComponent(postUuid)}` : row.url || null
  return { row, source, kind, text, cues, rawTxt, rawSrt, reason, chunks, provenance,
    documentHash, generationId: sha(`${INDEX_VERSION}:${row.id}:${documentHash}`), canonicalUrl: url, postId, postUuid,
    assetPages: kind === 'asset' ? (asset?.pages || []).map(p => p.page).filter(Number.isSafeInteger) : [] }
}

function embeddingText(doc, chunk) {
  // No title/role/salary guesses in vectors. The full target goes first and
  // fits Gemini's ceiling even with multilingual byte fallback tokenisation.
  return `${doc.kind === 'post' ? 'Saved author post' : doc.kind === 'asset' ? 'Saved author attachment; not user employment evidence' : 'Saved transcript; speakers unassigned'}:\n${chunk.text}`
}

function timecode(seconds) {
  if (seconds == null) return null
  const n = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

function identity(doc) {
  return { item_id: doc.row.id, source_id: doc.row.source_id, type: doc.kind,
    post_external_id: doc.postId, post_uuid: doc.postUuid, video_external_id: doc.kind === 'transcript' ? String(doc.row.external_id) : null,
    ...(doc.kind === 'asset' ? { asset_external_id: String(doc.row.external_id).replace(/^asset:/, ''), original_binary_sha256: doc.provenance.original_binary_sha256 } : {}),
    title: doc.row.title || '', published_at: doc.row.published_at || null,
    canonical_url: doc.canonicalUrl, time_query_url_supported: false,
    document_hash: doc.documentHash, text_hash: sha(doc.text), generation_id: doc.generationId,
    index_version: INDEX_VERSION, provenance: doc.provenance,
    time_accuracy: doc.cues.length ? 'saved_cue_exact_not_audio_verified' : 'unavailable',
    cues_total: doc.cues.length, chars: [...doc.text].length,
    transcript_txt_available: doc.rawTxt != null, transcript_srt_available: doc.rawSrt != null }
}

module.exports = { INDEX_VERSION, sha, error, savedFile, parseTimedText, cueRange, timedRange, buildDocument, embeddingText, timecode, identity }
