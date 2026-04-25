const WebSocket = require('ws')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const BRIDGE_PORT = 3458
const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`
const BRIDGE_PATH = path.join(__dirname, 'browser', 'bridge.js')
const BRIDGE_LOG = '/tmp/hh-extension-bridge.log'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function probePort(port) {
  return new Promise(resolve => {
    const sock = net.createConnection({ port, host: '127.0.0.1' })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
    sock.setTimeout(600, () => { sock.destroy(); resolve(false) })
  })
}

async function ensureBridgeRunning() {
  if (await probePort(BRIDGE_PORT)) return
  if (!fs.existsSync(BRIDGE_PATH)) {
    throw new Error(`browser bridge not found at ${BRIDGE_PATH}`)
  }
  const out = fs.openSync(BRIDGE_LOG, 'a')
  const child = spawn(process.execPath, [BRIDGE_PATH], {
    cwd: path.dirname(BRIDGE_PATH),
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1' },
  })
  child.unref()
  for (let i = 0; i < 20; i++) {
    await sleep(150)
    if (await probePort(BRIDGE_PORT)) return
  }
  throw new Error(`browser bridge did not start; see ${BRIDGE_LOG}`)
}

class BrowserBridgeClient {
  constructor({ timeoutMs = 180000 } = {}) {
    this.timeoutMs = timeoutMs
    this.ws = null
    this.seq = 0
    this.pending = new Map()
  }

  async connect() {
    await ensureBridgeRunning()
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(BRIDGE_URL)
      const timer = setTimeout(() => {
        try { ws.terminate() } catch {}
        reject(new Error('browser bridge connect timeout'))
      }, 5000)
      ws.on('open', () => {
        clearTimeout(timer)
        this.ws = ws
        resolve()
      })
      ws.on('message', raw => {
        let msg = null
        try { msg = JSON.parse(raw.toString()) } catch { return }
        const id = msg.commandId
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        clearTimeout(p.timer)
        if (msg.success === false) p.reject(new Error(msg.error || 'browser command failed'))
        else p.resolve(msg)
      })
      ws.on('close', () => {
        this.ws = null
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error('browser bridge closed'))
        }
        this.pending.clear()
      })
      ws.on('error', err => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  async close() {
    try { this.ws?.close() } catch {}
    this.ws = null
  }

  command(payload, timeoutMs = this.timeoutMs) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('browser bridge is not connected'))
    }
    const commandId = ++this.seq
    const body = { commandId, ...payload }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId)
        reject(new Error(`browser command ${payload.action} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(commandId, { resolve, reject, timer })
      this.ws.send(JSON.stringify(body))
    })
  }

  async newTab(url, { background = true } = {}) {
    const r = await this.command({ action: 'mcp_new_tab', url, background })
    if (!r.tabId) throw new Error('mcp_new_tab returned no tabId')
    return r.tabId
  }

  async navigate(tabId, url) {
    return this.command({ action: 'mcp_navigate', tabId, url }, 30000)
  }

  async waitForSelector(tabId, selector, timeout = 15000) {
    return this.command({
      action: 'mcp_wait_for_selector',
      tabId,
      selector,
      timeout,
      visible: true,
    }, timeout + 5000)
  }

  async evaluateRaw(tabId, code, { async = true, maxDepth = 8, timeoutMs = this.timeoutMs } = {}) {
    const r = await this.command({
      action: 'mcp_evaluate_raw',
      tabId,
      code,
      async,
      maxDepth,
    }, timeoutMs)
    return r.result ?? null
  }

  async closeTab(tabId) {
    if (!tabId) return
    try { await this.command({ action: 'mcp_close_tab', tabId }, 10000) } catch {}
  }
}

function cleanUser(value) {
  const s = String(value || '').trim().replace(/^@+/, '')
  return s ? s.replace(/[^\w]/g, '') : ''
}

