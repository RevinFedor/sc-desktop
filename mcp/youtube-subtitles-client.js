const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_WAIT_MS = 25_000
const MAX_WAIT_MS = 45_000
const DEFAULT_MAX_CHARS = 50_000
const MAX_CHARS = 200_000
const ACTIVE_STATUSES = new Set(['queued', 'running'])
const IMPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function integerInRange(value, fallback, minimum, maximum, name) {
  const resolved = value == null ? fallback : Number(value)
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return resolved
}

function normalizeArguments(args = {}) {
  return {
    waitMs: integerInRange(args.wait_ms, DEFAULT_WAIT_MS, 0, MAX_WAIT_MS, 'wait_ms'),
    offset: integerInRange(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
    maxChars: integerInRange(args.max_chars, DEFAULT_MAX_CHARS, 1, MAX_CHARS, 'max_chars'),
  }
}

function paginateText(text, offset, maxChars) {
  const value = String(text || '')
  const start = Math.min(offset, value.length)
  const end = Math.min(start + maxChars, value.length)
  return {
    text: value.slice(start, end),
    offset: start,
    returned_chars: end - start,
    total_chars: value.length,
    next_offset: end < value.length ? end : null,
    truncated: end < value.length,
  }
}

function normalizeYoutubeVideoUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim())
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    let videoId = null
    if (host === 'youtu.be') videoId = url.pathname.split('/').filter(Boolean)[0]
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (url.pathname === '/watch') videoId = url.searchParams.get('v')
      else videoId = /^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(url.pathname)?.[1] || null
    }
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId || '')) return null
    return `https://www.youtube.com/watch?v=${videoId}`
  } catch {
    return null
  }
}

function defaultTokenPath() {
  const dataRoot = process.env.SC_DESKTOP_DIR
    || process.env.MEDIA_INBOX_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop')
  return process.env.SC_DESKTOP_MOBILE_TOKEN_PATH || path.join(dataRoot, 'mobile-api-token')
}

