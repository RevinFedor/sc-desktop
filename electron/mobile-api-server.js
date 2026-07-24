const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const {
  extractInstagramShortcode,
  processInstagramSingleReel,
} = require('./instagram-reel-service')
const {
  matchesBearerToken,
} = require('./local-notification-auth')

const HOST = '127.0.0.1'
const PORT = Number(process.env.SC_MOBILE_PORT || 7898)
const BODY_LIMIT = 64 * 1024
const DATA_ROOT = process.env.SC_DESKTOP_DIR
  || process.env.MEDIA_INBOX_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop')
const TOKEN_PATH = path.join(DATA_ROOT, 'mobile-api-token')
const REQUESTS_PATH = path.join(DATA_ROOT, 'mobile-imports.json')
const MAX_HISTORY = 200

function ensureToken() {
  fs.mkdirSync(DATA_ROOT, { recursive: true, mode: 0o700 })
  try {
    const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim()
    if (/^[a-f0-9]{64}$/i.test(token)) return token
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 })
  fs.chmodSync(TOKEN_PATH, 0o600)
  return token
}

function readRequests() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REQUESTS_PATH, 'utf8'))
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY) : []
  } catch {
    return []
  }
}

function writeRequests(requests) {
  fs.mkdirSync(DATA_ROOT, { recursive: true, mode: 0o700 })
  const tmp = `${REQUESTS_PATH}.${process.pid}.tmp`
  const persisted = requests.slice(0, MAX_HISTORY).map(item => {
    const { resultText, ...rest } = item
    return rest
  })
  fs.writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, REQUESTS_PATH)
}

function youtubeVideoId(rawUrl) {
  try {
    const url = new URL(rawUrl)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    let id = null
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0]
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (url.pathname === '/watch') id = url.searchParams.get('v')
      else {
        const match = /^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(url.pathname)
        id = match?.[1] || null
      }
    }
    return /^[A-Za-z0-9_-]{6,20}$/.test(id || '') ? id : null
  } catch {
    return null
  }
}

