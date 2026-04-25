import React, { useState } from 'react'
import PlatformLogo from './PlatformLogo'

/**
 * Circular avatar for a source. Renders the chat/channel profile photo when
 * we have one on disk, falls back to the first letter of the name on a
 * platform-tinted circle. Falls further to PlatformLogo if no name is given.
 *
 * Props:
 *   source        — full source row { platform, display_name, handle, avatar_url }
 *   size          — px (default 20)
 *   className     — extra classes for the wrapper
 *
 * `avatar_url` is overloaded by source — Telegram stores a *local relative
 * path* (`avatars/telegram/123.jpg`, served via the sc-asset:// protocol),
 * while YouTube/Instagram/TikTok keep the original CDN URL (yt-dlp /
 * web_profile_info hands it to us as `https://...`). We detect which is
 * which and route to the right loader.
 */
export default function Avatar({ source, size = 20, className = '' }) {
  const [broken, setBroken] = useState(false)
  const src = resolveAvatarSrc(source?.avatar_url)
  const name = (source?.display_name && source.display_name !== source.handle)
    ? source.display_name
    : (source?.handle ? '@' + source.handle : '')
  const initial = pickInitial(name)

  const style = { width: size, height: size, fontSize: Math.round(size * 0.45) }

  if (src && !broken) {
    return (
      <img
        src={src}
        onError={() => setBroken(true)}
        alt=""
        referrerPolicy="no-referrer"
        className={`rounded-full object-cover bg-zinc-800 shrink-0 ${className}`}
        style={style}
      />
    )
  }
  if (initial) {
    return (
      <span
        className={`rounded-full bg-zinc-800 text-zinc-200 flex items-center justify-center font-medium shrink-0 ${className}`}
        style={style}
      >{initial}</span>
    )
  }
  return <PlatformLogo platform={source?.platform} size={size} className={className} />
}

function resolveAvatarSrc(value) {
  if (!value) return null
  const v = String(value).trim()
  if (!v) return null
  // Already a full URL (YouTube / IG / TikTok stash CDN links here).
  if (/^https?:\/\//i.test(v)) return v
  // Anything else is a relative path under LIB_ROOT — served by the
  // sc-asset:// protocol handler in electron/main.js.
  return `sc-asset://${v.replace(/^\/+/, '')}`
}

// First non-whitespace, non-symbol grapheme. Handles emoji-prefixed names
// (e.g. "🔥 Чат | EBASH") by skipping symbols where possible.
function pickInitial(name) {
  const s = (name || '').trim()
  if (!s) return ''
  for (const ch of s) {
    if (/[\p{L}\p{N}]/u.test(ch)) return ch.toUpperCase()
  }
  return s[0].toUpperCase()
}