function cleanDate(value) {
  const s = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

function quotePhrase(value) {
  const s = String(value || '').trim()
  if (!s) return ''
  return `"${s.replace(/"/g, '\\"')}"`
}

function positiveOperator(name, value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? `${name}:${Math.floor(n)}` : ''
}

function buildTwitterQuery(args = {}) {
  const parts = []
  const query = String(args.query || '').trim()
  if (query) parts.push(query)
  const exact = quotePhrase(args.exact_phrase)
  if (exact) parts.push(exact)
  if (args.any_words) {
    const words = Array.isArray(args.any_words)
      ? args.any_words
      : String(args.any_words).split(/[,\s]+/)
    const clean = words.map(w => String(w || '').trim()).filter(Boolean)
    if (clean.length === 1) parts.push(clean[0])
    else if (clean.length > 1) parts.push(`(${clean.join(' OR ')})`)
  }
  if (args.exclude_words) {
    const words = Array.isArray(args.exclude_words)
      ? args.exclude_words
      : String(args.exclude_words).split(/[,\s]+/)
    for (const w of words) {
      const clean = String(w || '').trim()
      if (clean) parts.push(`-${clean}`)
    }
  }
  const from = cleanUser(args.from_user)
  const to = cleanUser(args.to_user)
  const mention = cleanUser(args.mention_user || args.mentions)
  if (from) parts.push(`from:${from}`)
  if (to) parts.push(`to:${to}`)
  if (mention) parts.push(`@${mention}`)
  const since = cleanDate(args.since)
  const until = cleanDate(args.until)
  if (since) parts.push(`since:${since}`)
  if (until) parts.push(`until:${until}`)
  const lang = String(args.lang || '').trim().toLowerCase()
  if (/^[a-z]{2}(-[a-z]{2})?$/.test(lang)) parts.push(`lang:${lang}`)
  const minFaves = positiveOperator('min_faves', args.min_likes ?? args.min_faves)
  const minReplies = positiveOperator('min_replies', args.min_replies)
  const minRetweets = positiveOperator('min_retweets', args.min_retweets ?? args.min_reposts)
  if (minFaves) parts.push(minFaves)
  if (minReplies) parts.push(minReplies)
  if (minRetweets) parts.push(minRetweets)
  if (args.only_replies) parts.push('filter:replies')
  else if (args.exclude_replies) parts.push('-filter:replies')
  if (args.only_links) parts.push('filter:links')
  if (args.only_media) parts.push('filter:media')
  if (args.only_images) parts.push('filter:images')
  if (args.only_videos) parts.push('filter:videos')
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function searchUrl(query, tab = 'latest') {
  const mode = String(tab || 'latest').toLowerCase()
  const u = new URL('https://x.com/search')
  u.searchParams.set('q', query)
  u.searchParams.set('src', 'typed_query')
  if (mode === 'latest') u.searchParams.set('f', 'live')
  else if (mode === 'media') u.searchParams.set('f', 'image')
  return u.toString()
}

function parseStatusId(value) {
  const m = String(value || '').match(/\/status\/(\d+)/)
  return m ? m[1] : null
}

function normaliseStatusUrl(value) {
  const id = parseStatusId(value)
  if (!id) return null
  const m = String(value).match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)\/status\/\d+/i)
  const user = m ? m[1] : 'i'
  return `https://x.com/${user}/status/${id}`
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  const v = Number.isFinite(n) ? Math.floor(n) : fallback
  return Math.max(min, Math.min(max, v))
}

