// Gemini-based text embedder. Used by the semantic indexer + the search MCP
// tool. Reads GEMINI_API_KEY from process.env or shared settings.json.
//
// Why Gemini and not a local model:
//   • No npm rebuild / no native compile / no 500MB ONNX model in RAM.
//   • The user already trusts Gemini with their chat content (transcription
//     pipeline). Adding embeddings doesn't widen the privacy surface.
//   • Quality on multilingual / Russian IT-slang is competitive with the best
//     open models per MTEB (April 2026).
//
// Trade-off: each query+index call pays ~100-300ms latency. For batches of
// 100 messages the throughput is ~1000 msgs/min on the free tier — fine for
// 10k-100k corpora; would not scale to 10M.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MODEL = 'gemini-embedding-001'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`
const OUTPUT_DIM = 768

let _apiKey = null

function readScSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'sc', 'settings.json'), 'utf8'))
  } catch {
    return {}
  }
}

function settingValue(settings, paths) {
  for (const parts of paths) {
    let cur = settings
    let ok = true
    for (const part of parts) {
      if (!cur || typeof cur !== 'object' || !(part in cur)) {
        ok = false
        break
      }
      cur = cur[part]
    }
    if (ok && cur != null && String(cur).trim()) return String(cur).trim()
  }
  return null
}

function loadApiKey() {
  if (_apiKey) return _apiKey
  if (process.env.GEMINI_API_KEY) {
    _apiKey = process.env.GEMINI_API_KEY
    return _apiKey
  }
  const settings = readScSettings()
  _apiKey = settingValue(settings, [
    ['api_keys', 'GEMINI_API_KEY'],
    ['api', 'gemini_api_key'],
  ])
  if (_apiKey) return _apiKey

  if (!_apiKey) throw new Error('GEMINI_API_KEY not found in env or ~/.config/sc/settings.json')
  return _apiKey
}

/**
 * Normalise a Float32Array in place to unit L2 length. Required because
 * gemini-embedding-001 only auto-normalises at the default 3072 dimensions —
 * truncated MRL outputs (e.g. 768) come back unnormalised, which would skew
 * cosine distance.
 */
function l2Normalise(vec) {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i]
  if (sum === 0) return vec
  const inv = 1 / Math.sqrt(sum)
  for (let i = 0; i < vec.length; i++) vec[i] *= inv
  return vec
}

/**
 * Embed up to 100 texts in one HTTP call. Returns Float32Array[] aligned to
 * input order. taskType lets the model bias the representation: documents
 * stored in the corpus use RETRIEVAL_DOCUMENT, search-time queries use
 * RETRIEVAL_QUERY. (Mixing them silently degrades recall.)
 *
 * Retries once on 429/5xx with a 2s backoff — for sustained rate-limit hits
 * the indexer caller should also throttle batches.
 */
async function embedBatch(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  if (!texts || !texts.length) return []
  if (texts.length > 100) throw new Error(`embedBatch: max 100 per call, got ${texts.length}`)
  const apiKey = loadApiKey()

  const body = {
    requests: texts.map(t => ({
      model: `models/${MODEL}`,
      content: { parts: [{ text: t || ' ' }] }, // empty text → 400; pad with space
      taskType,
      outputDimensionality: OUTPUT_DIM,
    })),
  }

  // Retry with exponential backoff on 429/5xx. Free tier limits the embed
  // model to roughly 100 req/min — when we hit it Google returns 429 with a
  // retryDelay hint inside the error JSON. We parse it; if missing, we use
  // a 2,4,8,16,32,60-second schedule (capped).
  const MAX_ATTEMPTS = 6
  let lastErr = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const json = await res.json()
        const out = (json.embeddings || []).map(e => {
          const arr = new Float32Array(e.values || [])
          l2Normalise(arr)
          return arr
        })
        if (out.length !== texts.length) {
          throw new Error(`Gemini returned ${out.length} embeddings for ${texts.length} inputs`)
        }
        return out
      }
      const txt = await res.text().catch(() => '')
      if (res.status === 429 || res.status >= 500) {
        // Google sends RetryInfo inside error.details with retryDelay like "47s"
        let waitMs = Math.min(60000, 2000 * Math.pow(2, attempt))
        try {
          const j = JSON.parse(txt)
          const retry = j?.error?.details?.find?.(d => d['@type']?.includes('RetryInfo'))
          const m = /(\d+)s/.exec(retry?.retryDelay || '')
          if (m) waitMs = Math.min(120000, (parseInt(m[1], 10) + 1) * 1000)
        } catch {}
        console.warn(`[Embedder] ${res.status} attempt ${attempt + 1}/${MAX_ATTEMPTS}, waiting ${waitMs}ms`)
        lastErr = new Error(`Gemini ${res.status}: ${txt.slice(0, 200)}`)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      // Non-retryable (400/401/403)
      throw new Error(`Gemini ${res.status}: ${txt.slice(0, 200)}`)
    } catch (err) {
      // Network glitch — retry too, with same backoff schedule.
      lastErr = err
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, Math.min(60000, 2000 * Math.pow(2, attempt))))
      }
    }
  }
  throw lastErr || new Error('embedBatch: unknown failure')
}

/**
 * Single-text shortcut for the search path. Always RETRIEVAL_QUERY.
 */
async function embedQuery(text) {
  const out = await embedBatch([text], 'RETRIEVAL_QUERY')
  return out[0]
}

module.exports = { embedBatch, embedQuery, OUTPUT_DIM, MODEL }
