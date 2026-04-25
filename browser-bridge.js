// HTTP-bridge для browser-extension → Electron
//
// Расширение SC Browser Parser шлёт сюда «забрать видео» / «добери транскрипт».
// Только loopback (127.0.0.1) и только заранее известные origin'ы (сайты
// которые мы покрываем content-script'ами). Никакого стороннего доступа.
//
// Эндпоинты:
//   POST /yt-add        { url, withComments?, lang?, engine? }
//                       → cache-first lookup. Hit → { fromCache:true,
//                         cached_file_path, cached_comments_file_path? }
//                         Miss → запускает yt_transcribe + опц. yt_comments,
//                         возвращает { jobId, commentsJobId? }
//   GET  /yt-status?id&wait=N → { status, file_path?, comments_file_path?,
//                           transcript_text?, comments_text?, yt_stage?,
//                           yt_engine?, error? }
//                         text-поля присутствуют только когда обе стадии done,
//                         чтобы расширение могло одним запросом получить готовое.
//                         yt_stage = searching|subs_found|awaiting_ai|
//                         transcribing|transcribed (нужен extension'у для
//                         осмысленного toast'а: «Ищу субтитры…» vs «Запрос к
//                         Gemini…»). yt_engine = gemini|assemblyai (только
//                         после transcribe_start).
//                         wait=ms (опц., 1..25000) — long-poll: держим ответ
//                         пока (status, yt_stage, yt_engine, comments_status)
//                         не изменится либо до тайм-аута. Альтернатива
//                         alarm-polling'у в SW (6с минимум), убирает 0-6с
//                         задержку между «sc-desktop сохранил» и «pill done».
//   POST /yt-resume-ai  { id, engine? } → дёргает resumeYoutubeAi для job'а
//                       зависшего в awaiting_ai. Используется автоматически
//                       background tracker'ом расширения (юзеру negde нажать
//                       «продолжить через AI» — это фоновый flow).
//   GET  /yt-fetch?path → { text, file_path } — read готового файла из
//                         Library без оборота через job (для cache-hit'ов)
//   GET  /healthz       → { ok:true } для overlay'я в расширении
//
// Порт прибит на 53127 — расширение знает его наизусть, без discovery. Если
// порт занят — предполагаем, что уже запущен другой инстанс sc-desktop, и
// логируем без падения main process'а (UI продолжает работать без расширения).

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = 53127
// host_permissions расширения — синхронизировано с manifest.json
const ALLOWED_ORIGINS = new Set([
  'https://www.youtube.com',
  'https://m.youtube.com',
  'https://aistudio.google.com',
])

