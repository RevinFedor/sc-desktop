import React, {
  useEffect, useImperativeHandle, useState, forwardRef, useRef,
} from 'react'
import {
  startInstagramProfileFetch, getInstagramSettings, watchJob,
} from '../lib/jobs'
import Checkbox from './Checkbox'
import { pushScreen } from '../lib/store'
import { refreshSources } from '../lib/sources'
import { backendLabel } from '../lib/instagram'
import PlatformLogo from './PlatformLogo'
import InstagramBatchPicker from './InstagramBatchPicker'

/**
 * Inline Instagram profile form, mirrors YouTubeChannelForm:
 *
 *   On mount with a target:
 *     1. Lookup the existing source (if user already fetched this @user
 *        before) — render header + picker immediately.
 *     2. Otherwise show the kickoff form (Reels/Posts checkboxes, limit).
 *        On submit, spawn ig_profile_fetch and watch the job; once
 *        `job.source_id` arrives → re-lookup and switch to the picker
 *        view, with progress shown until `done`.
 *
 * Layout when a profile is loaded:
 *   ┌─ ProfileHeader (clickable → SourceDetail) ──────────┐
 *   ├─ InstagramBatchPicker (same as SourceDetail uses) ──┤
 *   └─────────────────────────────────────────────────────┘
 *
 * The backend selector is no longer in this form — it's a settings.json
 * decision (see InstagramSettings.jsx). Form just shows the active
 * choice as a small label with a deep-link to settings.
 *
 * Props:
 *   target         — '@user' or 'user' (required)
 *   onStarted(id)  — called after the kickoff fetch is enqueued
 */