function classifyUrl(rawUrl) {
  const url = String(rawUrl || '').trim()
  if (!/^https?:\/\//i.test(url)) return null
  if (extractInstagramShortcode(url)) {
    try {
      const parsed = new URL(url)
      if (/^\/(?:reel|reels|p)\//i.test(parsed.pathname)) {
        return { platform: 'instagram', url, externalId: extractInstagramShortcode(url) }
      }
    } catch {}
  }
  const videoId = youtubeVideoId(url)
  if (videoId) {
    return {
      platform: 'youtube',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      externalId: videoId,
    }
  }
  return null
}

function publicRequest(item) {
  return {
    id: item.id,
    clientRequestId: item.clientRequestId || null,
    platform: item.platform,
    url: item.url,
    externalId: item.externalId || null,
    title: item.title || null,
    status: item.status,
    stage: item.stage || null,
    progress: Number.isFinite(item.progress) ? item.progress : null,
    error: item.error || null,
    resultReady: item.status === 'done' && !!item.resultFile,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('request body is too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function startMobileApiServer({ db, jobRunner, readScSettings }) {
  const token = ensureToken()
  const requests = readRequests()
  for (const item of requests) {
    if (item.status === 'queued' || item.status === 'running' || item.status === 'awaiting_ai') {
      item.status = 'error'
      item.stage = 'interrupted'
      item.error = 'SC Desktop был перезапущен во время обработки. Запустите ссылку ещё раз.'
      item.updatedAt = new Date().toISOString()
    }
  }
  try { writeRequests(requests) } catch {}
  const listeners = new Set()
  let persistTimer = null

  function persistSoon() {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      try { writeRequests(requests) } catch (err) {
        console.warn(`[MobileAPI] history persist failed: ${err?.message || err}`)
      }
    }, 150)
  }

  function emit(item) {
    item.updatedAt = new Date().toISOString()
    persistSoon()
    const data = `event: import\ndata: ${JSON.stringify(publicRequest(item))}\n\n`
    for (const response of listeners) {
      try { response.write(data) } catch { listeners.delete(response) }
    }
  }

  function addRequest(input, classified) {
    const duplicate = input.clientRequestId
      ? requests.find(item => item.clientRequestId === input.clientRequestId)
      : null
    if (duplicate) return { item: duplicate, duplicate: true }
    const now = new Date().toISOString()
    const item = {
      id: crypto.randomUUID(),
      clientRequestId: String(input.clientRequestId || '').trim() || null,
      platform: classified.platform,
      url: classified.url,
      externalId: classified.externalId,
      title: null,
      status: 'queued',
      stage: 'queued',
      progress: 0,
      error: null,
      resultFile: null,
      jobId: null,
      createdAt: now,
      updatedAt: now,
    }
    requests.unshift(item)
    requests.splice(MAX_HISTORY)
    emit(item)
    return { item, duplicate: false }
  }

  function finishWithFile(item, filePath, title) {
    if (!filePath || !fs.existsSync(filePath)) {
      item.status = 'error'
      item.stage = 'error'
      item.error = 'Транскрипт завершён, но файл результата не найден'
    } else {
      item.status = 'done'
      item.stage = 'done'
      item.progress = 1
      item.resultFile = filePath
      item.title = title || item.title
      item.error = null
    }
    emit(item)
  }

  async function startInstagram(item) {
    item.status = 'running'
    item.stage = 'preparing'
    emit(item)
    try {
      const result = await processInstagramSingleReel({
        db,
        jobRunner,
        readScSettings,
        url: item.url,
        engine: 'gemini',
        onStarted: (jobId, plan) => {
          item.jobId = jobId
          item.stage = 'transcribing'
          item.title = plan?.title || null
          emit(item)
        },
        onProgress: snap => {
          item.stage = snap?.status === 'running' ? 'transcribing' : (snap?.status || item.stage)
          if (Number(snap?.items_total) > 0) {
            item.progress = Math.max(0, Math.min(1, Number(snap.items_done || 0) / Number(snap.items_total)))
          }
          emit(item)
        },
      })
      if (result?.ok && result?.file_path) {
        finishWithFile(item, result.file_path, result.title)
      } else {
        item.status = 'error'
        item.stage = 'error'
        item.error = result?.error || 'Не удалось обработать Instagram-ссылку'
        emit(item)
      }
    } catch (err) {
      item.status = 'error'
      item.stage = 'error'
      item.error = String(err?.message || err)
      emit(item)
    }
  }

  function startYoutube(item) {
    const cached = jobRunner.lookupYoutubeCache(item.externalId)
    if (cached?.file_path) {
      finishWithFile(item, cached.file_path)
      return
    }
    item.jobId = jobRunner.startYoutubeSingle({ url: item.url, lang: 'ru' })
    item.status = 'running'
    item.stage = 'searching_subtitles'
    emit(item)
  }

  const unsubscribe = jobRunner.subscribe(snap => {
    const matching = requests.filter(item => item.jobId != null && Number(item.jobId) === Number(snap?.id))
    for (const item of matching) {
      if (snap.status === 'done') {
        finishWithFile(item, snap.file_path, snap.yt?.title)
      } else if (snap.status === 'awaiting_ai') {
        item.status = 'awaiting_ai'
        item.stage = 'awaiting_ai'
        item.error = null
        emit(item)
      } else if (snap.status === 'error' || snap.status === 'cancelled') {
        item.status = snap.status
        item.stage = snap.status
        item.error = snap.error || null
        emit(item)
      } else if (item.platform === 'youtube') {
        item.status = 'running'
        item.stage = snap.yt?.stage || 'running'
        emit(item)
      }
    }
  })

  const server = http.createServer(async (req, res) => {
    let url
    try { url = new URL(req.url, `http://${HOST}:${PORT}`) }
    catch { return sendJson(res, 400, { ok: false, error: 'bad URL' }) }

    if (!matchesBearerToken(req.headers.authorization, token)) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' })
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/me') {
        return sendJson(res, 200, {
          ok: true,
          capabilities: ['instagram_single', 'youtube_single', 'youtube_resume_ai', 'events'],
        })
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        })
        res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        listeners.add(res)
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n') } catch {}
        }, 20_000)
        req.on('close', () => {
          clearInterval(heartbeat)
          listeners.delete(res)
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/imports') {
        return sendJson(res, 200, { ok: true, imports: requests.map(publicRequest) })
      }

      if (req.method === 'POST' && url.pathname === '/api/imports') {
        const body = await readJson(req)
        const classified = classifyUrl(body.url)
        if (!classified) {
          return sendJson(res, 422, {
            ok: false,
            error: 'Поддерживаются одиночные Instagram Reel/Post и YouTube-видео',
          })
        }
        const { item, duplicate } = addRequest(body, classified)
        if (!duplicate) {
          if (classified.platform === 'instagram') void startInstagram(item)
          else startYoutube(item)
        }
        return sendJson(res, duplicate ? 200 : 202, { ok: true, import: publicRequest(item) })
      }

      const match = /^\/api\/imports\/([0-9a-f-]+)(?:\/(result|resume-ai|cancel))?$/.exec(url.pathname)
      if (match) {
        const item = requests.find(candidate => candidate.id === match[1])
        if (!item) return sendJson(res, 404, { ok: false, error: 'import not found' })
        const action = match[2]

        if (req.method === 'GET' && !action) {
          return sendJson(res, 200, { ok: true, import: publicRequest(item) })
        }
        if (req.method === 'GET' && action === 'result') {
          if (item.status !== 'done' || !item.resultFile) {
            return sendJson(res, 409, { ok: false, error: 'result is not ready' })
          }
          const resolved = path.resolve(item.resultFile)
          const root = `${path.resolve(jobRunner.LIB_ROOT)}${path.sep}`
          if (!resolved.startsWith(root) || !fs.existsSync(resolved)) {
            return sendJson(res, 404, { ok: false, error: 'result file not found' })
          }
          return sendJson(res, 200, { ok: true, text: fs.readFileSync(resolved, 'utf8') })
        }
        if (req.method === 'POST' && action === 'resume-ai') {
          if (item.platform !== 'youtube' || item.status !== 'awaiting_ai') {
            return sendJson(res, 409, { ok: false, error: 'import is not awaiting AI confirmation' })
          }
          const result = jobRunner.resumeYoutubeAi(item.jobId, { engine: 'gemini' })
          if (!result?.ok) return sendJson(res, 409, result)
          item.status = 'running'
          item.stage = 'transcribing'
          emit(item)
          return sendJson(res, 202, { ok: true, import: publicRequest(item) })
        }
        if (req.method === 'POST' && action === 'cancel') {
          if (item.jobId != null) jobRunner.cancelJob(item.jobId)
          item.status = 'cancelled'
          item.stage = 'cancelled'
          emit(item)
          return sendJson(res, 200, { ok: true, import: publicRequest(item) })
        }
      }

      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      console.warn(`[MobileAPI] ${req.method} ${url.pathname} failed: ${err?.message || err}`)
      return sendJson(res, err?.status || 500, { ok: false, error: err?.message || 'internal error' })
    }
  })

  server.listen(PORT, HOST, () => {
    console.log(`[MobileAPI] listening on http://${HOST}:${PORT}; token=${TOKEN_PATH}`)
  })
  server.on('error', err => console.warn(`[MobileAPI] server error: ${err?.message || err}`))

  return {
    port: PORT,
    tokenPath: TOKEN_PATH,
    close() {
      unsubscribe?.()
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
        try { writeRequests(requests) } catch {}
      }
      for (const response of listeners) {
        try { response.end() } catch {}
      }
      listeners.clear()
      server.close()
    },
  }
}

module.exports = {
  HOST,
  PORT,
  TOKEN_PATH,
  classifyUrl,
  startMobileApiServer,
  youtubeVideoId,
}
