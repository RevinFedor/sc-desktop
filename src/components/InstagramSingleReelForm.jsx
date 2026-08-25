import React, { useEffect, useImperativeHandle, useMemo, useState, forwardRef } from 'react'
import { Copy, ExternalLink, FolderOpen, RotateCw, Settings } from 'lucide-react'
import {
  getInstagramSettings,
  lookupInstagramReel,
  startInstagramBatchTranscribe,
  watchJob,
} from '../lib/jobs'
import { formatBytes } from '../lib/formatTokens'
import { backendLabel } from '../lib/instagram'
import { openSettings, pushScreen } from '../lib/store'
import PlatformLogo from './PlatformLogo'

const ENGINES = [
  { id: 'gemini', label: 'Gemini 2.5 Flash' },
  { id: 'assemblyai', label: 'AssemblyAI' },
]

function extractShortcode(url) {
  if (!url) return null
  const raw = String(url).trim()
  const m = raw.match(/(?:^|\/)(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i)
  const code = m ? m[1] : raw
  return code.replace(/[^A-Za-z0-9_-]/g, '') || null
}

function isNumericId(value) {
  return /^\d+$/.test(String(value || ''))
}

const InstagramSingleReelForm = forwardRef(function InstagramSingleReelForm({ url, onStarted }, ref) {
  const shortcode = useMemo(() => extractShortcode(url), [url])
  const [stage, setStage] = useState('loading')
  const [settings, setSettings] = useState(null)
  const [cached, setCached] = useState(null)
  const [job, setJob] = useState(null)
  const [engine, setEngine] = useState('gemini')
  const [err, setErr] = useState(null)
  const [toast, setToast] = useState(null)

  useEffect(() => {
    let alive = true
    setStage('loading')
    setSettings(null)
    setCached(null)
    setJob(null)
    setErr(null)
    setToast(null)

    ;(async () => {
      try {
        const [s, c] = await Promise.all([
          getInstagramSettings({ validateToken: true }),
          lookupInstagramReel({ url, shortcode }),
        ])
        if (!alive) return
        setSettings(s)
        setCached(c)
        if (c?.transcript_path) {
          setStage('cache-hit')
          const r = await window.api?.copyFile?.(c.transcript_path)
          if (alive && r?.ok) setToast(`Скопировано из кэша · ${formatBytes(r.bytes)}`)
        } else {
          setStage('idle')
        }
      } catch (e) {
        if (!alive) return
        setErr(String(e?.message || e))
        setStage('error')
      }
    })()

    return () => { alive = false }
  }, [url, shortcode])

  const configuredBackend = settings?.transcribe_backend || 'api'
  const hasLocalOwner = cached?.source_id && isNumericId(cached?.source_external_id)
  const apifyOk = !!settings?.apify_token_check?.ok

  function plannedBackend() {
    return configuredBackend === 'apify' ? 'apify' : 'api'
  }

  function blockedReason(backend = plannedBackend()) {
    if (!shortcode) return 'Не удалось распознать shortcode reels'
    if (backend === 'apify' && !apifyOk) {
      return settings?.apify_token_set
        ? 'Apify-токен не прошёл проверку'
        : 'Для выбранного Apify backend нужен действующий токен'
    }
    return null
  }

  async function copyResult() {
    const path = job?.file_path || firstSavedPath(job) || cached?.transcript_path
    if (!path) return
    const r = await window.api?.copyFile?.(path)
    if (r?.ok) {
      setToast(`Скопировано · ${formatBytes(r.bytes)}`)
      setTimeout(() => setToast(null), 2500)
    }
  }

  async function kickOff() {
    const backend = plannedBackend()
    const blocked = blockedReason(backend)
    if (blocked) {
      setErr(blocked)
      setStage('error')
      return
    }

    setStage('running')
    setErr(null)
    setToast(null)
    try {
      const params = {
        shortcodes: [shortcode],
        captions: [cached?.caption || cached?.title || ''],
        engine,
        backend,
        target: url,
        ...(backend === 'api' ? {
          api_resolution: hasLocalOwner ? 'profile_clips' : 'shortcode_session',
        } : {}),
      }
      if (backend === 'api' && hasLocalOwner) {
        params.source_id = cached.source_id
        params.user_id = String(cached.source_external_id)
      }
      const id = await startInstagramBatchTranscribe(params)
      if (id == null) {
        setErr('Electron IPC недоступен')
        setStage('error')
        return
      }
      onStarted && onStarted(id)
      const off = watchJob(id, snap => {
        setJob(snap)
        if (snap.status === 'done') {
          setStage('done')
          setTimeout(() => copyResultFromSnapshot(snap), 0)
          off()
        } else if (snap.status === 'error' || snap.status === 'cancelled') {
          setErr(snap.error || snap.status)
          setStage('error')
          off()
        } else {
          setStage('running')
        }
      })
    } catch (e) {
      setErr(String(e?.message || e))
      setStage('error')
    }
  }

  async function copyResultFromSnapshot(snap) {
    const path = snap?.file_path || firstSavedPath(snap)
    if (!path) return
    const r = await window.api?.copyFile?.(path)
    if (r?.ok) setToast(`Готово · скопировано (${formatBytes(r.bytes)})`)
  }

  useImperativeHandle(ref, () => ({
    trigger() {
      if (stage === 'idle' || stage === 'error') return kickOff()
      if (stage === 'cache-hit' || stage === 'done') return copyResult()
    },
  }), [stage, shortcode, engine, settings, cached, job])

  if (stage === 'loading') {
    return (
      <Shell>
        <Header shortcode={shortcode} />
        <div className="text-zinc-500" style={{ fontSize: '14px' }}>Проверяю кэш, настройки и токен…</div>
      </Shell>
    )
  }

  if (stage === 'cache-hit' && cached?.transcript_path) {
    return (
      <Shell>
        <Header shortcode={shortcode} title={cached.title || cached.caption} />
        <StatusDot tone="emerald" text="Уже есть транскрипт" />
        {toast && <div className="text-zinc-500" style={{ fontSize: '14px' }}>{toast}</div>}
        <ActionRow onCopy={copyResult} path={cached.transcript_path} />
      </Shell>
    )
  }

  if (stage === 'running') {
    const b = job?.yt_batch || {}
    const current = b.current
    const progress = job?.items_done != null ? `${job.items_done}/${job.items_total || 1}` : '0/1'
    return (
      <Shell>
        <Header shortcode={shortcode} title={current?.title} />
        <StatusDot tone="emerald" pulse text={stageLabel(current?.stage)} />
        <div className="h-1 bg-zinc-800 rounded overflow-hidden">
          <div className="h-1 bg-emerald-500 rounded transition-all" style={{ width: `${Math.min(100, (job?.items_done || 0) * 100)}%` }} />
        </div>
        <div className="text-zinc-500 flex items-center gap-2 flex-wrap" style={{ fontSize: '14px' }}>
          <span>{progress}</span>
          <span className="text-zinc-700">·</span>
          <span>{backendLabel(job?.params?.backend || plannedBackend())}</span>
          <span className="text-zinc-700">·</span>
          <span>{job?.params?.engine || engine}</span>
          {b.cost_usd > 0 && (
            <>
              <span className="text-zinc-700">·</span>
              <span className="tabular-nums">${Number(b.cost_usd).toFixed(4)}</span>
            </>
          )}
        </div>
      </Shell>
    )
  }

  if (stage === 'done') {
    const path = job?.file_path || firstSavedPath(job)
    return (
      <Shell>
        <Header shortcode={shortcode} />
        <StatusDot tone="emerald" text="Готово" />
        {toast && <div className="text-zinc-500" style={{ fontSize: '14px' }}>{toast}</div>}
        <ActionRow onCopy={copyResult} path={path} />
      </Shell>
    )
  }

  if (stage === 'error') {
    return (
      <Shell danger>
        <Header shortcode={shortcode} />
        <div className="text-red-300" style={{ fontSize: '14px' }}>{err || 'Ошибка'}</div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={kickOff}
            className="px-3 py-1.5 rounded-md text-sm bg-red-900/40 text-red-100 hover:bg-red-900/60 inline-flex items-center gap-1.5"
          ><RotateCw size={14} />Повторить</button>
          <SettingsButton />
        </div>
      </Shell>
    )
  }

  const backend = plannedBackend()
  const blocked = blockedReason(backend)

  return (
    <Shell>
      <Header shortcode={shortcode} title={cached?.title || cached?.caption} />
      <div className="space-y-2">
        <div className="text-zinc-400" style={{ fontSize: '14px' }}>
          {hasLocalOwner
            ? `Android API получит ролик через сохранённый профиль @${cached.source_handle}.`
            : backend === 'api'
              ? 'Android API получит ролик напрямую по ссылке через сохранённую Instagram-сессию.'
              : 'Для этой ссылки будет запущен выбранный Apify backend.'}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2">
          <span className="text-zinc-500" style={{ fontSize: '14px' }}>Движок</span>
          <select
            value={engine}
            onChange={e => setEngine(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-zinc-200 focus:outline-none focus:border-zinc-500"
            style={{ fontSize: '14px' }}
          >
            {ENGINES.map(en => <option key={en.id} value={en.id}>{en.label}</option>)}
          </select>
        </label>
        <span className="text-zinc-600" style={{ fontSize: '14px' }}>
          backend: <span className="text-zinc-300">{backendLabel(backend)}</span>
        </span>
        <button
          onClick={kickOff}
          disabled={!!blocked}
          className="ml-auto px-4 py-2 rounded-md font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
        >Транскрибировать</button>
      </div>

      {blocked && (
        <div className="flex items-center gap-2 flex-wrap text-zinc-500" style={{ fontSize: '14px' }}>
          <span>{blocked}</span>
          <SettingsButton />
        </div>
      )}
    </Shell>
  )
})

export default InstagramSingleReelForm

function firstSavedPath(snap) {
  return (snap?.yt_batch?.log || []).find(row => row?.kind === 'ai' && row.file_path)?.file_path || null
}

function stageLabel(stage) {
  if (stage === 'fetching') return 'Получаем видео…'
  if (stage === 'transcribing') return 'Транскрибируем…'
  return 'Запускаем…'
}

function Shell({ children, danger = false }) {
  return (
    <div className={`rounded-lg border ${danger ? 'border-red-900/50 bg-red-950/20' : 'border-zinc-800 bg-zinc-950'} px-6 py-5 space-y-4`}>
      {children}
    </div>
  )
}

function Header({ shortcode, title }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <PlatformLogo platform="instagram" size={18} />
      <div className="min-w-0">
        <div className="text-zinc-200 font-medium">Instagram · reels</div>
        <div className="text-zinc-500 truncate" style={{ fontSize: '14px' }}>
          {title ? title : shortcode}
        </div>
      </div>
    </div>
  )
}

function StatusDot({ tone, text, pulse = false }) {
  const color = tone === 'emerald' ? 'bg-emerald-500' : 'bg-zinc-500'
  return (
    <div className="flex items-center gap-3">
      <span className={`inline-block w-2 h-2 rounded-full ${color} ${pulse ? 'animate-pulse' : ''}`} />
      <span className="text-zinc-200 font-medium">{text}</span>
    </div>
  )
}

function ActionRow({ onCopy, path }) {
  if (!path) return null
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={onCopy}
        className="px-3 py-1.5 rounded-md text-sm bg-zinc-100 text-zinc-900 hover:bg-white inline-flex items-center gap-1.5"
      ><Copy size={14} />Скопировать</button>
      <button
        onClick={() => window.api?.openExternal?.(path)}
        className="px-3 py-1.5 rounded-md text-sm text-zinc-300 hover:bg-zinc-900 inline-flex items-center gap-1.5"
      ><ExternalLink size={14} />Открыть</button>
      <button
        onClick={() => window.api?.revealInFinder?.(path)}
        className="px-3 py-1.5 rounded-md text-sm text-zinc-300 hover:bg-zinc-900 inline-flex items-center gap-1.5"
      ><FolderOpen size={14} />Показать</button>
    </div>
  )
}

function SettingsButton() {
  return (
    <button
      onClick={() => openSettings('instagram')}
      className="px-3 py-1.5 rounded-md text-sm text-zinc-300 hover:bg-zinc-900 inline-flex items-center gap-1.5"
    ><Settings size={14} />Настройки</button>
  )
}
