'use strict'

const crypto = require('node:crypto')

const DEFAULT_TARGET_CHARS = 3200
const DEFAULT_OVERLAP_CHARS = 420
const MIN_CHUNK_CHARS = 600

function stripTranscriptHeader(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim()
  if (!text) return ''
  const boundary = text.indexOf('\n\n')
  if (boundary === -1) return text
  const header = text.slice(0, boundary)
  if (!header.startsWith('# ') || !/^url:\s+/m.test(header)) return text
  return text.slice(boundary + 2).trim()
}

function timestampSeconds(value) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(String(value || '').trim())
  if (!match) return null
  const millis = Number(String(match[4] || '').padEnd(3, '0')) || 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + millis / 1000
}

function normaliseBody(body) {
  const markers = []
  const parts = []
  let length = 0
  for (const line of String(body || '').split('\n')) {
    const match = /^\[(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\]\s*(.*)$/.exec(line.trim())
    const value = match ? match[2].trim() : line.trim()
    if (!value) continue
    if (parts.length) length += 1
    if (match) {
      const seconds = timestampSeconds(match[1])
      if (seconds != null) markers.push({ offset: length, seconds })
    }
    parts.push(value)
    length += value.length
  }
  return { text: parts.join('\n'), markers }
}

function alignedEnd(text, start, target) {
  const hard = Math.min(text.length, start + target)
  if (hard >= text.length) return text.length
  const floor = Math.min(text.length, start + Math.floor(target * 0.72))
  const newline = text.lastIndexOf('\n', hard)
  if (newline >= floor) return newline
  const sentence = Math.max(
    text.lastIndexOf('. ', hard),
    text.lastIndexOf('! ', hard),
    text.lastIndexOf('? ', hard),
  )
  if (sentence >= floor) return sentence + 1
  const space = text.lastIndexOf(' ', hard)
  return space >= floor ? space : hard
}

function markerAt(markers, offset) {
  let found = null
  for (const marker of markers) {
    if (marker.offset > offset) break
    found = marker.seconds
  }
  return found
}

function chunkTranscript(raw, {
  durationSeconds = null,
  targetChars = DEFAULT_TARGET_CHARS,
  overlapChars = DEFAULT_OVERLAP_CHARS,
} = {}) {
  const body = stripTranscriptHeader(raw)
  const normalised = normaliseBody(body)
  const text = normalised.text
  if (!text) return { documentHash: null, text: '', chunks: [] }

  const target = Math.max(MIN_CHUNK_CHARS, Number(targetChars) || DEFAULT_TARGET_CHARS)
  const overlap = Math.max(0, Math.min(target - 200, Number(overlapChars) || 0))
  const duration = Number(durationSeconds)
  const hasDuration = Number.isFinite(duration) && duration > 0
  const chunks = []
  let start = 0

  while (start < text.length) {
    const end = alignedEnd(text, start, target)
    const value = text.slice(start, end).trim()
    if (value) {
      const exactStart = markerAt(normalised.markers, start)
      const exactEnd = markerAt(normalised.markers, Math.max(start, end - 1))
      const approximate = exactStart == null
      const startSeconds = exactStart != null
        ? exactStart
        : hasDuration ? Math.round(duration * start / text.length) : null
      const endSeconds = exactEnd != null && exactEnd > (startSeconds || 0)
        ? exactEnd
        : hasDuration ? Math.round(duration * end / text.length) : null
      chunks.push({
        chunk_index: chunks.length,
        start_char: start,
        end_char: end,
        start_seconds: startSeconds,
        end_seconds: endSeconds,
        position_approximate: approximate,
        text: value,
      })
    }
    if (end >= text.length) break
    const next = Math.max(start + 1, end - overlap)
    const aligned = text.indexOf(' ', next)
    start = aligned !== -1 && aligned < end ? aligned + 1 : next
  }

  const documentHash = crypto.createHash('sha256').update(text).digest('hex')
  return { documentHash, text, chunks }
}

module.exports = {
  DEFAULT_TARGET_CHARS,
  DEFAULT_OVERLAP_CHARS,
  stripTranscriptHeader,
  timestampSeconds,
  chunkTranscript,
}
