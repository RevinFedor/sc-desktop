import React, { useState, useMemo, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { detect, PLATFORMS } from '../lib/detect'
import { useStore, rememberRecent, setPasteState } from '../lib/store'
import PlatformLogo from '../components/PlatformLogo'
import TelegramConfigForm from '../components/TelegramConfigForm'
import TelegramSingleMessageForm from '../components/TelegramSingleMessageForm'
import YouTubeSingleForm from '../components/YouTubeSingleForm'
import YouTubeChannelForm from '../components/YouTubeChannelForm'
import TikTokSingleForm from '../components/TikTokSingleForm'
import TikTokChannelForm from '../components/TikTokChannelForm'
import InstagramConfigForm from '../components/InstagramConfigForm'
import InstagramSingleReelForm from '../components/InstagramSingleReelForm'
import RedditThreadForm from '../components/RedditThreadForm'
import RedditSearchForm from '../components/RedditSearchForm'
import LocalFileTranscribeForm from '../components/LocalFileTranscribeForm'
import YouTubeSearchForm from '../components/YouTubeSearchForm'
import YouTubeCommentsForm from '../components/YouTubeCommentsForm'
import TelegramFolderForm from '../components/TelegramFolderForm'
import HomeRecentActivities from '../components/HomeRecentActivities'
import BoostySingleForm from '../components/BoostySingleForm'
import BoostyChannelForm from '../components/BoostyChannelForm'
import RutubeSingleForm from '../components/RutubeSingleForm'

const PLATFORM_ORDER = ['telegram', 'youtube', 'boosty', 'instagram', 'tiktok', 'reddit']
const PLATFORM_LABELS = { telegram: 'Telegram', youtube: 'YouTube', rutube: 'Rutube', instagram: 'Instagram', tiktok: 'TikTok', reddit: 'Reddit', boosty: 'Boosty', local: 'Local file' }

// Extract `?search_query=...` for chip display so the user sees "gpt 5.5 opus"
// instead of the full youtube.com URL in their Recent paste row.
function extractSearchQuery(urlOrText) {
  try {
    const u = new URL(urlOrText)
    return (u.searchParams.get('search_query') || urlOrText).replace(/\+/g, ' ')
  } catch { return urlOrText }
}

export default function PasteScreen({ payload }) {
  // value + committed live in the store so the user's draft survives
  // navigating to a source and back. Local copies kept here for fast re-render.
  const persistedValue = useStore(s => s.paste.value)
  const persistedCommitted = useStore(s => s.paste.committed)
  const [value, setValueLocal] = useState(persistedValue)
  // What the user explicitly committed to. Until they click a chip,
  // detection just suggests — nothing parses.  { platform, kind } | null
  const [committed, setCommittedLocal] = useState(persistedCommitted)
  const inputRef = useRef(null)

  // The global + action can be used while Home is already open. In that
  // case the screen is not remounted, so autoFocus alone is insufficient.
  useEffect(() => {
    if (!payload?.focusComposer) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [payload?.focusComposer, payload?.focusRequestId])

  // Local-only setters — the mirror-effect below syncs to the store after
  // each render. Doing the store write inside a functional updater (like
  // we used to) calls emit() while React is still inside another
  // component's setState callback, which fires the
  //   "Cannot update a component (`PasteScreen`) while rendering …"
  // warning because every other useStore subscriber re-runs its selector
  // in that window.
  const setValue = setValueLocal
  const setCommitted = setCommittedLocal

  // Mirror local → store after commit, not during a setState updater.
  useEffect(() => {
    setPasteState({ value, committed })
  }, [value, committed])

  const detection = useMemo(() => detect(value), [value])
  const recents = useStore(s => s.recents)

  // YouTube kind chips. [video] is now a split-chip rendered separately —
  // see Detection() below. The kinds returned here drive the per-platform
  // PlatformKindChips for the secondary picks (channel for batch flows).
  // The standalone [comments] chip was folded into the [video | + comm]
  // split-chip — the user pastes a watch URL, picks "+ comm" to additionally
  // pull comments alongside the transcript. Standalone YouTubeCommentsForm
  // is still reachable via direct paste of a comments-only URL form (none
  // exists today; if a need shows up, surface it as a `?` panel instead of
  // a third chip).
  const availableYtKinds = useMemo(() => {
    if (detection.platform === 'youtube') {
      if (detection.kind === 'video')    return ['channel']
      if (detection.kind === 'playlist') return ['video']
      return ['channel']
    }
    return ['channel']
  }, [detection.platform, detection.kind])

  // TikTok kind chips: same idea — video URL gives both [видео] (default)
  // and [канал]; profile URL gives only [канал].
  const availableTkKinds = useMemo(() => {
    if (detection.platform === 'tiktok') {
      if (detection.kind === 'video')   return ['video', 'channel']
      if (detection.kind === 'channel') return ['channel']
    }
    return ['channel']
  }, [detection.platform, detection.kind])

  const platformResolved = detection.platform != null
  const needsPlatformPick = !platformResolved && (detection.kind === 'username')
  // Free text (chat title) — only Telegram can resolve it via iter_dialogs.
  const needsTitleConfirm = !platformResolved && (detection.kind === 'title')

  // Auto-commit Telegram URLs (single-chip behaviour preserved). YouTube
  // requires explicit chip click — even though detect() resolves the
  // platform, we wait for the user to confirm video/channel intent.
  // Only auto-commit when nothing is committed yet — otherwise we'd
  // overwrite a recents-click pick or kind-chip pick.
  //
  // Single-message Telegram URLs (`t.me/<chat>/<id>`) behave like a YouTube
  // single-video URL: require explicit Enter / chip click before fetch
  // starts. Auto-firing the moment a paste lands surprises the user
  // (input clears instantly, no chance to abort, no chance to see the
  // detection chip).
  useEffect(() => {
    setCommitted(prev => {
      if (prev) return prev
      // YouTube and TikTok need explicit kind pick (video vs channel chip).
      // Exception: YouTube search URLs (?search_query=...) are unambiguous —
      // auto-commit, skip the chip step.
      if (detection.platform === 'youtube' && detection.kind === 'search') {
        return { platform: 'youtube', kind: 'search' }
      }
      // Telegram single-message / topic-message — defer commit to explicit
      // user action (mirrors YouTube single-video behaviour). The chat-handle
      // path (t.me/<channel>) keeps the original auto-commit.
      if (detection.platform === 'telegram' &&
          (detection.kind === 'message' || detection.kind === 'topic-message')) {
        return prev
      }
      if (detection.platform && detection.platform !== 'youtube' && detection.platform !== 'tiktok') {
        return { platform: detection.platform, kind: detection.kind }
      }
      return prev
    })
  }, [detection.platform, detection.kind])

  // Telegram single-message: explicit commit, optional withComments flag goes
  // straight into the committed object so TelegramSingleMessageForm can read
  // it as an initial prop and start a fetch with --include-comments on mount.
  function pickTelegramSingle({ withComments = false } = {}) {
    if (!value.trim()) return
    setCommitted({
      platform: 'telegram',
      kind: detection.kind,                  // 'message' | 'topic-message'
      includeComments: !!withComments,
    })
    if (shouldRemember('telegram', detection.kind)) {
      rememberRecent({ ...detection, platform: 'telegram', target: activeTarget })
    }
  }

  const activePlatform = committed?.platform || null
  const activeKind     = committed?.kind || null
  const activeTarget   = detection.target || value.trim()

  // Imperative handle to the active inline form, so Enter in the input
  // can advance whatever stage the form is in (start fetch / confirm AI).
  const formRef = useRef(null)

  // YouTube/TikTok channels live in Library (Sidebar) — they don't belong
  // in "Recent paste" too. Recents stay reserved for one-shot inputs.
  function shouldRemember(platform, kind) {
    if (platform === 'youtube' && kind === 'channel') return false
    if (platform === 'tiktok'  && kind === 'channel') return false
    if (platform === 'boosty'  && kind === 'channel') return false
    return true
  }

  function pickPlatform(p) {
    if (!value.trim()) return
    // Default kind per platform when only a username/word is given:
    //   YouTube  → 'channel' (no way to address a single video by handle)
    //   TikTok   → 'channel' (same reason)
    //   Instagram→ 'profile' (reels/posts both live under the same flow)
    //   Telegram → keep detection.kind (could be channel/message/url)
    const k =
      p === 'youtube'   ? 'channel' :
      p === 'tiktok'    ? 'channel' :
      p === 'boosty'    ? 'channel' :
      p === 'instagram' ? 'profile' :
      p === 'reddit'    ? 'search' :
      detection.kind
    setCommitted({ platform: p, kind: k })
    if (shouldRemember(p, k)) {
      rememberRecent({ ...detection, platform: p, target: activeTarget })
    }
  }

  // Free-text title flow has TWO commit options: «найти чат» (existing
  // resolve_title path) and «папка» (resolve a Telegram folder by name and
  // open its TelegramScreen tab). Folder is its own committed-kind so the
  // PlatformForm switch can route it cleanly.
  function pickFolder() {
    if (!value.trim()) return
    setCommitted({ platform: 'telegram', kind: 'folder' })
    rememberRecent({ ...detection, platform: 'telegram', kind: 'folder',
                     target: activeTarget })
  }

  function pickYoutubeKind(k, opts = {}) {
    if (!value.trim()) return
    // `withComments` only meaningful for kind='video' — surfaces as the
    // split-chip's right half. Adds an `includeComments` flag onto the
    // committed object which YouTubeSingleForm reads on mount.
    setCommitted({
      platform: 'youtube',
      kind: k,
      includeComments: !!opts.withComments,
    })
    if (shouldRemember('youtube', k)) {
      rememberRecent({ ...detection, platform: 'youtube', kind: k, target: activeTarget })
    }
  }

  function pickTiktokKind(k) {
    if (!value.trim()) return
    setCommitted({ platform: 'tiktok', kind: k })
    if (shouldRemember('tiktok', k)) {
      rememberRecent({ ...detection, platform: 'tiktok', kind: k, target: activeTarget })
    }
  }

  function onKey(e) {
    if (e.key !== 'Enter') return
    if (committed) {
      // Form is mounted. Forward Enter to it via trigger() (start fetch / confirm).
      if (formRef.current?.trigger) formRef.current.trigger()
    } else if (detection.platform === 'youtube') {
      // YouTube URL pasted but no kind committed yet → press the default chip.
      // For video URLs default Enter = transcript-only (left half of the
      // split-chip). For other kinds (channel/playlist) — first secondary chip.
      const def = detection.kind === 'video' ? 'video' : (availableYtKinds[0] || 'channel')
      pickYoutubeKind(def)
    } else if (detection.platform === 'tiktok') {
      pickTiktokKind(availableTkKinds[0])
    } else if (detection.platform === 'telegram' &&
               (detection.kind === 'message' || detection.kind === 'topic-message')) {
      // TG single-message: Enter commits the platform chip (kind already
      // detected). Mirrors YouTube single-video: chip-or-Enter before fetch.
      setCommitted({ platform: 'telegram', kind: detection.kind })
      if (shouldRemember('telegram', detection.kind)) {
        rememberRecent({ ...detection, platform: 'telegram', target: activeTarget })
      }
    } else if (needsPlatformPick) {
      pickPlatform('telegram')   // first 4-platform chip
    } else if (needsTitleConfirm) {
      pickPlatform('telegram')   // single Telegram chip for chat-title flow
    }
  }

  function clearInput() {
    setValue('')
    setCommitted(null)
  }

  // User typing/pasting clears any previous chip commitment.
  // (Recents-button click goes through restoreFromRecent and skips this.)
  function onInputChange(v) {
    setValue(v)
    setCommitted(null)
  }

  function restoreFromRecent(r) {
    setValue(r.label)
    setCommitted({
      platform: r.platform,
      kind: r.kind || (r.platform === 'youtube' ? 'channel' : null),
    })
  }

  // Search picker shows a wide multi-column row (date + title + uploader +
  // ✓ + duration + views) with a full-width filter panel — bump the
  // container so columns don't collide.
  const isWide = activePlatform === 'youtube' && activeKind === 'search'

  return (
    <div className="h-full overflow-auto">
      <div className={`${isWide ? 'max-w-4xl' : 'max-w-2xl'} mx-auto px-8 pt-16 pb-12`}>
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold mb-2">Что забираем?</h1>
          <p className="text-zinc-500">Ссылка, @ник, название чата или путь к файлу</p>
        </div>

        <div className="relative">
          <input
            ref={inputRef}
            autoFocus
            value={value}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={onKey}
            placeholder="https://t.me/channel · @username · https://youtube.com/..."
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3.5 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
          />
          {value && (
            <button
              onClick={clearInput}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 leading-none inline-flex items-center"
              tabIndex={-1}
            ><X size={16} /></button>
          )}
        </div>

        <Detection
          detection={detection}
          needsPlatformPick={needsPlatformPick && !committed}
          needsTitleConfirm={needsTitleConfirm && !committed}
          committed={committed}
          availableYtKinds={availableYtKinds}
          availableTkKinds={availableTkKinds}
          onPickPlatform={pickPlatform}
          onPickTelegramSingle={pickTelegramSingle}
          onPickFolder={pickFolder}
          onPickYtKind={pickYoutubeKind}
          onPickTkKind={pickTiktokKind}
        />

        {/* Inline form under the detection row — no screen switch */}
        {committed && (
          <div className="mt-2">
            <PlatformForm
              formRef={formRef}
              platform={activePlatform}
              kind={activeKind}
              target={activeTarget}
              includeComments={!!committed.includeComments}
              detection={{ ...detection, platform: activePlatform, target: activeTarget, kind: activeKind }}
              onStarted={() => {
                // Channel/chat fetches clear the input — user almost always
                // wants to paste a *next* link after kicking the parse off.
                // Single-message / single-video / search / local-file flows
                // are ephemeral terminal screens: the form keeps showing
                // progress → done → copy-again, so we keep the URL in the
                // input. Clearing it here would also hide the form on
                // re-mount (Home would look blank after rerender / tab
                // switch / app restart).
                const ephemeral =
                  (activePlatform === 'telegram' && (activeKind === 'message' || activeKind === 'topic-message')) ||
                  (activePlatform === 'youtube' && (activeKind === 'video' || activeKind === 'search' || activeKind === 'comments')) ||
                  activePlatform === 'boosty' ||
                  activePlatform === 'local'
                if (activePlatform === 'telegram' && !ephemeral) clearInput()
              }}
            />
          </div>
        )}

        {recents.length > 0 && !activePlatform && (
          <div className="mt-12">
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-3">Recent paste</div>
            <div className="flex flex-wrap gap-2">
              {recents.map(r => {
                const display = r.kind === 'local-file'
                  ? r.label.slice(r.label.lastIndexOf('/') + 1) || r.label
                  : r.kind === 'search' && r.platform === 'youtube'
                    ? extractSearchQuery(r.label)
                    : r.label
                const kindLabel =
                  r.kind === 'video'      ? 'видео' :
                  r.kind === 'channel'    ? 'канал' :
                  r.kind === 'title'      ? 'чат'   :
                  r.kind === 'local-file' ? 'файл'  :
                  r.kind === 'search'     ? 'поиск' :
                  r.kind
                return (
                  <button
                    key={r.id}
                    onClick={() => restoreFromRecent(r)}
                    className="px-3 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 hover:border-zinc-600 flex items-center gap-2"
                  >
                    <PlatformLogo platform={r.platform} size={14} />
                    <span className="text-zinc-300 truncate max-w-[200px]">{display}</span>
                    <span className="text-zinc-600 text-xs">[{kindLabel}]</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Last activities — компактный список реальных job'ов (не ввода).
            Показываем когда юзер на Home и ничего не парсит сейчас, чтобы
            «вернувшись из браузера» он сразу видел что было запущено. */}
        {!activePlatform && <HomeRecentActivities />}
      </div>
    </div>
  )
}

/**
 * Detection row — fixed h-12, never shifts what's below it.
 *  - empty input                  → invisible spacer
 *  - committed (Telegram URL)     → platform name + target
 *  - committed (YouTube + kind)   → platform name + selected kind chip
 *  - YouTube URL, no kind yet     → hint + YouTube kind chip on the right
 *  - username, no platform yet    → hint + 4 platform chips on the right
 */
function Detection({
  detection, needsPlatformPick, needsTitleConfirm, committed,
  availableYtKinds, availableTkKinds,
  onPickPlatform, onPickTelegramSingle, onPickFolder, onPickYtKind, onPickTkKind,
}) {
  const { platform, raw } = detection
  if (!raw) return <div className="h-12 mt-3" />

  // Already committed — show what's chosen.
  if (committed) {
    return (
      <div className="h-12 mt-3 flex items-center gap-3">
        <PlatformLogo platform={committed.platform} size={16} />
        <span className="text-zinc-300 font-medium">{PLATFORMS[committed.platform]?.label}</span>
        {(committed.platform === 'youtube' || committed.platform === 'tiktok') && (
          <span className="text-zinc-500" style={{ fontSize: '14px' }}>
            · [{
              committed.kind === 'video'    ? 'видео'   :
              committed.kind === 'search'   ? 'поиск'   :
              committed.kind === 'comments' ? 'комментарии' :
              'канал'
            }]
          </span>
        )}
        {committed.platform === 'telegram' && committed.kind === 'folder' && (
          <span className="text-zinc-500" style={{ fontSize: '14px' }}>
            · [папка]
          </span>
        )}
        {committed.platform === 'local' && (
          <span className="text-zinc-500" style={{ fontSize: '14px' }}>
            · [транскрипт]
          </span>
        )}
        {committed.platform === 'rutube' && (
          <span className="text-zinc-500" style={{ fontSize: '14px' }}>
            · [расшифровка]
          </span>
        )}
        {committed.platform === 'boosty' && (
          <span className="text-zinc-500" style={{ fontSize: '14px' }}>
            · [{committed.kind === 'channel' ? 'автор · весь каталог' : committed.kind === 'post' ? 'пост · все видео' : 'видео · аудио + титры'}]
          </span>
        )}
      </div>
    )
  }

  // The descriptive sentence on the left (e.g. «YouTube video — нажми чтобы
  // получить транскрипт») is intentionally NOT rendered — the chip on the
  // right is self-describing (icon + label). Keeping the row at h-12 means
  // layout doesn't jump when chips appear/disappear; chips stay on the right
  // edge thanks to `ml-auto` on the chip wrapper component. If we ever need
  // examples / instructions, surface them through an explicit `?` button
  // that expands a panel below — not as default-on text.

  // YouTube URL detected. For watch URLs we render a split-chip
  // [видео | + comm] alongside the [канал] secondary chip — same shape as
  // Telegram single-message: left = default Enter (transcript only),
  // right = transcript + comments side-fetch in parallel. For non-video
  // YT URLs (channel pages, playlists) just the standard kind chips.
  if (platform === 'youtube') {
    const isVideo = detection.kind === 'video'
    return (
      <div className="h-12 mt-3 flex items-center gap-3">
        <div className="ml-auto flex items-center gap-1.5">
          {isVideo && (
            <SplitChip
              platform="youtube"
              leftLabel="видео"
              rightLabel="+ comm"
              leftTitle="YouTube · видео · Enter"
              rightTitle="YouTube · видео + комментарии"
              onLeft={() => onPickYtKind('video')}
              onRight={() => onPickYtKind('video', { withComments: true })}
            />
          )}
          {availableYtKinds.map((k) => (
            <button
              key={k}
              onClick={() => onPickYtKind(k)}
              title={`YouTube · ${k === 'channel' ? 'канал' : k}`}
              className="h-7 px-2 rounded-md flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 hover:border-zinc-500 hover:bg-zinc-800 whitespace-nowrap"
            >
              <PlatformLogo platform="youtube" size={16} />
              <span className="text-zinc-300" style={{ fontSize: '14px' }}>
                [{k === 'channel' ? 'канал' : k === 'video' ? 'видео' : k}]
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  // TikTok URL detected, awaiting chip click — mirrors YouTube.
  if (platform === 'tiktok') {
    return (
      <div className="h-12 mt-3 flex items-center gap-3">
        <PlatformKindChips
          platform="tiktok"
          availableKinds={availableTkKinds}
          defaultKind={availableTkKinds[0]}
          onPick={onPickTkKind}
        />
      </div>
    )
  }

  // Username, no platform picked — original 4-platform chip-row.
  if (needsPlatformPick) {
    return (
      <div className="h-12 mt-3 flex items-center gap-3">
        <PlatformChips onPick={onPickPlatform} />
      </div>
    )
  }

  // Telegram single-message URL — split-chip with two click zones inside one
  // border. Left = «just text» (default Enter, current behaviour). Right =
  // «+ comm» — same fetch but with --include-comments, so we land with both
  // a transcript file and a discussion-thread file ready to copy
  // independently. Two halves share a single hover-border so the chip reads
  // as one cohesive control; per-half hover only highlights the half under
  // the cursor.
  if (platform === 'telegram' && (detection.kind === 'message' || detection.kind === 'topic-message')) {
    return (
      <div className="h-12 mt-3 flex items-center gap-3">
        <div className="ml-auto">
          <SplitChip
            platform="telegram"
            leftLabel="сообщение"
            rightLabel="+ comm"
            leftTitle="Telegram · сообщение · Enter"
            rightTitle="Telegram · сообщение + комментарии"
            onLeft={() => onPickTelegramSingle({ withComments: false })}
            onRight={() => onPickTelegramSingle({ withComments: true })}
          />
        </div>
      </div>
    )
  }

  // Free text — could be a chat title to resolve OR a folder name to open.
  // Two chips, [найти чат] is default Enter (most common case).
  if (needsTitleConfirm) {
    return (
      <div className="h-12 mt-3 flex items-center gap-3">
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => onPickPlatform('telegram')}
            title="Telegram · найти чат · Enter"
            className="h-7 px-2 rounded-md flex items-center gap-1.5 bg-zinc-900 border border-zinc-600 ring-1 ring-zinc-700 hover:border-zinc-500 hover:bg-zinc-800 whitespace-nowrap"
          >
            <PlatformLogo platform="telegram" size={16} />
            <span className="text-zinc-300" style={{ fontSize: '14px' }}>
              [найти чат]
            </span>
          </button>
          <button
            onClick={onPickFolder}
            title="Telegram · папка"
            className="h-7 px-2 rounded-md flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 hover:border-zinc-500 hover:bg-zinc-800 whitespace-nowrap"
          >
            <PlatformLogo platform="telegram" size={16} />
            <span className="text-zinc-300" style={{ fontSize: '14px' }}>
              [папка]
            </span>
          </button>
        </div>
      </div>
    )
  }

  // Catch-all when we couldn't classify the input AT ALL — no chip to offer.
  // This is the only place where a hint actually adds information (the user
  // needs to know we didn't recognise their paste). Kept short.
  return (
    <div className="h-12 mt-3 flex items-center gap-3 text-zinc-500">
      <span>Не похоже на ссылку или username</span>
    </div>
  )
}

/**
 * Icon-style chips for YouTube kind selection — visually consistent with
 * 4-platform-chip-row used for username detection. Clicking a chip both
 * picks the kind AND starts the fetch (= immediate commit). The first chip
 * is "default Enter" — same pattern as PlatformChips.
 */
function PlatformKindChips({ platform, availableKinds, defaultKind, onPick }) {
  const LABELS = { video: 'видео', channel: 'канал', comments: 'комментарии' }
  const platformLabel = PLATFORMS[platform]?.label || platform
  return (
    <div className="ml-auto flex items-center gap-1.5">
      {availableKinds.map((k) => {
        const isDefault = k === defaultKind
        return (
          <button
            key={k}
            onClick={() => onPick(k)}
            title={`${platformLabel} · ${LABELS[k]}${isDefault ? ' · Enter' : ''}`}
            className={`h-7 px-2 rounded-md flex items-center gap-1.5 bg-zinc-900 border hover:border-zinc-500 hover:bg-zinc-800 ${
              isDefault ? 'border-zinc-600 ring-1 ring-zinc-700' : 'border-zinc-800'
            }`}
          >
            <PlatformLogo platform={platform} size={16} />
            <span className="text-zinc-300" style={{ fontSize: '14px' }}>
              [{LABELS[k]}]
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Split-chip: one visual button divided into two click-zones with a thin
 * vertical separator. Left half = primary action (default Enter-equivalent),
 * right half = additive variant (e.g. «+ comm»). The two halves share one
 * outer border + ring (so the chip reads as a unit) but each gets its own
 * hover-fill so the user sees which half they're aiming at. Mirrors the
 * `border-zinc-600 ring-1 ring-zinc-700` shell of `PlatformKindChips` —
 * caller-side it sits in the same row as a regular chip.
 */
function SplitChip({ platform, leftLabel, rightLabel, leftTitle, rightTitle, onLeft, onRight }) {
  return (
    <div className="h-7 inline-flex rounded-md bg-zinc-900 border border-zinc-600 ring-1 ring-zinc-700 overflow-hidden whitespace-nowrap">
      <button
        onClick={onLeft}
        title={leftTitle}
        className="px-2 flex items-center gap-1.5 hover:bg-zinc-800 transition-colors"
      >
        <PlatformLogo platform={platform} size={16} />
        <span className="text-zinc-300" style={{ fontSize: '14px' }}>
          [{leftLabel}]
        </span>
      </button>
      <span className="w-px bg-zinc-700" aria-hidden />
      <button
        onClick={onRight}
        title={rightTitle}
        className="px-2 flex items-center hover:bg-zinc-800 transition-colors"
      >
        <span className="text-zinc-300" style={{ fontSize: '14px' }}>
          [{rightLabel}]
        </span>
      </button>
    </div>
  )
}

function PlatformChips({ onPick }) {
  return (
    <div className="ml-auto flex items-center gap-1.5">
      {PLATFORM_ORDER.map((p, i) => (
        <button
          key={p}
          onClick={() => onPick(p)}
          title={`${PLATFORM_LABELS[p]}${i === 0 ? ' · Enter' : ''}`}
          className={`w-7 h-7 rounded-md flex items-center justify-center bg-zinc-900 border hover:border-zinc-500 hover:bg-zinc-800 ${
            i === 0 ? 'border-zinc-600 ring-1 ring-zinc-700' : 'border-zinc-800'
          }`}
        >
          <PlatformLogo platform={p} size={18} />
        </button>
      ))}
    </div>
  )
}

/** Inline configuration form for the chosen platform.
 *  Today: Telegram (full form), YouTube single-video (transcript flow).
 *  Other platforms still get a placeholder.
 */
function PlatformForm({ formRef, platform, kind, target, includeComments, detection, onStarted }) {
  if (platform === 'telegram') {
    // Single-message URL → straight transcribe (mirrors YouTube single-video).
    // The full TelegramConfigForm with mode picker only makes sense for
    // channels/handles where the user picks a date range / count.
    if (kind === 'message' || kind === 'topic-message') {
      return (
        <TelegramSingleMessageForm
          ref={formRef}
          target={target}
          includeComments={!!includeComments}
          onStarted={onStarted}
        />
      )
    }
    // Folder by name — resolve, materialise sources, navigate to TelegramScreen.
    if (kind === 'folder') {
      return (
        <TelegramFolderForm
          ref={formRef}
          name={target}
          onStarted={onStarted}
        />
      )
    }
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
        <TelegramConfigForm
          target={target}
          kind={kind}
          onStarted={onStarted}
          compact={false}
        />
      </div>
    )
  }
  if (platform === 'youtube' && kind === 'video') {
    return (
      <YouTubeSingleForm
        ref={formRef}
        url={target}
        includeCommentsDefault={!!includeComments}
        onStarted={onStarted}
      />
    )
  }
  if (platform === 'rutube' && kind === 'video') {
    return (
      <RutubeSingleForm
        ref={formRef}
        url={target}
        onStarted={onStarted}
      />
    )
  }
  if (platform === 'youtube' && kind === 'search') {
    return (
      <YouTubeSearchForm
        ref={formRef}
        url={target}
        query={detection.query}
        onStarted={onStarted}
      />
    )
  }
  if (platform === 'youtube' && kind === 'comments') {
    return (
      <YouTubeCommentsForm
        ref={formRef}
        url={target}
        onStarted={onStarted}
      />
    )
  }
  // username via chip → treat as channel; explicit channel URL → channel.
  if (platform === 'youtube' && (kind === 'channel' || kind === 'username')) {
    return (
      <YouTubeChannelForm
        ref={formRef}
        url={target}
        onStarted={onStarted}
      />
    )
  }
  if (platform === 'tiktok' && kind === 'video') {
    return (
      <TikTokSingleForm
        ref={formRef}
        url={target}
        onStarted={onStarted}
      />
    )
  }
  if (platform === 'tiktok' && (kind === 'channel' || kind === 'username')) {
    return (
      <TikTokChannelForm
        ref={formRef}
        url={target}
        onStarted={onStarted}
      />
    )
  }
  // Instagram profile (chip-pick on @username, profile URL, or username
  // detected as profile). Single reel/post deep-links are one-shot jobs:
  // api when the source profile is already known, otherwise explicit Apify.
  if (platform === 'instagram' && (kind === 'profile' || kind === 'username')) {
    return (
      <InstagramConfigForm
        ref={formRef}
        target={target}
        onStarted={onStarted}
      />
    )
  }
  if (platform === 'instagram' && kind === 'reel') {
    return (
      <InstagramSingleReelForm
        ref={formRef}
        url={target}
        onStarted={onStarted}
      />
    )
  }
  // Reddit: thread URL (post + comments) or search (keyword + optional sub).
  if (platform === 'reddit' && kind === 'thread') {
    return (
      <RedditThreadForm
        ref={formRef}
        url={target}
        onStarted={onStarted}
      />
    )
  }
  if (platform === 'reddit') {
    // search / subreddit / username chip → search form (subreddit URL pre-fills the field)
    const presetQuery = (kind === 'username' || kind === 'subreddit') ? '' : target
    return (
      <RedditSearchForm
        ref={formRef}
        initialQuery={presetQuery}
        onStarted={onStarted}
      />
    )
  }
  if (platform === 'local' && kind === 'local-file') {
    return (
      <LocalFileTranscribeForm
        ref={formRef}
        path={target}
        onStarted={onStarted}
      />
    )
  }
  if (platform === 'boosty' && kind === 'channel') {
    return (
      <BoostyChannelForm
        ref={formRef}
        url={target}
        onStarted={onStarted}
      />
    )
  }
  if (platform === 'boosty' && (kind === 'post' || kind === 'video' || kind === 'purchase' || kind === 'url')) {
    return (
      <BoostySingleForm
        ref={formRef}
        url={target}
        onStarted={onStarted}
      />
    )
  }
  // Placeholder for other platforms.
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6 text-zinc-400">
      <div className="flex items-center gap-2 mb-2">
        <PlatformLogo platform={platform} size={16} />
        <span className="font-medium text-zinc-200">{PLATFORM_LABELS[platform]}</span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-500">{detection.kind}</span>
      </div>
      <div className="text-zinc-500">
        Inline-форма для {PLATFORM_LABELS[platform]} ещё не подключена.
        Парсинг через CLI пока что доступен в командной строке: <code>sc {target}</code>
      </div>
    </div>
  )
}
