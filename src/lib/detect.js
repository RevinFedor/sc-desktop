// URL/handle → platform + intent detection.
// Mirrors the legacy sc URL-detection rules.

export const PLATFORMS = {
  telegram: { label: 'Telegram', accent: '#229ED9' },
  youtube:  { label: 'YouTube',  accent: '#FF0000' },
  rutube:   { label: 'Rutube',   accent: '#EE2A5B' },
  tiktok:   { label: 'TikTok',   accent: '#FF0050' },
  instagram:{ label: 'Instagram',accent: '#E4405F' },
  reddit:   { label: 'Reddit',   accent: '#FF4500' },
  twitter:  { label: 'Twitter/X', accent: '#71717A' },
  boosty:   { label: 'Boosty',   accent: '#F15F2C' },
  local:    { label: 'Local file', accent: '#a1a1aa' },
}

const PLATFORM_USERNAME_RE = /^@?[a-zA-Z0-9._]{2,32}$/

// Local-file kind: anything we can hand to ffmpeg / Gemini / AssemblyAI.
// Video first because ffmpeg -vn extracts audio; pure-audio formats follow.
const LOCAL_AUDIO_VIDEO_EXT_RE =
  /\.(mp4|mov|m4v|mkv|webm|avi|flv|wmv|3gp|mp3|m4a|wav|flac|aac|ogg|oga|opus|aiff|aif|wma)$/i

/**
 * Returns { platform, kind, target, raw }
 * kind: 'url' | 'username' | 'title' | 'empty' | 'local-file'
 *
 * 'title' = free text that's not a URL and not a valid handle. Only Telegram
 * can act on this (resolves via iter_dialogs() exact-match), so PasteScreen
 * shows just the Telegram chip when kind === 'title'.
 *
 * 'local-file' = absolute filesystem path to a video/audio file. CleanShot
 * pastes look like  /Users/x/.../CleanShot 2026-04-28 at 08.43.55.mp4
 * (with spaces, dots, parens) and may arrive surrounded by single or double
 * quotes from a copy-as-path. Wrappers are stripped before extension check.
 */
