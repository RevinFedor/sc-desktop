import React, { useState } from 'react'
import { startYoutubeChannelFetch } from '../lib/jobs'
import YouTubeScopeFields, { DEFAULT_YT_RANGE } from './YouTubeScopeFields'

/**
 * YouTube/TikTok kickoff form for SourceDetail's «Новый запрос…» panel.
 * Mirrors the visual contract of TelegramConfigForm — scope-fields above,
 * action button below — so YT/TG forms read the same way.
 *
 * The full picker (YouTubeChannelForm) is overkill on a known source; we
 * just need a fresh fetch with a configurable limit and direction. 0 in
 * the limit field means «весь канал» (no `--playlist-end`).
 *
 * Props:
 *   target         — `@handle` or channel URL (required)
 *   onStarted(id)  — fired after the job is enqueued
 *   platform       — 'youtube' | 'tiktok'  (only YouTube wires `reverse`
 *                    today; tiktok pipes through tkChannelFetch which
 *                    doesn't accept it yet — direction flag is ignored)
 */
export default function YouTubeQuickFetchForm({ target, onStarted, platform = 'youtube' }) {
  const [range, setRange] = useState(DEFAULT_YT_RANGE)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function start() {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      const n = Math.max(0, Number(range.limit) || 0)
      const reverse = range.direction === 'oldest'
      if (platform === 'youtube') {
        await startYoutubeChannelFetch({ target, limit: n, reverse })
      } else if (platform === 'tiktok' && window.api?.tkChannelFetch) {
        // TikTok backend doesn't accept `reverse` — limit only. Direction
        // toggle stays in the UI for visual parity but won't change output.
        await window.api.tkChannelFetch({ target, limit: n })
      }
      if (onStarted) onStarted()
    } catch (e) {
      setErr(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6 space-y-4">
      <div className="flex items-baseline gap-2">
        <span className="text-zinc-300 font-medium">{platform === 'tiktok' ? 'TikTok' : 'YouTube'} · канал</span>
        <span className="text-zinc-700">·</span>
        <span className="text-zinc-500 truncate max-w-md">{target}</span>
      </div>

      {err && (
        <div className="px-3 py-2 rounded bg-red-950/40 border border-red-900/60 text-red-300" style={{ fontSize: '14px' }}>
          {err}
        </div>
      )}

      <YouTubeScopeFields range={range} onRangeChange={setRange} />

      <div className="flex items-center justify-end border-t border-zinc-800 pt-3 mt-2">
        <button
          onClick={start}
          disabled={busy}
          className={`px-5 py-2 rounded-md font-medium ${
            busy
              ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
              : 'bg-zinc-100 text-zinc-900 hover:bg-white'
          }`}
        >{busy ? 'Запускаю…' : 'Спарсить'}</button>
      </div>
    </div>
  )
}
