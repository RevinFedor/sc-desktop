import React from 'react'

/** Inline SVG platform marks. No network fetch — all hand-built so they
 *  match Tailwind classNames and any size we throw at them.
 */
export default function PlatformLogo({ platform, size = 16, className = '' }) {
  const Cmp = LOGOS[platform]
  if (!Cmp) {
    return (
      <span
        className={`inline-block rounded-full bg-zinc-700 ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }
  return <Cmp size={size} className={className} />
}

function Telegram({ size, className }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-label="Telegram">
      <defs>
        <linearGradient id="tg-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#37BBFE"/>
          <stop offset="100%" stopColor="#007DBB"/>
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="12" fill="url(#tg-g)"/>
      <path d="M5.5 11.6 L17.5 7 c0.7-0.3 1.3 0.2 1.1 1 L16.6 18 c-0.2 0.8-0.7 1-1.4 0.6 L11.5 16 9.6 17.8 c-0.2 0.2-0.4 0.3-0.7 0.3 L9 14.2 16 8.5 c0.3-0.3-0.1-0.4-0.5-0.2 L7 13.5 4.4 12.7 c-0.7-0.2-0.7-0.7 0.1-1 z"
        fill="#fff"/>
    </svg>
  )
}

function YouTube({ size, className }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-label="YouTube">
      <rect x="1.5" y="5" width="21" height="14" rx="3.5" fill="#FF0000"/>
      <path d="M10 8.5 L16 12 L10 15.5 Z" fill="#fff"/>
    </svg>
  )
}

function Instagram({ size, className }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-label="Instagram">
      <defs>
        <radialGradient id="ig-g" cx="0.3" cy="1" r="1.1">
          <stop offset="0%"   stopColor="#FED576"/>
          <stop offset="25%"  stopColor="#F47133"/>
          <stop offset="55%"  stopColor="#BC3081"/>
          <stop offset="100%" stopColor="#4C63D2"/>
        </radialGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="5.5" fill="url(#ig-g)"/>
      <circle cx="12" cy="12" r="4.5" fill="none" stroke="#fff" strokeWidth="2"/>
      <circle cx="17.4" cy="6.6" r="1.2" fill="#fff"/>
    </svg>
  )
}

function TikTok({ size, className }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-label="TikTok">
      <rect x="1" y="1" width="22" height="22" rx="5" fill="#000"/>
      {/* cyan layer */}
      <path d="M14.4 5.5 v8.6 c0 1.1-0.9 2-2 2 s-2-0.9-2-2 0.9-2 2-2 v-2.4 c-2.4 0-4.4 2-4.4 4.4 s2 4.4 4.4 4.4 4.4-2 4.4-4.4 V9.7 c1 0.7 2.2 1.1 3.5 1.1 V8.4 c-1.7 0-3.2-1.3-3.5-2.9 z"
            fill="#25F4EE" transform="translate(-0.6,0.6)"/>
      {/* pink layer */}
      <path d="M14.4 5.5 v8.6 c0 1.1-0.9 2-2 2 s-2-0.9-2-2 0.9-2 2-2 v-2.4 c-2.4 0-4.4 2-4.4 4.4 s2 4.4 4.4 4.4 4.4-2 4.4-4.4 V9.7 c1 0.7 2.2 1.1 3.5 1.1 V8.4 c-1.7 0-3.2-1.3-3.5-2.9 z"
            fill="#FE2C55" transform="translate(0.6,-0.6)"/>
      {/* white front */}
      <path d="M14.4 5.5 v8.6 c0 1.1-0.9 2-2 2 s-2-0.9-2-2 0.9-2 2-2 v-2.4 c-2.4 0-4.4 2-4.4 4.4 s2 4.4 4.4 4.4 4.4-2 4.4-4.4 V9.7 c1 0.7 2.2 1.1 3.5 1.1 V8.4 c-1.7 0-3.2-1.3-3.5-2.9 z"
            fill="#fff"/>
    </svg>
  )
}

function Reddit({ size, className }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-label="Reddit">
      <circle cx="12" cy="12" r="12" fill="#FF4500"/>
      <circle cx="12" cy="13" r="6.5" fill="#fff"/>
      <circle cx="9.5" cy="12.4" r="0.9" fill="#FF4500"/>
      <circle cx="14.5" cy="12.4" r="0.9" fill="#FF4500"/>
      <path d="M9 14.6 c0.7 0.7 1.8 1 3 1 s2.3-0.3 3-1" fill="none" stroke="#FF4500" strokeWidth="0.9" strokeLinecap="round"/>
      <circle cx="18.4" cy="7.3" r="1.3" fill="#fff"/>
      <line x1="13" y1="6.5" x2="17.5" y2="7.2" stroke="#fff" strokeWidth="0.9"/>
    </svg>
  )
}

function Twitter({ size, className }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-label="Twitter/X">
      <circle cx="12" cy="12" r="12" fill="#18181B"/>
      <path
        d="M7.1 6.5h3.1l2.2 3.1 2.7-3.1h1.8l-3.7 4.3 4 5.7h-3.1l-2.5-3.6-3.1 3.6H6.7l4.1-4.8-3.7-5.2Zm1.5 1.2 6.1 7.6h1L9.6 7.7h-1Z"
        fill="#fff"
      />
    </svg>
  )
}

function LocalFile({ size, className }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-label="Local file">
      <rect x="3" y="2.5" width="14" height="19" rx="2.5" fill="#3F3F46"/>
      <path d="M14 2.5 L19 7.5 L14 7.5 Z" fill="#52525B"/>
      <path d="M9 12.5 L14 15 L9 17.5 Z" fill="#A1A1AA"/>
    </svg>
  )
}

const LOGOS = {
  telegram:  Telegram,
  youtube:   YouTube,
  instagram: Instagram,
  tiktok:    TikTok,
  reddit:    Reddit,
  twitter:   Twitter,
  local:     LocalFile,
}