function setCors(req, res) {
  const origin = req.headers.origin || ''
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Max-Age', '600')
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf-8')
    req.on('data', chunk => { data += chunk; if (data.length > 64 * 1024) req.destroy() })
    req.on('end',  () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

function safeReadFile(fp, maxBytes = 4 * 1024 * 1024) {
  if (!fp) return null
  try {
    const st = fs.statSync(fp)
    if (st.size > maxBytes) return null   // не пытаемся отдать многомегабайтный blob через JSON
    return fs.readFileSync(fp, 'utf-8')
  } catch { return null }
}

function startServer({ jobRunner }) {
  const server = http.createServer(async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    let url
    try { url = new URL(req.url, `http://127.0.0.1:${PORT}`) }
    catch { return sendJson(res, 400, { error: 'bad url' }) }

    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, version: 1 })
      }

      if (req.method === 'POST' && url.pathname === '/yt-add') {
        const body = await readBody(req)
        const targetUrl = String(body.url || '').trim()
        if (!/^https?:\/\/(www\.|m\.)?youtube\.com\/watch\?v=/.test(targetUrl) &&
            !/^https?:\/\/youtu\.be\//.test(targetUrl)) {
          return sendJson(res, 400, { error: 'not a youtube watch url' })
        }
        const lang = (body.lang && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.lang)) ? body.lang : 'ru'

        // Cache-first: если транскрипт уже есть в Library (single-paste,
        // batch-transcribe, items.transcript_path) — не плодим повторный job.
        // Для autoscrape это критично: без этого расширение polls «running»
        // на новый job вместо того чтоб моментально получить готовый text.
        // videoId извлекаем из URL — формат проверен regex'ом выше.
        let videoId = null
        try {
          const u = new URL(targetUrl)
          videoId = u.searchParams.get('v')
        } catch {}

        if (videoId) {
          const cached = jobRunner.lookupYoutubeCache(videoId)
          // Cache HIT может быть двух родов:
          //   - origin='jobs'  → есть полноценный jobId (single-paste row)
          //   - origin='items' → файл есть в Library (записан batch'ем
          //                      или подгружен через канал), id нет
          // В обоих случаях транскрипт уже на диске и НИКАКОГО нового
          // job'а запускать не надо. Расширение получит fromCache:true и
          // полный текст готового файла прямо в этом ответе.
          if (cached && cached.file_path && fs.existsSync(cached.file_path)) {
            console.log(`[BrowserBridge] yt-add ${targetUrl} → cache HIT (origin=${cached.id != null ? 'jobs#' + cached.id : 'items'})`)
            // Комменты считаются отдельно — у них свой кэш-tuple.
            let commentsJobId = null
            let commentsFilePath = null
            if (body.withComments) {
              const commentsCache = jobRunner.lookupYoutubeCommentsCache?.({
                videoId, sort: 'new', limit: 500, includeReplies: false,
              })
              if (commentsCache && commentsCache.file_path && fs.existsSync(commentsCache.file_path)) {
                commentsFilePath = commentsCache.file_path
                if (commentsCache.id != null) commentsJobId = commentsCache.id
              } else {
                commentsJobId = jobRunner.startYoutubeComments({
                  url: targetUrl, sort: 'new', limit: 500, includeReplies: false,
                })
              }
            }
            // Cache-hit clipboard: job-runner.js пишет в clipboard только
            // при event 'saved', а здесь job не запускается → нужно
            // явно скопировать. Если коммент-cache тоже hit — clipboard
            // получает «<транскрипт>\n\n<коммент-блок>». Если коммент
            // ушёл в job (miss) — копируем только транскрипт сейчас,
            // итоговая склейка остаётся на стороне расширения (autoscrape
            // уже умеет concat, см. main() в aistudio-autoscrape.js). Юзер
            // ждал «нажал → в буфере появилось».
            try {
              const { clipboard } = require('electron')
              const transcriptText = fs.readFileSync(cached.file_path, 'utf-8')
              let txt = transcriptText
              if (commentsFilePath) {
                try { txt += '\n\n' + fs.readFileSync(commentsFilePath, 'utf-8') } catch {}
              }
              clipboard.writeText(txt)
              console.log(`[BrowserBridge] cache-hit copied to clipboard: ${txt.length} chars`)
              // Edge-case: транскрипт-cache HIT, но comments — MISS и
              // запущен свежий comments-job. Через минуту его 'saved' event
              // в job-runner.js перезапишет clipboard ОДНИМИ комментами,
              // затирая транскрипт. Подписываемся: ждём done → склеиваем
              // обратно. Без этого юзер через минуту получает в буфере
              // только комменты.
              if (commentsJobId && !commentsFilePath) {
                const off = jobRunner.subscribe(j => {
                  if (!j || j.id !== commentsJobId) return
                  if (j.status === 'error' || j.status === 'cancelled') {
                    try { off() } catch {}
                    return
                  }
                  if (j.status === 'done' && j.file_path) {
                    try {
                      let combined = transcriptText + '\n\n' + fs.readFileSync(j.file_path, 'utf-8')
                      clipboard.writeText(combined)
                      console.log(`[BrowserBridge] cache-hit + late-comments combined to clipboard: ${combined.length} chars`)
                    } catch (e2) {
                      console.log(`[BrowserBridge] late-comments clipboard write failed: ${e2?.message || e2}`)
                    }
                    try { off() } catch {}
                  }
                })
              }
            } catch (e) {
              console.log(`[BrowserBridge] cache-hit clipboard write failed: ${e?.message || e}`)
            }
            return sendJson(res, 200, {
              jobId: cached.id || null,
              commentsJobId,
              fromCache: true,
              cached_file_path: cached.file_path,
              cached_comments_file_path: commentsFilePath,
            })
          }
        }

        const jobId = jobRunner.startYoutubeSingle({ url: targetUrl, lang })

        let commentsJobId = null
        if (body.withComments) {
          // sort=new, limit=500, replies=false — те же дефолты что у YouTubeSingleForm
          // (paste-flow). Расширение пока тоже не различает.
          commentsJobId = jobRunner.startYoutubeComments({
            url: targetUrl,
            sort: 'new',
            limit: 500,
            includeReplies: false,
          })
        }
        // Live + withComments: оба job'а независимо пишут в clipboard на
        // 'saved'. Второй (comments) затирает первый — итог: в буфере
        // только комменты, без транскрипта. Подписываемся на оба и при
        // обоих done переписываем clipboard склейкой.
        if (commentsJobId) {
          ;(() => {
            let savedTranscript = null
            let savedComments = null
            const off = jobRunner.subscribe(j => {
              if (!j) return
              if (j.id === jobId && j.status === 'done' && j.file_path) {
                savedTranscript = j.file_path
              }
              if (j.id === commentsJobId && j.status === 'done' && j.file_path) {
                savedComments = j.file_path
              }
              if (j.status === 'error' || j.status === 'cancelled') {
                if (j.id === jobId || j.id === commentsJobId) { try { off() } catch {} }
                return
              }
              if (savedTranscript && savedComments) {
                try {
                  const { clipboard } = require('electron')
                  let txt = fs.readFileSync(savedTranscript, 'utf-8')
                  txt += '\n\n' + fs.readFileSync(savedComments, 'utf-8')
                  clipboard.writeText(txt)
                  console.log(`[BrowserBridge] live transcript+comments combined to clipboard: ${txt.length} chars`)
                } catch (e) {
                  console.log(`[BrowserBridge] combined clipboard write failed: ${e?.message || e}`)
                }
                try { off() } catch {}
              }
            })
          })()
        }
        console.log(`[BrowserBridge] yt-add ${targetUrl} → job=${jobId}${commentsJobId ? ' comments=' + commentsJobId : ''}`)
        return sendJson(res, 200, { jobId, commentsJobId })
      }

      // /yt-resume-ai — пользователь в /yt-add не имеет UI для нажатия
      // «продолжить через AI» когда субтитров не нашлось. Расширение в
      // background tracker'е видит status=awaiting_ai и автоматически
      // дёргает этот endpoint, чтобы job дошёл до transcribe-стадии.
      if (req.method === 'POST' && url.pathname === '/yt-resume-ai') {
        const body = await readBody(req)
        const id = Number(body.id)
        if (!Number.isFinite(id)) return sendJson(res, 400, { error: 'missing id' })
        const engine = (body.engine === 'assemblyai') ? 'assemblyai' : 'gemini'
        const r = jobRunner.resumeYoutubeAi(id, { engine })
        if (!r.ok) return sendJson(res, 409, r)
        console.log(`[BrowserBridge] yt-resume-ai #${id} engine=${engine}`)
        return sendJson(res, 200, { ok: true, engine })
      }

      // /yt-fetch — синхронный fetch произвольного готового файла из Library.
      // Используется autoscrape'ом / tracker'ом когда yt-add вернул
      // fromCache:true с готовым cached_file_path: транскрипт уже на диске,
      // создавать виртуальный job нет смысла. Контракт прост: путь должен
      // быть внутри LIB_ROOT (защита от path-traversal).
      if (req.method === 'GET' && url.pathname === '/yt-fetch') {
        const fp = url.searchParams.get('path')
        if (!fp) return sendJson(res, 400, { error: 'missing path' })
        const libRoot = jobRunner.LIB_ROOT
        const resolved = path.resolve(fp)
        if (!resolved.startsWith(libRoot)) {
          return sendJson(res, 403, { error: 'path outside LIB_ROOT' })
        }
        const text = safeReadFile(resolved)
        if (text == null) return sendJson(res, 404, { error: 'not readable' })
        return sendJson(res, 200, { text, file_path: resolved })
      }

      if (req.method === 'GET' && url.pathname === '/yt-status') {
        const idRaw = url.searchParams.get('id')
        const cidRaw = url.searchParams.get('comments_id')
        const id = idRaw && /^\d+$/.test(idRaw) ? Number(idRaw) : idRaw
        const cid = cidRaw && /^\d+$/.test(cidRaw) ? Number(cidRaw) : null

        const main = id ? jobRunner.getJobDetail(id) : null
        if (!main) return sendJson(res, 404, { error: 'job not found' })

        // Снимок «наблюдаемых» полей. Long-poll отвечает когда ЛЮБОЕ из них
        // изменится — а это покрывает все переходы которые видит расширение
        // (status running→done, yt_stage searching→transcribing→…, engine,
        // comments_status). Сравнение идёт по строке-кортежу (быстрее объекта).
        const buildStatus = () => {
          const m = jobRunner.getJobDetail(id)
          if (!m) return null
          const s = {
            status: m.status,
            file_path: m.file_path || null,
            yt_stage: m.yt?.stage || null,
            yt_engine: m.yt?.engine || null,
            error: m.error || null,
          }
          if (cid != null) {
            const c = jobRunner.getJobDetail(cid)
            s.comments_status    = c?.status || null
            s.comments_file_path = c?.file_path || null
            s.comments_error     = c?.error || null
          }
          return s
        }
        const tupleOf = (s) => s == null ? '' :
          [s.status, s.yt_stage, s.yt_engine, s.error,
           s.comments_status, s.comments_error, s.file_path, s.comments_file_path].join('|')

        const enrich = (s) => {
          if (s == null) return s
          const transcriptReady = s.status === 'done' && s.file_path && fs.existsSync(s.file_path)
          const commentsReady   = cid == null
            ? true
            : s.comments_status === 'done' && s.comments_file_path && fs.existsSync(s.comments_file_path)
          if (transcriptReady && commentsReady) {
            s.transcript_text = safeReadFile(s.file_path)
            if (cid != null) s.comments_text = safeReadFile(s.comments_file_path)
          }
          return s
        }

        const initial = buildStatus()
        const initialTuple = tupleOf(initial)

        const waitRaw = parseInt(url.searchParams.get('wait') || '0', 10)
        const wait = Number.isFinite(waitRaw) ? Math.max(0, Math.min(25000, waitRaw)) : 0

        // Терминальные состояния — отдаём сразу. transcribed-without-comments
        // тоже терминал если cid не передан.
        const transcriptReadyNow = initial.status === 'done' && initial.file_path && fs.existsSync(initial.file_path)
        const commentsReadyNow   = cid == null
          ? true
          : initial.comments_status === 'done' && initial.comments_file_path && fs.existsSync(initial.comments_file_path)
        const errored = initial.status === 'error' || initial.comments_status === 'error'
        if (wait === 0 || errored || (transcriptReadyNow && commentsReadyNow)) {
          return sendJson(res, 200, enrich(initial))
        }

        // Long-poll: подписываемся на job-events, на любое emit'ивание
        // job'а — пересобираем снимок и сравниваем. Различие → ответ.
        let resolved = false
        const finish = (snapshot) => {
          if (resolved) return
          resolved = true
          try { off() } catch {}
          clearTimeout(timer)
          req.off('close', onClose)
          if (!res.writableEnded) sendJson(res, 200, enrich(snapshot))
        }
        const off = jobRunner.subscribe(j => {
          if (j && j.id !== id && j.id !== cid) return
          const snap = buildStatus()
          if (tupleOf(snap) !== initialTuple) finish(snap)
        })
        const onClose = () => {
          if (resolved) return
          resolved = true
          try { off() } catch {}
          clearTimeout(timer)
        }
        req.on('close', onClose)
        const timer = setTimeout(() => finish(buildStatus()), wait)
        return
      }

      return sendJson(res, 404, { error: 'not found' })
    } catch (err) {
      console.log(`[BrowserBridge] error ${err?.message || err}`)
      return sendJson(res, 500, { error: String(err?.message || err) })
    }
  })

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[BrowserBridge] port ${PORT} занят — другой инстанс sc-desktop уже слушает, расширение работать не будет`)
    } else {
      console.log(`[BrowserBridge] server error: ${err.message}`)
    }
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[BrowserBridge] listening on 127.0.0.1:${PORT}`)
  })

  return server
}

module.exports = { startServer, PORT }