const COLLECT_JS = `
const sleep = ms => new Promise(r => setTimeout(r, ms));
function parseCompactNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/\\u00a0/g, ' ').trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/([\\d.,]+)\\s*(тыс\\.?|млн\\.?|млрд\\.?|k|m|b)?/i);
  if (!m) return null;
  let num = m[1].replace(/\\s/g, '');
  if (num.includes(',') && !num.includes('.')) num = num.replace(',', '.');
  num = num.replace(/,(?=\\d{3}\\b)/g, '');
  const val = Number(num);
  if (!Number.isFinite(val)) return null;
  const suf = m[2] || '';
  const mult = /^тыс|^k/.test(suf) ? 1e3 : /^млн|^m/.test(suf) ? 1e6 : /^млрд|^b/.test(suf) ? 1e9 : 1;
  return Math.round(val * mult);
}
function cleanAbsHref(href, { stripQuery = true } = {}) {
  if (!href) return null;
  try {
    const u = new URL(href, location.origin);
    if (stripQuery) {
      u.search = '';
      u.hash = '';
    }
    return u.href;
  } catch { return null; }
}
function statusFromArticle(a) {
  const links = [...a.querySelectorAll('a[href*="/status/"]')]
    .map(x => cleanAbsHref(x.getAttribute('href')))
    .filter(Boolean);
  const status = links.find(h => /\\/status\\/\\d+$/.test(h) && !/\\/analytics$/.test(h));
  if (!status) return null;
  const m = status.match(/\\/([^/]+)\\/status\\/(\\d+)$/);
  return m ? { url: status, user: m[1], id: m[2] } : null;
}
function countFromButton(a, testid) {
  const n = a.querySelector('[data-testid="' + testid + '"]');
  if (!n) return null;
  return { value: parseCompactNumber(n.getAttribute('aria-label') || n.innerText), label: n.getAttribute('aria-label') || n.innerText || '' };
}
function extractArticle(a) {
  const st = statusFromArticle(a);
  if (!st) return null;
  const time = a.querySelector('time')?.getAttribute('datetime') || null;
  const rawText = (a.innerText || '').trim();
  const isAd = !time || /(^|\\n)(Реклама|Ad|Promoted)(\\n|$)/i.test(rawText) || /\\/analytics$/.test(st.url);
  if (isAd && !__INCLUDE_ADS__) return null;
  const tweetText = [...a.querySelectorAll('[data-testid="tweetText"]')]
    .map(n => (n.innerText || '').trim())
    .filter(Boolean)
    .join('\\n\\n');
  const reply = countFromButton(a, 'reply');
  const retweet = countFromButton(a, 'retweet');
  const like = countFromButton(a, 'like');
  const viewsText = [...a.querySelectorAll('a[href$="/analytics"], [data-testid="analytics"]')]
    .map(n => n.getAttribute('aria-label') || n.innerText || '')
    .find(Boolean) || '';
  const displayName = (rawText.split('\\n')[0] || '').trim();
  const replying = rawText.match(/(?:В ответ|Replying to)\\s+([^\\n]+)/i)?.[1]?.trim() || null;
  const media = [...a.querySelectorAll('[data-testid="tweetPhoto"] img[src], img[src*="pbs.twimg.com/media/"], img[src*="pbs.twimg.com/card_img/"]')]
    .map((img, index) => {
      const url = img.currentSrc || img.src || img.getAttribute('src') || '';
      if (!url || !/pbs\\.twimg\\.com\\/(media|card_img)\\//.test(url)) return null;
      if (/profile_images|emoji/i.test(url)) return null;
      const abs = cleanAbsHref(url, { stripQuery: false });
      if (!abs) return null;
      let full = abs;
      try {
        const u = new URL(abs);
        if (u.hostname.endsWith('twimg.com')) {
          if (u.searchParams.get('format')) u.searchParams.set('name', 'orig');
        }
        full = u.toString();
      } catch {}
      return {
        index,
        kind: 'image',
        url: full,
        preview_url: abs,
        alt: img.getAttribute('alt') || '',
        width: img.naturalWidth || null,
        height: img.naturalHeight || null,
      };
    })
    .filter(Boolean)
    .filter((it, idx, arr) => arr.findIndex(x => x.url === it.url) === idx);
  return {
    status_id: st.id,
    url: st.url,
    user: st.user,
    display_name: displayName || null,
    text: tweetText || rawText,
    raw_text: rawText,
    published_at: time,
    replying_to: replying,
    counts: {
      replies: reply?.value ?? null,
      retweets: retweet?.value ?? null,
      likes: like?.value ?? null,
      views: parseCompactNumber(viewsText),
      raw: { reply: reply?.label || '', retweet: retweet?.label || '', like: like?.label || '', views: viewsText },
    },
    has_media: media.length > 0 || !!a.querySelector('[data-testid="videoPlayer"], video'),
    media,
    is_quote: /(^|\\n)(Цитата|Quote)(\\n|$)/i.test(rawText),
    is_ad: isAd,
  };
}
`