function createYoutubeSubtitlesClient(options = {}) {
  const baseUrl = String(
    options.baseUrl
      || process.env.SC_DESKTOP_MOBILE_URL
      || `http://127.0.0.1:${process.env.SC_MOBILE_PORT || 7898}`,
  ).replace(/\/+$/, '')
  const tokenPath = options.tokenPath || defaultTokenPath()
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const sleep = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const pollIntervalMs = options.pollIntervalMs || 350
  const requestTimeoutMs = options.requestTimeoutMs || 10_000

  if (typeof fetchImpl !== 'function') {
    throw new Error('This runtime does not provide fetch()')
  }

  function readToken() {
    if (options.token) return String(options.token).trim()
    try {
      const token = fs.readFileSync(tokenPath, 'utf8').trim()
      if (token) return token
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        throw new Error(`Cannot read the SC Desktop API token: ${err.message}`)
      }
    }
    throw new Error('SC Desktop API token was not found. Start SC Desktop first.')
  }

  async function request(pathname, { method = 'GET', body } = {}) {
    const token = readToken()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
    let response
    try {
      response = await fetchImpl(`${baseUrl}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
    } catch (err) {
      const message = err?.name === 'AbortError'
        ? 'SC Desktop HTTP API did not respond in time.'
        : 'SC Desktop HTTP API is unavailable. Start SC Desktop and try again.'
      throw new Error(message)
    } finally {
      clearTimeout(timeout)
    }

    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error(`SC Desktop API returned an invalid response (HTTP ${response.status}).`)
    }
    if (!response.ok || payload?.ok === false) {
      const reason = String(payload?.error || `HTTP ${response.status}`)
      throw new Error(`SC Desktop API request failed: ${reason}`)
    }
    return payload
  }

  async function fetchImport(importId) {
    const payload = await request(`/api/imports/${encodeURIComponent(importId)}`)
    if (!payload.import || payload.import.platform !== 'youtube') {
      throw new Error('The requested import is not a YouTube subtitle request.')
    }
    return payload.import
  }

  async function resultFor(item, pagination) {
    if (item.status === 'done') {
      const payload = await request(`/api/imports/${encodeURIComponent(item.id)}/result`)
      return {
        ok: true,
        status: 'done',
        subtitles_found: true,
        import: item,
        ...paginateText(payload.text, pagination.offset, pagination.maxChars),
      }
    }
    if (item.status === 'awaiting_ai') {
      return {
        ok: true,
        status: 'subtitles_not_found',
        subtitles_found: false,
        needs_ai: true,
        import: item,
        message:
          'YouTube did not provide direct or automatic subtitles. Paid AI transcription was not started.',
      }
    }
    if (item.status === 'error') {
      return {
        ok: false,
        status: 'error',
        subtitles_found: false,
        import: item,
        error: item.error || 'YouTube subtitle import failed.',
      }
    }
    if (item.status === 'cancelled') {
      return {
        ok: false,
        status: 'cancelled',
        subtitles_found: false,
        import: item,
      }
    }
    return {
      ok: true,
      status: item.status || 'running',
      subtitles_found: false,
      import: item,
      next: {
        tool: 'youtube_subtitles_status',
        arguments: { import_id: item.id },
      },
    }
  }

  async function waitForResult(item, pagination) {
    const deadline = Date.now() + pagination.waitMs
    let current = item
    while (ACTIVE_STATUSES.has(current.status) && Date.now() < deadline) {
      const remaining = deadline - Date.now()
      await sleep(Math.min(pollIntervalMs, remaining))
      current = await fetchImport(current.id)
    }
    return resultFor(current, pagination)
  }

  async function start(args = {}) {
    const url = normalizeYoutubeVideoUrl(args.url)
    if (!url) throw new Error('url must point to one supported YouTube video')
    const suppliedRequestId = String(args.client_request_id || '').trim()
    if (suppliedRequestId.length > 128) {
      throw new Error('client_request_id must be at most 128 characters')
    }
    const clientRequestId = suppliedRequestId || crypto.randomUUID()
    const pagination = normalizeArguments(args)
    const payload = await request('/api/imports', {
      method: 'POST',
      body: { url, clientRequestId },
    })
    if (!payload.import || payload.import.platform !== 'youtube') {
      throw new Error('client_request_id belongs to a non-YouTube import')
    }
    if (normalizeYoutubeVideoUrl(payload.import.url) !== url) {
      throw new Error('client_request_id already belongs to a different YouTube video')
    }
    return waitForResult(payload.import, pagination)
  }

  async function status(args = {}) {
    const importId = String(args.import_id || '').trim()
    if (!IMPORT_ID_PATTERN.test(importId)) {
      throw new Error('import_id must be the UUID returned by youtube_get_subtitles')
    }
    const pagination = normalizeArguments(args)
    return waitForResult(await fetchImport(importId), pagination)
  }

  async function cancel(args = {}) {
    const importId = String(args.import_id || '').trim()
    if (!IMPORT_ID_PATTERN.test(importId)) {
      throw new Error('import_id must be the UUID returned by youtube_get_subtitles')
    }
    const item = await fetchImport(importId)
    if (!ACTIVE_STATUSES.has(item.status) && item.status !== 'awaiting_ai') {
      throw new Error(`YouTube subtitle import is already ${item.status || 'finished'} and cannot be cancelled`)
    }
    const payload = await request(`/api/imports/${encodeURIComponent(importId)}/cancel`, {
      method: 'POST',
    })
    return {
      ok: true,
      status: payload.import?.status || 'cancelled',
      import: payload.import,
    }
  }

  return { start, status, cancel }
}

module.exports = {
  DEFAULT_MAX_CHARS,
  DEFAULT_WAIT_MS,
  MAX_CHARS,
  MAX_WAIT_MS,
  createYoutubeSubtitlesClient,
  normalizeYoutubeVideoUrl,
  paginateText,
}