const InstagramConfigForm = forwardRef(function InstagramConfigForm({ target, onStarted, forceForm = false }, ref) {
  // 'idle' | 'fetching' | 'ready' | 'error'
  const [stage, setStage] = useState('idle')
  const [profile, setProfile] = useState(null)        // source row
  const [fetchJob, setFetchJob] = useState(null)
  const [err, setErr] = useState(null)
  const [settings, setSettings] = useState(null)

  // Kickoff form state
  const [reels, setReels] = useState(true)
  const [posts, setPosts] = useState(false)
  const [limit, setLimit] = useState('50')

  const handle = String(target || '').replace(/^@/, '').trim()
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    let alive = true
    getInstagramSettings().then(s => { if (alive) setSettings(s) })
    return () => { alive = false }
  }, [])

  // On mount with a fresh target — try cache first.  Skipped when the
  // form is mounted inside SourceDetail's «Новый запрос…» panel
  // (forceForm=true) — there the source is *already* shown above and we
  // don't want to render a duplicate header+picker; the user opened the
  // form because they want to kick off another, possibly differently-
  // configured fetch.
  useEffect(() => {
    if (!handle || !window.api?.igLookupProfile) return
    let alive = true
    setStage('idle'); setErr(null); setProfile(null); setFetchJob(null)
    if (forceForm) return () => { alive = false }

    ;(async () => {
      const cached = await window.api.igLookupProfile({ handle })
      if (!alive) return
      if (cached && cached.items_count) {
        setProfile(cached)
        setStage('ready')
      }
      // else: stay idle, user clicks «Спарсить» to kick off the fetch.
    })()

    return () => { alive = false }
  }, [handle, forceForm])

  function backendForMetadata() {
    return (settings && settings.metadata_backend) || 'api'
  }

  function tokenMissingForCurrent() {
    // Apify selected anywhere → token must be set for transcribe to work
    // later. The form itself doesn't need a token to fetch via api, but
    // we surface the warning early so the user fixes it before paying
    // attention to the picker.
    if (!settings) return false
    const apifyAnywhere = settings.metadata_backend === 'apify' || settings.transcribe_backend === 'apify'
    return apifyAnywhere && !settings.apify_token_set
  }

  async function kickoff() {
    if (!handle || stage === 'fetching') return
    const noKindPicked = !reels && !posts
    if (noKindPicked) { setErr('Выбери Reels и/или Posts'); return }
    const backend = backendForMetadata()
    if (backend === 'api' && posts && !reels) {
      setErr('Backend api пока тянет только Reels. Переключи в настройках на Apify или включи Reels.')
      return
    }

    setStage('fetching'); setErr(null)
    try {
      const mode = reels && posts ? 'both' : (reels ? 'reels' : 'posts')
      const id = await startInstagramProfileFetch({
        target:  handle,
        backend,
        mode,
        limit: Number(limit) || 50,
      })
      if (onStarted) onStarted(id)
      // Watch the job — once source_id appears, lookup + switch to ready.
      // Exception: forceForm mode (form embedded inside SourceDetail's
      // «Новый запрос…» panel). There the page itself reloads on job
      // events, so we must NOT rebuild a header+picker inside the form
      // — that would duplicate UI.
      const off = watchJob(id, async snap => {
        if (!aliveRef.current) return
        setFetchJob(snap)
        if (!forceForm && snap.source_id && (!profile || profile.id !== snap.source_id)) {
          const fresh = await window.api.igLookupProfile({ handle })
          if (aliveRef.current && fresh) {
            setProfile(fresh)
            setStage('ready')
            refreshSources()
          }
        }
        if (snap.status === 'error') {
          setErr(snap.error || 'fetch failed')
          setStage('error')
          off()
        }
        if (snap.status === 'done' || snap.status === 'cancelled') {
          off()
          // forceForm: parent already toggles the panel on submit; nothing
          // for us to do besides stop watching.
        }
      })
    } catch (e) {
      setErr(String(e?.message || e))
      setStage('error')
    }
  }

  // Enter on the input forwards trigger() into us — same convention as the
  // YouTube/TG forms.
  useImperativeHandle(ref, () => ({
    trigger() {
      if (stage === 'idle' || stage === 'error') kickoff()
    },
  }), [stage, reels, posts, limit, settings, handle])

  // ── Renders ─────────────────────────────────────────────────────────

  if (stage === 'ready' && profile) {
    // From the paste-flow point of view the user already has the
    // profile loaded — the next thing they want is either to dive into
    // the picker or jump to SourceDetail for non-default fetches. We
    // expose «↗ Источник» right in the header instead of duplicating the
    // whole new-request form in two places (it lives on SourceDetail).
    return (
      <div className="space-y-4">
        <ProfileHeader profile={profile} fetchJob={fetchJob} />
        <InstagramBatchPicker sourceId={profile.id} />
      </div>
    )
  }

  if (stage === 'fetching') {
    const job = fetchJob
    const limitN = Number(limit) || 50
    // limit=0 means "all profile" — we don't know the total in advance.
    // For limited fetches, use limitN as the denominator so the bar
    // progresses smoothly (clips/user/ pages return 12 each).
    const denom = limitN > 0 ? limitN : (job?.items_total || null)
    const done = job?.items_done || 0
    const pct = denom ? Math.min(100, Math.round((done / denom) * 100)) : null

    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6 space-y-3">
        <div className="flex items-center gap-2">
          <PlatformLogo platform="instagram" size={16} />
          <span className="font-medium text-zinc-200">@{handle}</span>
          <span className="text-zinc-700">·</span>
          <span className="text-emerald-400" style={{ fontSize: '14px' }}>⚡ парсинг…</span>
        </div>

        {/* Progress bar — same style as ActivityPanel JobRow. Falls back
            to an indeterminate pulse when we don't know the total
            (limit=0 = "весь профиль"). */}
        {pct !== null ? (
          <div className="h-1 bg-zinc-800 rounded">
            <div className="h-1 bg-emerald-500 rounded transition-all" style={{ width: `${pct}%` }} />
          </div>
        ) : (
          <div className="h-1 bg-zinc-800 rounded overflow-hidden">
            <div className="h-1 bg-emerald-500 animate-pulse rounded" style={{ width: '40%' }} />
          </div>
        )}

        <div className="text-zinc-500" style={{ fontSize: '14px' }}>
          backend: <span className="text-zinc-300">{backendLabel(job?.params?.backend || backendForMetadata())}</span>
          {' · '}
          {job?.entity_title && <>{job.entity_title} · </>}
          получено <span className="text-zinc-300">{done}</span>{denom ? `/${denom}` : ''}
        </div>

        {err && <ErrorBox text={err} />}
      </div>
    )
  }

  // idle / error — the kickoff form.
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6 space-y-4">
      <div className="flex items-baseline gap-2">
        <span className="text-zinc-300 font-medium">Instagram · профиль</span>
        <span className="text-zinc-700">·</span>
        <span className="text-zinc-500">@{handle}</span>
      </div>

      {err && <ErrorBox text={err} />}

      <Field label="Что тянуть">
        <div className="flex items-center gap-4">
          <Checkbox checked={reels} onChange={setReels} label="Reels" />
          <Checkbox checked={posts} onChange={setPosts} label="Posts" />
        </div>
      </Field>

      <Field label="Лимит" hint="Сколько последних элементов тянуть. 0 = весь профиль (медленно).">
        <input
          type="number"
          min="0"
          max="2000"
          value={limit}
          onChange={e => setLimit(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 w-28 focus:outline-none focus:border-zinc-500"
          style={{ fontSize: '14px' }}
        />
      </Field>

      {tokenMissingForCurrent() && (
        <div className="px-3 py-2 rounded bg-amber-950/40 border border-amber-900/60 text-amber-300" style={{ fontSize: '14px' }}>
          Apify-токен не задан, а в настройках выбран Apify backend.{' '}
          <button
            onClick={() => pushScreen('ig-settings')}
            className="underline hover:text-amber-200"
          >Открыть настройки</button>{' '}
          чтобы задать токен или переключиться на api.
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={kickoff}
          disabled={stage === 'fetching'}
          className="px-4 py-2 rounded-md font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
        >Спарсить</button>
        <span className="text-zinc-500" style={{ fontSize: '14px' }}>
          metadata: <span className="text-zinc-300">{backendLabel(backendForMetadata())}</span>
          {' · '}
          transcribe: <span className="text-zinc-300">{backendLabel((settings && settings.transcribe_backend) || 'api')}</span>
          {' · '}
          <button
            onClick={() => pushScreen('ig-settings')}
            className="text-zinc-500 hover:text-zinc-200 underline"
          >настройки</button>
        </span>
      </div>
    </div>
  )
})

export default InstagramConfigForm

function ProfileHeader({ profile, fetchJob }) {
  const matched = profile
  const onClick = matched ? () => pushScreen('source-detail', { sourceId: matched.id }) : undefined
  const itemsCount = matched?.items_count || 0
  const isFetching = fetchJob && (fetchJob.status === 'running' || fetchJob.status === 'pending')
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      className={`bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex items-center gap-4 ${
        onClick ? 'hover:border-zinc-600 cursor-pointer' : ''
      }`}
    >
      <PlatformLogo platform="instagram" size={32} />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{matched.display_name || `@${matched.handle}`}</div>
        <div className="text-zinc-500" style={{ fontSize: '14px' }}>
          @{matched.handle}
          <span className="text-zinc-700 mx-2">·</span>
          {itemsCount.toLocaleString('ru-RU')} reels
          {isFetching && (
            <>
              <span className="text-zinc-700 mx-2">·</span>
              <span className="text-emerald-400">⚡ обновляется</span>
            </>
          )}
        </div>
      </div>
      <span className="text-zinc-600 shrink-0">→</span>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div className="text-zinc-500 mb-1" style={{ fontSize: '14px' }}>{label}</div>
      {children}
      {hint && <div className="text-zinc-600 mt-1" style={{ fontSize: '13px' }}>{hint}</div>}
    </div>
  )
}

function ErrorBox({ text }) {
  return (
    <div className="px-3 py-2 rounded bg-red-950/40 border border-red-900/60 text-red-300" style={{ fontSize: '14px' }}>
      {text}
    </div>
  )
}