function searchCollectCode({ limit, maxSteps, settleMs, stepPx, includeAds }) {
  return `
${COLLECT_JS.replace('__INCLUDE_ADS__', includeAds ? 'true' : 'false')}
const LIMIT = ${limit};
const MAX_STEPS = ${maxSteps};
const SETTLE_MS = ${settleMs};
const STEP_PX = ${stepPx};
const seen = new Map();
function collect() {
  for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
    const it = extractArticle(a);
    if (it && !seen.has(it.status_id)) seen.set(it.status_id, it);
  }
}
window.scrollTo(0, 0);
await sleep(600);
let stagnant = 0;
let last = 0;
const t0 = performance.now();
for (let step = 0; step < MAX_STEPS && seen.size < LIMIT; step++) {
  collect();
  if (seen.size === last) stagnant++; else stagnant = 0;
  last = seen.size;
  if (stagnant >= 8 && step > 10) break;
  window.scrollBy(0, STEP_PX);
  await sleep(SETTLE_MS + Math.floor(Math.random() * 90));
}
collect();
return {
  url: location.href,
  title: document.title,
  elapsed_ms: Math.round(performance.now() - t0),
  scroll_y: window.scrollY,
  items: [...seen.values()].slice(0, LIMIT),
};
`
}

function threadCollectCode({ targetId, limit, maxSteps, settleMs, stepPx, includeAds }) {
  return `
${COLLECT_JS.replace('__INCLUDE_ADS__', includeAds ? 'true' : 'false')}
const TARGET_ID = ${JSON.stringify(String(targetId))};
const LIMIT = ${limit};
const MAX_STEPS = ${maxSteps};
const SETTLE_MS = ${settleMs};
const STEP_PX = ${stepPx};
const seen = new Map();
let targetSeen = false;
function collect() {
  for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
    const it = extractArticle(a);
    if (!it) continue;
    if (it.status_id === TARGET_ID) targetSeen = true;
    if (!targetSeen && TARGET_ID) continue;
    if (!seen.has(it.status_id)) seen.set(it.status_id, it);
  }
}
window.scrollTo(0, 0);
await sleep(700);
let stagnant = 0;
let last = 0;
const t0 = performance.now();
for (let step = 0; step < MAX_STEPS && seen.size < LIMIT; step++) {
  collect();
  if (seen.size === last) stagnant++; else stagnant = 0;
  last = seen.size;
  if (stagnant >= 8 && step > 10) break;
  window.scrollBy(0, STEP_PX);
  await sleep(SETTLE_MS + Math.floor(Math.random() * 110));
}
collect();
return {
  url: location.href,
  title: document.title,
  target_seen: targetSeen,
  elapsed_ms: Math.round(performance.now() - t0),
  scroll_y: window.scrollY,
  items: [...seen.values()].slice(0, LIMIT),
};
`
}

async function scrapeTwitterSearch(args = {}) {
  const query = buildTwitterQuery(args)
  if (!query) throw new Error('query is required')
  const limit = clampInt(args.limit, 50, 1, 500)
  const maxSteps = clampInt(args.scroll_steps, Math.max(12, Math.ceil(limit / 4) + 10), 1, 250)
  const settleMs = clampInt(args.settle_ms, 250, 80, 2000)
  const stepPx = clampInt(args.step_px, 1100, 200, 5000)
  const url = searchUrl(query, args.tab || args.sort || 'latest')
  const client = new BrowserBridgeClient()
  let tabId = null
  try {
    await client.connect()
    tabId = await client.newTab(url, { background: args.background !== false })
    await client.waitForSelector(tabId, 'article[data-testid="tweet"], div[data-testid="emptyState"], body', 20000)
    const data = await client.evaluateRaw(tabId, searchCollectCode({
      limit,
      maxSteps,
      settleMs,
      stepPx,
      includeAds: !!args.include_ads,
    }))
    return {
      kind: 'search',
      query,
      url,
      tab: args.tab || args.sort || 'latest',
      fetched_at: new Date().toISOString(),
      metrics: {
        requested_limit: limit,
        scroll_steps: maxSteps,
        settle_ms: settleMs,
        step_px: stepPx,
        elapsed_ms: data?.elapsed_ms ?? null,
        scroll_y: data?.scroll_y ?? null,
      },
      items: Array.isArray(data?.items) ? data.items : [],
    }
  } finally {
    if (args.close_tab !== false && tabId) await client.closeTab(tabId)
    await client.close()
  }
}

