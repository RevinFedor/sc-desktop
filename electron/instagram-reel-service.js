const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')

const APIFY_LEGACY_PATH = path.join(os.homedir(), '.config', 'sc', 'apify_token')
const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled', 'interrupted'])

function extractInstagramShortcode(input) {
  if (!input) return null
  const raw = String(input).trim()
  const m = raw.match(/(?:^|\/)(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i)
  const code = m ? m[1] : raw
  return code.replace(/[^A-Za-z0-9_-]/g, '') || null
}

function isNumericId(value) {
  return /^\d+$/.test(String(value || ''))
}

function readIgBackends(ig = {}) {
  const legacy = ig.backend
  const legacyMapped = legacy === 'apify' ? 'apify' : (legacy ? 'api' : null)
  return {
    metadata_backend:   ig.metadata_backend === 'apify' ? 'apify' : (ig.metadata_backend ? 'api' : (legacyMapped || 'api')),
    transcribe_backend: ig.transcribe_backend === 'apify' ? 'apify' : 'api',
  }
}

function checkApifyToken(token) {
  const clean = String(token || '').trim()
  if (!clean) {
    return Promise.resolve({ status: 'missing', ok: false, message: 'token not set' })
  }
  return new Promise(resolve => {
    const url = `https://api.apify.com/v2/users/me?token=${encodeURIComponent(clean)}`
    const req = https.get(url, { timeout: 12000 }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({
            status: 'invalid',
            ok: false,
            http_status: res.statusCode,
            message: `HTTP ${res.statusCode}: ${body.slice(0, 160)}`,
          })
          return
        }
        try {
          const data = JSON.parse(body)
          const user = data && data.data || {}
          resolve({
            status: 'valid',
            ok: true,
            http_status: res.statusCode,
            username: user.username || user.id || null,
            message: 'token accepted',
          })
        } catch (err) {
          resolve({ status: 'invalid', ok: false, http_status: res.statusCode, message: `invalid JSON: ${err.message}` })
        }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve({ status: 'error', ok: false, message: 'timeout' }) })
    req.on('error', err => resolve({ status: 'error', ok: false, message: err.message }))
  })
}

async function getInstagramSettings(readScSettings, { transcribeOnly = false } = {}) {
  const s = readScSettings()
  const ig = s.instagram || {}
  let legacyToken = null
  try {
    if (fs.existsSync(APIFY_LEGACY_PATH)) {
      legacyToken = (fs.readFileSync(APIFY_LEGACY_PATH, 'utf8') || '').trim() || null
    }
  } catch {}
  const backends = readIgBackends(ig)
  const token = ig.apify_token || legacyToken || null
  const needsApifyCheck = !transcribeOnly || backends.transcribe_backend === 'apify'
  const apifyTokenCheck = needsApifyCheck
    ? await checkApifyToken(token)
    : { status: 'not_needed', ok: true, message: 'Android API selected' }
  return {
    metadata_backend:   backends.metadata_backend,
    transcribe_backend: backends.transcribe_backend,
    apify_token_set:    !!token,
    apify_token_legacy: !ig.apify_token && !!legacyToken,
    apify_token_check:  apifyTokenCheck,
  }
}

function lookupInstagramReel(db, payload) {
  const raw = String(payload?.shortcode || payload?.url || '').trim()
  const shortcode = extractInstagramShortcode(raw)
  if (!shortcode) return null
  const dbCon = db.getDb()
  const itemHit = dbCon.prepare(
    `SELECT
        i.id AS item_id,
        i.source_id,
        i.external_id,
        i.url,
        i.caption,
        i.title,
        i.duration_seconds,
        i.transcript_path,
        s.handle AS source_handle,
        s.display_name AS source_display_name,
        s.external_id AS source_external_id
       FROM items i
       JOIN sources s ON s.id = i.source_id
      WHERE s.platform = 'instagram'
        AND i.external_id = ?
      ORDER BY i.id DESC
      LIMIT 1`,
  ).get(`reel:${shortcode}`) || null
  if (itemHit) return itemHit

  const rows = dbCon.prepare(
    `SELECT id, file_path, parameters_json, cost_usd, started_at, finished_at
       FROM jobs
      WHERE type = 'ig_batch_transcribe'
        AND status = 'done'
        AND file_path IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 300`,
  ).all()
  for (const row of rows) {
    let params = null
    try { params = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
    const codes = Array.isArray(params?.shortcodes) ? params.shortcodes : []
    if (!codes.includes(shortcode)) continue
    const idx = codes.indexOf(shortcode)
    const captions = Array.isArray(params?.captions) ? params.captions : []
    return {
      item_id: null,
      source_id: null,
      external_id: `reel:${shortcode}`,
      url: params?.target || `https://www.instagram.com/reel/${shortcode}/`,
      caption: captions[idx] || '',
      title: null,
      duration_seconds: null,
      transcript_path: row.file_path,
      source_handle: null,
      source_display_name: null,
      source_external_id: null,
      job_id: row.id,
      cost_usd: row.cost_usd || 0,
      finished_at: row.finished_at || null,
    }
  }
  return null
}

function firstSavedPath(snap) {
  return (snap?.yt_batch?.log || []).find(row => row?.kind === 'ai' && row.file_path)?.file_path || null
}

function waitForJob(jobRunner, jobId, { timeoutMs = 45 * 60 * 1000, onProgress } = {}) {
  return new Promise(resolve => {
    let done = false
    let off = null
    const finish = (snap) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      if (off) off()
      resolve(snap)
    }
    const timer = setTimeout(() => {
      finish({ id: jobId, status: 'timeout', error: 'job timed out' })
    }, timeoutMs)
    timer.unref?.()

    try {
      const current = jobRunner.getJobDetail(jobId)
      if (current) {
        onProgress?.(current)
        if (TERMINAL_STATUSES.has(current.status)) {
          finish(current)
          return
        }
      }
    } catch {}

    off = jobRunner.subscribe(snap => {
      if (!snap || snap.id !== jobId) return
      onProgress?.(snap)
      if (TERMINAL_STATUSES.has(snap.status)) finish(snap)
    })
  })
}