export function detect(input) {
  let raw = (input || '').trim()
  if (!raw) return { platform: null, kind: 'empty', target: null, raw }

  // Strip surrounding quotes (single, double, smart) — copy-as-path often
  // wraps paths with spaces in quotes.
  const unquoted = raw.replace(/^["'`“‘]+|["'`”’]+$/g, '')

  // Local file path: absolute, video/audio extension. file:// URI also OK.
  if (unquoted.startsWith('file://')) {
    try {
      const decoded = decodeURIComponent(unquoted.slice(7))
      if (LOCAL_AUDIO_VIDEO_EXT_RE.test(decoded)) {
        return { platform: 'local', kind: 'local-file', target: decoded, raw }
      }
    } catch {}
  }
  if ((unquoted.startsWith('/') || unquoted.startsWith('~/'))
      && LOCAL_AUDIO_VIDEO_EXT_RE.test(unquoted)) {
    return { platform: 'local', kind: 'local-file', target: unquoted, raw }
  }

  // URL
  if (/^https?:\/\//i.test(raw)) {
    const lower = raw.toLowerCase()
    if (lower.includes('t.me') || lower.includes('telegram.me'))
      return tg(raw)
    if (lower.includes('youtube.com') || lower.includes('youtu.be'))
      return yt(raw)
    if (lower.includes('rutube.ru'))
      return rutube(raw)
    if (lower.includes('tiktok.com'))
      return tk(raw)
    if (lower.includes('instagram.com'))
      return ig(raw)
    if (lower.includes('reddit.com') || lower.includes('redd.it'))
      return rd(raw)
    if (lower.includes('boosty.to'))
      return boosty(raw)
    return { platform: null, kind: 'url-unknown', target: raw, raw }
  }

  // @username — needs a platform decision (we'll prompt)
  if (raw.startsWith('@') && PLATFORM_USERNAME_RE.test(raw)) {
    return { platform: null, kind: 'username', target: raw, raw }
  }

  // bare username (no @, no slashes) — same idea
  if (!raw.includes('/') && PLATFORM_USERNAME_RE.test(raw)) {
    return { platform: null, kind: 'username', target: '@' + raw, raw }
  }

  // Free text — Telegram chat title (spaces / pipes / cyrillic / emoji etc.)
  return { platform: null, kind: 'title', target: raw, raw }
}

function tg(url) {
  // Private-channel link: https://t.me/c/<internal_id>/<msg_id>
  //                  or:  https://t.me/c/<internal_id>/<topic_id>/<msg_id>
  // `c` is literal here, not a username; internal_id needs `-100` prefix
  // when handed to Telethon. We just classify as a message — handle resolution
  // is the form's job.
  const priv = url.match(/t\.me\/c\/(\d+)(?:\/(\d+))?(?:\/(\d+))?/i)
  if (priv) {
    const [, internalId, , c] = priv
    const handle = `-100${internalId}`
    return c
      ? { platform: 'telegram', kind: 'topic-message', target: url, handle, raw: url }
      : { platform: 'telegram', kind: 'message',       target: url, handle, raw: url }
  }
  // https://t.me/<channel>/<msg_id>?
  // https://t.me/<channel>/<topic_id>/<msg_id>?
  const m = url.match(/t\.me\/([^/?]+)(?:\/(\d+))?(?:\/(\d+))?/i)
  if (!m) return { platform: 'telegram', kind: 'url', target: url, raw: url }
  const [, handle, a, b] = m
  if (b) return { platform: 'telegram', kind: 'topic-message', target: url, handle, raw: url }
  if (a) return { platform: 'telegram', kind: 'message',       target: url, handle, raw: url }
  return       { platform: 'telegram', kind: 'channel',        target: '@' + handle, handle, raw: url }
}

function yt(url) {
  if (/\/results\?/i.test(url) && /[?&]search_query=/i.test(url)) {
    let query = ''
    try {
      const u = new URL(url)
      query = u.searchParams.get('search_query') || ''
    } catch {}
    return { platform: 'youtube', kind: 'search', target: url, query, raw: url }
  }
  if (/\/(channel|c|user|@)/i.test(url) || /\/videos\b/i.test(url))
    return { platform: 'youtube', kind: 'channel', target: url, raw: url }
  if (/\/playlist\?/i.test(url))
    return { platform: 'youtube', kind: 'playlist', target: url, raw: url }
  return { platform: 'youtube', kind: 'video', target: url, raw: url }
}

function rutube(url) {
  if (/rutube\.ru\/(?:(?:live\/)?video(?:\/private)?|(?:play\/)?embed)\/[0-9a-z]{32}(?:[/?#]|$)/i.test(url)) {
    return { platform: 'rutube', kind: 'video', target: url, raw: url }
  }
  return { platform: 'rutube', kind: 'url', target: url, raw: url }
}

function tk(url) {
  // Short URLs (vt.tiktok.com / vm.tiktok.com / m.tiktok.com) — treat as video
  // (resolved to a real /@user/video/... URL on the Python side).
  if (/(?:vt|vm|m)\.tiktok\.com\//i.test(url))
    return { platform: 'tiktok', kind: 'video', target: url, raw: url }
  // /@user/video/123... — single video
  if (/tiktok\.com\/@[\w.-]+\/video\//i.test(url))
    return { platform: 'tiktok', kind: 'video', target: url, raw: url }
  // /@user — profile/channel
  const m = url.match(/tiktok\.com\/@([\w.-]+)/i)
  if (m) return { platform: 'tiktok', kind: 'channel', target: url, handle: '@' + m[1], raw: url }
  return { platform: 'tiktok', kind: 'url', target: url, raw: url }
}

function ig(url) {
  if (/\/(reel|reels|p)\//i.test(url))
    return { platform: 'instagram', kind: 'reel', target: url, raw: url }
  // profile URL: instagram.com/<username>/
  const m = url.match(/instagram\.com\/([^/?]+)/i)
  const handle = m && !['reel','reels','p','explore','stories','tv'].includes(m[1]) ? m[1] : null
  if (handle) return { platform: 'instagram', kind: 'profile', target: '@' + handle, handle, raw: url }
  return { platform: 'instagram', kind: 'url', target: url, raw: url }
}

function rd(url) {
  // reddit.com/r/<sub>/comments/<id>/<slug>/  → thread (single post + tree of comments)
  if (/\/comments\//i.test(url))
    return { platform: 'reddit', kind: 'thread', target: url, raw: url }
  // reddit.com/r/<sub>/  → subreddit listing (treated as search seed without query)
  const m = url.match(/reddit\.com\/r\/([^/?]+)/i)
  if (m) return { platform: 'reddit', kind: 'subreddit', target: url, handle: m[1], raw: url }
  return { platform: 'reddit', kind: 'url', target: url, raw: url }
}

function boosty(url) {
  try {
    const parsed = new URL(url)
    const layer = parsed.searchParams.get('layer') || ''
    if (/^video:[^:]+:[0-9a-f-]{36}:[0-9a-f-]{36}$/i.test(layer)) {
      return { platform: 'boosty', kind: 'video', target: url, raw: url }
    }
    if (/\/posts\/[0-9a-f-]{36}\/?$/i.test(parsed.pathname)) {
      return { platform: 'boosty', kind: 'post', target: url, raw: url }
    }
    if (/\/purchase\/\d+\/?$/i.test(parsed.pathname)) {
      return { platform: 'boosty', kind: 'purchase', target: url, raw: url }
    }
    const author = parsed.pathname.split('/').filter(Boolean)[0] || null
    return { platform: 'boosty', kind: 'channel', target: url, handle: author, raw: url }
  } catch {
    return { platform: 'boosty', kind: 'url', target: url, raw: url }
  }
}