async function scrapeTwitterThread(args = {}) {
  const inputUrl = normaliseStatusUrl(args.url || args.status_url || '')
  if (!inputUrl) throw new Error('url must be an x.com/twitter.com status URL')
  const rootId = parseStatusId(inputUrl)
  const maxItems = clampInt(args.max_items ?? args.limit, 200, 1, 2000)
  const replyDepth = clampInt(args.reply_depth, 1, 1, 3)
  const branchLimit = clampInt(args.branch_limit, 25, 1, 100)
  const pageSteps = clampInt(args.scroll_steps, Math.max(14, Math.ceil(maxItems / 5) + 8), 1, 220)
  const settleMs = clampInt(args.settle_ms, 300, 100, 2500)
  const stepPx = clampInt(args.step_px, 1000, 200, 5000)
  const client = new BrowserBridgeClient({ timeoutMs: 240000 })
  let tabId = null
  const seen = new Map()
  const pages = []

  function addPageItems(items, parentId, depth) {
    const added = []
    for (const item of items || []) {
      if (!item || !item.status_id) continue
      const isRoot = item.status_id === rootId
      const externalId = `tweet:${item.status_id}`
      if (seen.has(externalId)) continue
      const next = {
        ...item,
        external_id: externalId,
        type: isRoot ? 'post' : 'comment',
        parent_external_id: isRoot ? null : `tweet:${parentId}`,
        depth: isRoot ? 0 : depth,
      }
      seen.set(externalId, next)
      if (!isRoot) added.push(next)
      if (seen.size >= maxItems) break
    }
    return added
  }

  async function collectPage(targetId, parentId, depth, perPageLimit) {
    await client.waitForSelector(tabId, 'article[data-testid="tweet"], body', 20000)
    const data = await client.evaluateRaw(tabId, threadCollectCode({
      targetId,
      limit: perPageLimit,
      maxSteps: pageSteps,
      settleMs,
      stepPx,
      includeAds: !!args.include_ads,
    }), { timeoutMs: 240000 })
    pages.push({
      target_id: targetId,
      parent_id: parentId,
      depth,
      target_seen: !!data?.target_seen,
      elapsed_ms: data?.elapsed_ms ?? null,
      items_seen: Array.isArray(data?.items) ? data.items.length : 0,
    })
    return addPageItems(data?.items || [], parentId, depth)
  }

  try {
    await client.connect()
    tabId = await client.newTab(inputUrl, { background: args.background !== false })
    let frontier = await collectPage(rootId, rootId, 1, maxItems)
    for (let depth = 2; depth <= replyDepth && seen.size < maxItems; depth++) {
      const parents = frontier.slice(0, branchLimit)
      const nextFrontier = []
      for (const parent of parents) {
        if (seen.size >= maxItems) break
        await client.navigate(tabId, parent.url)
        const remaining = Math.max(5, Math.min(maxItems - seen.size + 1, Math.ceil(maxItems / 2)))
        const kids = await collectPage(parent.status_id, parent.status_id, depth, remaining)
        nextFrontier.push(...kids)
      }
      frontier = nextFrontier
      if (!frontier.length) break
    }
    const items = [...seen.values()].slice(0, maxItems)
    return {
      kind: 'thread',
      url: inputUrl,
      root_status_id: rootId,
      fetched_at: new Date().toISOString(),
      metrics: {
        requested_limit: maxItems,
        reply_depth: replyDepth,
        branch_limit: branchLimit,
        page_count: pages.length,
        pages,
      },
      items,
    }
  } finally {
    if (args.close_tab !== false && tabId) await client.closeTab(tabId)
    await client.close()
  }
}

module.exports = {
  buildTwitterQuery,
  normaliseStatusUrl,
  parseStatusId,
  scrapeTwitterSearch,
  scrapeTwitterThread,
}