async function planInstagramSingleReel({ db, readScSettings, url, engine = 'gemini' }) {
  const shortcode = extractInstagramShortcode(url)
  if (!shortcode) {
    return { ok: false, code: 'bad_url', error: 'Не удалось распознать Instagram shortcode.' }
  }

  const [settings, cached] = await Promise.all([
    getInstagramSettings(readScSettings, { transcribeOnly: true }),
    Promise.resolve().then(() => lookupInstagramReel(db, { url, shortcode })),
  ])

  if (cached?.transcript_path && fs.existsSync(cached.transcript_path)) {
    console.log(`[InstagramReel] cache hit shortcode=${shortcode} path=${cached.transcript_path}`)
    return {
      ok: true,
      cached: true,
      shortcode,
      settings,
      file_path: cached.transcript_path,
      title: cached.title || cached.caption || null,
    }
  }

  const configuredBackend = settings?.transcribe_backend || 'api'
  const hasLocalOwner = cached?.source_id && isNumericId(cached?.source_external_id)
  const backend = configuredBackend === 'apify' ? 'apify' : 'api'
  const apiResolution = backend === 'api'
    ? (hasLocalOwner ? 'profile_clips' : 'shortcode_session')
    : null
  console.log(`[InstagramReel] plan shortcode=${shortcode} configured_backend=${configuredBackend} has_local_owner=${hasLocalOwner ? 'yes' : 'no'} backend=${backend} resolve=${apiResolution || 'apify'}`)

  if (backend === 'apify' && !settings?.apify_token_check?.ok) {
    return {
      ok: false,
      code: 'apify_token',
      error: settings?.apify_token_set
        ? `Apify-токен не прошёл проверку: ${settings?.apify_token_check?.message || 'unknown error'}`
        : 'Для голой Instagram-ссылки нужен Apify-токен или сначала профильный парсинг.',
      shortcode,
      settings,
    }
  }

  const params = {
    shortcodes: [shortcode],
    captions: [cached?.caption || cached?.title || ''],
    engine,
    backend,
    target: url,
    ...(apiResolution ? { api_resolution: apiResolution } : {}),
  }
  if (backend === 'api' && hasLocalOwner) {
    params.source_id = cached.source_id
    params.user_id = String(cached.source_external_id)
  }
  return { ok: true, cached: false, shortcode, settings, backend, params, title: cached?.title || cached?.caption || null }
}

async function processInstagramSingleReel({ db, jobRunner, readScSettings, url, engine = 'gemini', onStarted, onProgress }) {
  const plan = await planInstagramSingleReel({ db, readScSettings, url, engine })
  if (!plan.ok) return plan
  if (plan.cached) return plan

  let jobId = null
  try {
    jobId = jobRunner.startInstagramBatchTranscribe(plan.params)
  } catch (err) {
    return {
      ok: false,
      code: 'start_failed',
      error: String(err?.message || err),
      shortcode: plan.shortcode,
    }
  }

  onStarted?.(jobId, plan)
  const snap = await waitForJob(jobRunner, jobId, { onProgress })
  const filePath = snap?.file_path || firstSavedPath(snap)
  if (snap?.status === 'done' && filePath && fs.existsSync(filePath)) {
    return {
      ok: true,
      cached: false,
      shortcode: plan.shortcode,
      backend: plan.backend,
      engine,
      job: snap,
      file_path: filePath,
      title: plan.title || snap?.yt_batch?.current?.title || null,
    }
  }

  return {
    ok: false,
    code: snap?.status || 'job_failed',
    error: snap?.error || `Instagram job finished without transcript file (${snap?.status || 'unknown'})`,
    shortcode: plan.shortcode,
    job: snap,
  }
}

module.exports = {
  extractInstagramShortcode,
  readIgBackends,
  checkApifyToken,
  getInstagramSettings,
  lookupInstagramReel,
  planInstagramSingleReel,
  processInstagramSingleReel,
}
