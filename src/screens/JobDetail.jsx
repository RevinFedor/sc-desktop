import React, { useEffect, useMemo, useState } from 'react'
import { Brain, Copy, FileText, FolderOpen, Save, Play, Trash2 } from 'lucide-react'
import { popScreen, pushScreen } from '../lib/store'
import PlatformLogo from '../components/PlatformLogo'
import JobProgress, { cleanErrorMessage } from '../components/JobProgress'
import { useSources } from '../lib/sources'
import { backendLabel } from '../lib/instagram'
import { formatCopyToast } from '../lib/formatTokens'

const MODE_LABELS = {
  last_n:     'Последние N сообщений',
  all:        'Весь чат',
  from_date:  'С даты',
  date_range: 'Диапазон дат',
  between:    'Между двумя URL',
  single:     'Одно сообщение',
}

// Reconstruct content-type labels from the per-flag params we pass to
// tg_fetch_json. `text` is implicit (always saved) and shown by default.
// Falls back to the raw `types` array for folder-batch jobs that send the
// list directly. Returns null when there's nothing to surface.
function tgContentLabels(params) {
  if (!params) return null
  if (Array.isArray(params.types) && params.types.length > 0) {
    return params.types.map(t => TG_TYPE_LABEL[t] || t).join(' · ')
  }
  const labels = ['Текст']
  if (params.process_voice) labels.push('Голосовые / Видео')
  if (params.process_photo) labels.push('Фото')
  if (params.process_docs)  labels.push('Документы')
  if (params.process_polls) labels.push('Опросы')
  if (params.include_comments) labels.push('Комментарии')
  return labels.join(' · ')
}

// Telegram message-type → media_phase kind. type_breakdown groups by physical
// item type (voice, video, audio…), media_phase groups by AI-processing pipeline
// (voice = any audio extracted, photo = vision, pdf = doc extractor). One bucket
// in media_phase can be fed by multiple types — voice/video/audio all share the
// «voice» slot since the same transcriber handles them. Types without a media
// pipeline (text, poll, sticker, gif, service, other, comments) return null →
// the chip stays a plain summary, not a clickable details.
const TG_TYPE_TO_MEDIA_KIND = {
  voice: 'voice',
  video: 'voice',
  audio: 'voice',
  photo: 'photo',
  docs:     'pdf',
  document: 'pdf',
}

// Mirrors Python tg_fetch_json::classify() return values. Every type the
// classifier emits should have an entry — otherwise `Object.entries(type_breakdown)`
// in TelegramBody falls back to the raw token (e.g. `sticker 5`) which looks
// like a bug, not a category.
const TG_TYPE_LABEL = {
  text:     'Текст',
  voice:    'Голос',
  video:    'Видео',
  photo:    'Фото',
  audio:    'Аудио',
  sticker:  'Стикеры',
  gif:      'GIF',
  docs:     'Документы',
  document: 'Документы',
  poll:     'Опросы',
  service:  'Системные',          // pinned / joined / title-changed / etc.
  other:    'Прочее',
  comments: 'Комментарии',
}

export default function JobDetail({ payload }) {
  const id = payload?.jobId
  const [job, setJob] = useState(payload?.job || null)
  const [busy, setBusy] = useState(null)
  const [toast, setToast] = useState(null)
  // Inline confirmation flash on the Copy button — replaces the label
  // for ~2s so the user sees what they actually copied (token estimate +
  // size). Toast below stays for non-copy actions (Open, Reveal).
  const [copyFlash, setCopyFlash] = useState(null)

  useEffect(() => {
    let alive = true
    if (!window.api || !id) return
    window.api.jobDetail(id).then(j => alive && setJob(j))
    const off = window.api.onJobUpdate(updated => {
      if (alive && updated && (updated.id === id || updated.db_id === id)) setJob(updated)
    })
    return () => { alive = false; off && off() }
  }, [id])

  if (!job) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-500">
        Загрузка задачи…
      </div>
    )
  }

  async function copyFile() {
    setBusy('copy')
    try {
      const r = await window.api.copyFile(job.file_path)
      if (r.ok) {
        setCopyFlash(formatCopyToast({ bytes: r.bytes }))
      } else {
        setToast(`Ошибка: ${r.error}`)
      }
    } finally {
      setBusy(null)
      setTimeout(() => { setToast(null); setCopyFlash(null) }, 2200)
    }
  }
  async function openIn() {
    setBusy('open')
    try {
      const r = await window.api.openExternal(job.file_path)
      setToast(r.ok ? `Открыто в ${r.opener}` : `Ошибка: ${r.error}`)
    } finally {
      setBusy(null)
      setTimeout(() => setToast(null), 2200)
    }
  }
  async function reveal() {
    await window.api.revealInFinder(job.file_path)
  }

  const isYoutubeSingle        = job.type === 'yt_transcribe'
  const isYoutubeChannel       = job.type === 'yt_channel_fetch'
  const isYoutubeBatch         = job.type === 'yt_batch_transcribe'
  const isYoutubeComments      = job.type === 'yt_comments'
  const isYoutubeBatchComments = job.type === 'yt_batch_comments'
  const isYoutube              = isYoutubeSingle || isYoutubeChannel || isYoutubeBatch || isYoutubeComments || isYoutubeBatchComments
  const isTiktokSingle   = job.type === 'tk_transcribe'
  const isTiktokChannel  = job.type === 'tk_channel_fetch'
  const isTiktokBatch    = job.type === 'tk_batch_transcribe'
  const isTiktok         = isTiktokSingle || isTiktokChannel || isTiktokBatch
  const isIgProfile      = job.type === 'ig_profile_fetch'
  const isIgBatch        = job.type === 'ig_batch_transcribe'
  const isInstagram      = isIgProfile || isIgBatch
  const isTgPreview      = job.type === 'tg_preview'
  const isTgFolderFetch  = job.type === 'tg_folder_fetch' || job.type === 'tg_catchup'
  const isTgFolderRefresh = job.type === 'tg_folder_refresh'
  const isTgReplyBackfill = job.type === 'tg_reply_backfill'
  const isTgIndex        = job.type === 'tg_index'
  const isLocal          = job.type === 'local_transcribe'
  const headerLabel      = isYoutubeSingle        ? 'YouTube · транскрипт'
                         : isYoutubeComments      ? 'YouTube комментарии'
                         : isYoutubeBatchComments ? 'YouTube комментарии (пакет)'
                         : isYoutubeChannel       ? 'YouTube · канал'
                         : isYoutubeBatch         ? 'YouTube · пакетная транскрипция'
                         : isTiktokSingle   ? 'TikTok · транскрипт'
                         : isTiktokChannel  ? 'TikTok · канал'
                         : isTiktokBatch    ? 'TikTok · пакетная транскрипция'
                         : isIgProfile      ? 'Instagram · профиль'
                         : isIgBatch        ? 'Instagram · пакетная транскрипция'
                         : isTgPreview      ? 'Telegram · предпросмотр'
                         : isTgFolderFetch  ? (job.type === 'tg_catchup' ? 'Telegram · до конца' : 'Telegram · папка')
                         : isTgFolderRefresh ? 'Telegram · обновление папок'
                         : isTgReplyBackfill ? 'Telegram · reply backfill'
                         : isTgIndex        ? 'Семантический индекс'
                         : isLocal          ? 'Локальный файл'
                         : 'Telegram · парсинг'
  const headerPlatform   = isYoutube   ? 'youtube'
                         : isTiktok    ? 'tiktok'
                         : isInstagram ? 'instagram'
                         : isLocal     ? 'local'
                         : 'telegram'
  const isTelegramFetch = job.type === 'tg_fetch'
  const canShowAutoRag = isTelegramFetch
    && job.params?.mode !== 'single'
    && job.params?.mode !== 'media_only'
  const autoRagEnabled = job.params?._auto_index_after_fetch === true
  const autoRagStarted = job.params?._auto_index_after_fetch_started || null
  const autoRagNoop = job.params?._auto_index_after_fetch_noop || null
  const autoRagError = job.params?._auto_index_after_fetch_error || null
  const autoRagLocked = !!autoRagStarted || !!autoRagNoop
  const canToggleAutoRag = canShowAutoRag
    && !autoRagLocked
    && !['error', 'cancelled', 'interrupted'].includes(job.status)
    && busy !== 'auto-rag'
  const showStopButton = job.status === 'running'
    || job.status === 'pending'
    || job.status === 'awaiting_ai'
  const autoRagLabel = autoRagStarted
    ? 'RAG запущен'
    : autoRagNoop
      ? 'RAG готов'
      : autoRagEnabled
        ? 'Google RAG включён'
        : 'Google RAG'
  const autoRagTitle = autoRagStarted
    ? 'Семантическая индексация уже запущена после этого парсинга'
    : autoRagNoop
      ? 'Все сохранённые сообщения уже были проиндексированы'
      : autoRagError
        ? `Автозапуск RAG не сработал: ${autoRagError}`
        : autoRagEnabled
          ? 'После успешного завершения этого парсинга запустится RAG-индексация Gemini'
          : 'Включить автозапуск RAG-индексации Gemini после завершения парсинга'

  async function deleteJob() {
    if (!window.confirm(isYoutubeSingle
      ? 'Удалить транскрипт из истории? Файл .txt останется на диске.'
      : 'Удалить запись из истории? Видео и транскрипты остаются.'
    )) return
    await window.api.jobsDeleteOne(id)
    popScreen()
  }

  async function toggleAutoRag() {
    if (!canToggleAutoRag || !window.api?.jobSetAutoIndexAfterFetch) return
    const nextEnabled = !autoRagEnabled
    setBusy('auto-rag')
    try {
      const r = await window.api.jobSetAutoIndexAfterFetch({
        jobId: job.db_id || job.id,
        enabled: nextEnabled,
      })
      if (r?.ok) {
        if (r.job) setJob(r.job)
        else {
          setJob(j => ({
            ...j,
            params: { ...(j.params || {}), _auto_index_after_fetch: nextEnabled },
          }))
        }
        const auto = r.auto || null
        if (auto?.noop) {
          setToast('RAG уже готов: новых сообщений для индексации нет')
        } else if (auto?.jobId) {
          setToast(`RAG-индексация запущена · #${auto.jobId}`)
        } else {
          setToast(nextEnabled ? 'Google RAG включён' : 'Google RAG выключен')
        }
      } else {
        setToast(`Ошибка: ${r?.error || 'не удалось изменить RAG-переключатель'}`)
      }
    } finally {
      setBusy(null)
      setTimeout(() => setToast(null), 2600)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto px-8 py-6">
        <div className="max-w-2xl">
          {/* Job identity row — replaces the old header bar.  Breadcrumbs
              above already provide back-navigation. */}
          <div className="mb-6 flex items-center gap-3">
            <PlatformLogo platform={headerPlatform} size={18} />
            <span className="text-xl font-semibold text-zinc-100">{headerLabel}</span>
            <span className="text-zinc-700">·</span>
            <span className="text-zinc-500">#{job.id}</span>
            <StatusPill status={job.status} />
            {(canShowAutoRag || showStopButton) && (
              <div className="ml-auto flex items-center gap-2">
                {canShowAutoRag && (
                  <button
                    type="button"
                    onClick={toggleAutoRag}
                    disabled={!canToggleAutoRag}
                    aria-pressed={autoRagEnabled || !!autoRagStarted || !!autoRagNoop}
                    title={autoRagTitle}
                    className={`min-w-[9.75rem] h-8 px-3 rounded-md inline-flex items-center justify-center gap-1.5 border tabular-nums disabled:cursor-not-allowed ${
                      autoRagStarted || autoRagNoop
                        ? 'bg-zinc-800 border-zinc-700 text-zinc-400'
                        : autoRagEnabled
                          ? 'bg-emerald-900/30 border-emerald-700/60 text-emerald-300 hover:bg-emerald-900/45'
                          : autoRagError
                            ? 'bg-red-950/20 border-red-800/50 text-red-300 hover:bg-red-950/30'
                            : 'text-zinc-400 border-zinc-800 hover:bg-zinc-900 hover:text-zinc-200'
                    } ${busy === 'auto-rag' ? 'opacity-60' : ''}`}
                    style={{ fontSize: '13px' }}
                  >
                    <Brain size={14} className="shrink-0" />
                    {busy === 'auto-rag' ? 'Сохраняю…' : autoRagLabel}
                  </button>
                )}
                {/* Stop button — same IPC ActivityPanel uses. Visible only while
                    the job is alive. After click status flips to 'cancelled'
                    via job:update and this branch unmounts on its own. */}
                {showStopButton && (
                  <button
                    onClick={async () => {
                      setBusy('cancel')
                      try { await window.api.cancelJob(job.id) } catch {}
                      setBusy(null)
                    }}
                    disabled={busy === 'cancel'}
                    title="Остановить выполнение"
                    className="min-w-[7.5rem] text-center px-2.5 py-1 rounded text-amber-400 border border-amber-700/40 hover:bg-amber-900/20 hover:text-amber-300 disabled:opacity-50"
                    style={{ fontSize: '13px' }}
                  >
                    {busy === 'cancel' ? 'Останавливаю…' : 'Стоп'}
                  </button>
                )}
              </div>
            )}
          </div>

          {isYoutubeSingle        && <YoutubeBody job={job} busy={busy} toast={toast} copyFile={copyFile} copyFlash={copyFlash} openIn={openIn} reveal={reveal} />}
          {isYoutubeComments      && <YoutubeCommentsBody job={job} busy={busy} toast={toast} copyFile={copyFile} copyFlash={copyFlash} openIn={openIn} reveal={reveal} />}
          {isYoutubeChannel       && <YoutubeChannelBody job={job} />}
          {isYoutubeBatch         && <YoutubeBatchBody   job={job} />}
          {isYoutubeBatchComments && <YoutubeBatchCommentsBody job={job} />}
          {/* TikTok jobs share the YT body shape (entity_title, file_path,
              yt vs tk fields). Bodies read both job.tk and job.yt — we
              normalise via mirrorTkToYt so the YT renderer just works. */}
          {isTiktokSingle   && <YoutubeBody job={mirrorTkToYt(job)} busy={busy} toast={toast} copyFile={copyFile} copyFlash={copyFlash} openIn={openIn} reveal={reveal} />}
          {isTiktokChannel  && <YoutubeChannelBody job={mirrorTkToYt(job)} />}
          {isTiktokBatch    && <YoutubeBatchBody   job={mirrorTkToYt(job)} />}
          {isIgProfile      && <InstagramProfileBody job={job} />}
          {isIgBatch        && <InstagramBatchBody  job={job} busy={busy} toast={toast} copyFile={copyFile} copyFlash={copyFlash} openIn={openIn} reveal={reveal} />}
          {isTgPreview      && <TelegramPreviewBody job={job} />}
          {isTgFolderFetch  && <TelegramFolderFetchBody job={job} />}
          {isTgFolderRefresh && <TelegramFolderRefreshBody job={job} />}
          {isTgIndex        && <TelegramIndexBody job={job} />}
          {isTgReplyBackfill && <TelegramReplyBackfillBody job={job} />}
          {isLocal          && <LocalBody job={job} busy={busy} toast={toast} copyFile={copyFile} copyFlash={copyFlash} openIn={openIn} reveal={reveal} />}
          {!isYoutube && !isTiktok && !isInstagram && !isTgPreview && !isTgFolderFetch && !isTgFolderRefresh && !isTgIndex && !isTgReplyBackfill && !isLocal && <TelegramBody job={job} busy={busy} toast={toast} copyFile={copyFile} copyFlash={copyFlash} openIn={openIn} reveal={reveal} />}

          {window.api && (
            <div className="mt-12 pt-6 border-t border-zinc-900">
              <div className="text-xs uppercase tracking-wider text-zinc-600 mb-3">Опасная зона</div>
              <button
                onClick={deleteJob}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-red-400 border border-red-900/60 hover:bg-red-900/20 hover:text-red-300"
              >
                <Trash2 size={16} />
                Удалить запись
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Reuse YouTube body components for TikTok jobs by mirroring the per-platform
// snapshot fields. Shape is identical (same job-runner contract) — only the
// key prefix differs.
function mirrorTkToYt(job) {
  if (!job) return job
  return {
    ...job,
    yt:         job.yt         ?? job.tk         ?? null,
    yt_channel: job.yt_channel ?? job.tk_channel ?? null,
    yt_batch:   job.yt_batch   ?? job.tk_batch   ?? null,
  }
}

function TelegramPreviewBody({ job }) {
  const s = job.preview_summary || null
  const total = s?.items_total ?? job.items_done ?? 0
  return (
    <>
      <EntityCard platform="telegram" target={job.target} title={job.entity_title} kind={job.entity_kind} />

      <Section title="Предварительный анализ">
        <KV k="Найдено" v={total.toLocaleString('ru-RU') + ' сообщений'} />
        {s?.type_counts && Object.keys(s.type_counts).length > 0 && (
          <KV k="По типам" v={
            <span className="space-x-2">
              {Object.entries(s.type_counts).map(([t, n]) => (
                <span key={t} className="inline-block text-zinc-300 bg-zinc-800 rounded px-1.5 py-0.5 text-xs">
                  {TG_TYPE_LABEL[t] || t} <span className="text-zinc-500">{n}</span>
                </span>
              ))}
            </span>
          } />
        )}
        {s?.date_min && s?.date_max && (
          <KV k="Даты" v={`${s.date_min.slice(0, 10)} — ${s.date_max.slice(0, 10)}`} />
        )}
        {s && s.total_senders > 1 && (
          <KV k="Отправителей" v={
            <span>
              {s.total_senders}
              {s.senders?.[0] && (
                <span className="text-zinc-500"> · топ: {s.senders.slice(0, 3).map(x => `${x.name} (${x.count})`).join(', ')}</span>
              )}
            </span>
          } />
        )}
        {s && (s.voice_seconds > 0 || s.video_seconds > 0) && (
          <KV k="Длительность медиа"
              v={fmtDurationLong((s.voice_seconds || 0) + (s.video_seconds || 0))} />
        )}
      </Section>

      <Section title="Параметры запуска">
        <KV k="Режим" v={MODE_LABELS[job.params?.mode] || job.params?.mode || '—'} />
        {job.params?.limit != null && <KV k="Лимит" v={job.params.limit} />}
        {job.params?.date && (
          <KV k={job.params.date_to ? 'Период' : 'С даты'}
              v={job.params.date_to ? `${job.params.date} — ${job.params.date_to}` : job.params.date} />
        )}
        {tgContentLabels(job.params) && (
          <KV k="Типы контента" v={tgContentLabels(job.params)} />
        )}
        {(job.params?.process_voice || job.params?.process_photo
          || job.params?.process_docs) && job.params?.transcribe_engine && (
          <KV k="Движок" v={job.params.transcribe_engine} />
        )}
        {Array.isArray(job.params?.topic_ids) && job.params.topic_ids.length > 0 && (
          <KV k="Темы (id)" v={job.params.topic_ids.join(', ')} />
        )}
        {job.params?.include_comments && job.params?.comments_limit > 0 && (
          <KV k="Комментариев на пост" v={job.params.comments_limit} />
        )}
        <KV k="Длительность" v={
          (job.finished_at && job.started_at) ? (job.finished_at - job.started_at) + 's' : '—'
        } />
        <KV k="Запущено"  v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено" v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>
    </>
  )
}

function TelegramFolderFetchBody({ job }) {
  const f = job.tg_folder || {}
  const perChat = Array.isArray(f.per_chat) ? f.per_chat : []
  const totalItems = perChat.reduce((acc, p) => acc + (p.items_done || 0), 0)
  const errors     = perChat.filter(p => p.status === 'error').length
  return (
    <>
      <Section title="Папка">
        <KV k="Папка"  v={`#${f.folder_id ?? '?'}`} />
        <KV k="Чатов"  v={`${f.done_chats || 0} / ${f.total_chats || perChat.length}`} />
        <KV k="Сообщений"  v={totalItems.toLocaleString('ru-RU')} />
        {errors > 0 && <KV k="С ошибкой" v={<span className="text-red-300">{errors}</span>} />}
      </Section>

      <Section title="Параметры запуска">
        <KV k="Режим" v={MODE_LABELS[job.params?.mode] || job.params?.mode || '—'} />
        {job.params?.date && (
          <KV k={job.params.date_to ? 'Период' : 'С даты'}
              v={job.params.date_to ? `${job.params.date} — ${job.params.date_to}` : job.params.date} />
        )}
        {tgContentLabels(job.params) && (
          <KV k="Типы контента" v={tgContentLabels(job.params)} />
        )}
        {job.params?.engine && <KV k="Движок" v={job.params.engine} />}
        <KV k="Запущено"  v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено" v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>

      {perChat.length > 0 && (
        <Section title="Чаты">
          <ul className="space-y-1">
            {perChat.map((p, i) => (
              <li key={i} className="flex items-center gap-3" style={{ fontSize: '14px' }}>
                <span className="text-zinc-300 truncate flex-1">@{String(p.target || '').replace(/^@/, '')}</span>
                {p.status === 'done' && (
                  <span className="text-emerald-400 tabular-nums">✓ {p.items_done || 0}</span>
                )}
                {p.status === 'error' && (
                  <span className="text-red-300" title={p.error || ''}>✗ ошибка</span>
                )}
                {p.status === 'cancelled' && (
                  <span className="text-zinc-500">отменено</span>
                )}
              </li>
            ))}
            {f.current_target && (
              <li className="flex items-center gap-3 text-emerald-400" style={{ fontSize: '14px' }}>
                <span className="truncate flex-1">↻ парсю @{String(f.current_target).replace(/^@/, '')}</span>
              </li>
            )}
          </ul>
        </Section>
      )}
    </>
  )
}

function TelegramFolderRefreshBody({ job }) {
  const r = job.tg_folder_refresh || {}
  return (
    <>
      <Section title="Обновление папок">
        <KV k="Папок найдено"   v={r.total_folders ?? job.items_total ?? 0} />
        <KV k="Обработано"       v={`${r.done_folders || 0} / ${r.total_folders || 0}`} />
        <KV k="Синхронизировано" v={r.synced || 0} />
        <KV k="Удалено локально" v={r.removed || 0} />
        {r.current_title && job.status === 'running' && (
          <KV k="Сейчас" v={<span className="text-emerald-400">↻ {r.current_title}</span>} />
        )}
      </Section>

      <Section title="Параметры запуска">
        <KV k="Запущено"  v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено" v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>
    </>
  )
}

function fmtDurationLong(secs) {
  if (!secs) return '0s'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return [h && `${h}h`, (h || m) && `${m}m`, `${s}s`].filter(Boolean).join(' ')
}

// ─── tg_index: semantic indexing ─────────────────────────────────────
// Doesn't have a target/mode/file output — IndexJob writes vectors into
// items_vec, no .json artefact. Keep the panel narrow: progress + run
// times + interrupted reminder. The TelegramBody for tg_fetch wouldn't
// fit because it shows a "Файл результата" placeholder we'd never fill.
function TelegramIndexBody({ job }) {
  const total = job.items_total ?? 0
  const done  = job.items_done ?? 0
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0
  const dur = (job.finished_at && job.started_at)
    ? job.finished_at - job.started_at
    : null
  return (
    <>
      <Section title="Индексация">
        <KV k="Всего"        v={total ? total.toLocaleString('ru-RU') : '—'} />
        <KV k="Обработано"   v={total
          ? `${done.toLocaleString('ru-RU')} (${pct}%)`
          : done.toLocaleString('ru-RU')}
        />
        <KV k="Длительность" v={dur != null ? fmtDurationLong(dur) : '—'} />
        <KV k="Запущено"     v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено"    v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.status === 'interrupted' && (
          <KV k="Статус" v={
            <span className="text-amber-400">
              Прервано на рестарте — запусти индексацию заново, продолжит с того же места
            </span>
          } />
        )}
        {job.status === 'cancelled' && (
          <KV k="Статус" v={
            <span className="text-zinc-400">
              Остановлено пользователем · {done.toLocaleString('ru-RU')} из {total.toLocaleString('ru-RU')} проиндексировано
            </span>
          } />
        )}
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>
    </>
  )
}

// Reply-backfill is similarly metadata-only — sweeps existing items.
function TelegramReplyBackfillBody({ job }) {
  const total = job.items_total ?? 0
  const done  = job.items_done ?? 0
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0
  const dur = (job.finished_at && job.started_at)
    ? job.finished_at - job.started_at
    : null
  return (
    <>
      <Section title="Reply-граф">
        <KV k="Всего сообщений" v={total ? total.toLocaleString('ru-RU') : '—'} />
        <KV k="Обработано"      v={total
          ? `${done.toLocaleString('ru-RU')} (${pct}%)`
          : done.toLocaleString('ru-RU')}
        />
        <KV k="Длительность"    v={dur != null ? fmtDurationLong(dur) : '—'} />
        <KV k="Запущено"        v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено"       v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.status === 'interrupted' && (
          <KV k="Статус" v={<span className="text-amber-400">Прервано на рестарте</span>} />
        )}
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>
    </>
  )
}

// «По типам» chips with embedded media_phase errors/skipped. For types whose
// AI pipeline reported failures (voice/video/audio → voice slot, photo, pdf)
// the chip becomes a clickable <details>. The chip itself shows count + an
// amber «⚠ N» so the user sees there's something to expand without opening
// every chip. Types without an AI pipeline (text, sticker, gif, service, …)
// render as a plain non-clickable chip — same as before.
//
// Re-uses cleanErrorMessage from JobProgress (strips `AssemblyAI error: …` /
// `ValueError: …` prefixes), so the same message text appears in the live
// «Сейчас» block above and in the static «Что собрано» below.
function TypeBreakdownChips({ breakdown, mediaPhase }) {
  const entries = Object.entries(breakdown || {})
  if (!entries.length) return null
  return (
    <span className="inline-flex flex-wrap gap-2">
      {entries.map(([type, count]) => {
        const kind = TG_TYPE_TO_MEDIA_KIND[type] || null
        const slot = kind && mediaPhase ? mediaPhase[kind] : null
        const errs = slot?.errors || 0
        const skipped = slot?.skipped || 0
        const errs_log = Array.isArray(slot?.errors_log) ? slot.errors_log : []
        const skip_log = Array.isArray(slot?.skipped_log) ? slot.skipped_log : []
        const issueCount = errs + skipped
        const hasDetails = kind && issueCount > 0 && (errs_log.length + skip_log.length) > 0
        const label = TG_TYPE_LABEL[type] || type
        const chipBase = 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-zinc-800'
        if (!hasDetails) {
          return (
            <span key={type} className={`${chipBase} text-xs text-zinc-300`}>
              {label} <span className="text-zinc-500 tabular-nums">{count}</span>
            </span>
          )
        }
        return (
          <details key={type} className="group inline-block align-top">
            <summary
              className={`${chipBase} text-xs text-zinc-300 cursor-pointer hover:bg-zinc-700/70 list-none select-none`}
              style={{ fontSize: '14px' }}
            >
              <span>{label}</span>
              <span className="text-zinc-500 tabular-nums">{count}</span>
              <span
                className="text-red-400 tabular-nums"
                title={`${issueCount} с ошибками или пропущенных — кликни чтобы развернуть`}
              >
                ⚠ {issueCount}
              </span>
              <span className="text-zinc-600 ml-0.5 group-open:rotate-90 transition-transform">›</span>
            </summary>
            <div className="mt-2 ml-1 mb-1 rounded border border-zinc-800 bg-zinc-950 p-2 space-y-2 max-w-xl">
              {errs > 0 && errs_log.length > 0 && (
                <div>
                  <div className="text-red-400/80 mb-1" style={{ fontSize: '13px' }}>
                    Ошибки ({errs_log.length}{errs > errs_log.length ? `/${errs}` : ''})
                  </div>
                  <ul className="space-y-0.5" style={{ fontSize: '12px' }}>
                    {errs_log.map((e, i) => (
                      <li key={`e${i}`} className="text-zinc-500">
                        {e.msg_id && <span className="text-zinc-600 mr-2">msg #{e.msg_id}</span>}
                        <span className="text-red-400/90">{cleanErrorMessage(e.message)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {skipped > 0 && skip_log.length > 0 && (
                <div>
                  <div className="text-zinc-400 mb-1" style={{ fontSize: '13px' }}>
                    Пропущено ({skip_log.length}{skipped > skip_log.length ? `/${skipped}` : ''})
                  </div>
                  <ul className="space-y-0.5" style={{ fontSize: '12px' }}>
                    {skip_log.map((e, i) => (
                      <li key={`s${i}`} className="text-zinc-500">
                        {e.msg_id && <span className="text-zinc-600 mr-2">msg #{e.msg_id}</span>}
                        <span className="text-zinc-400">{e.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        )
      })}
    </span>
  )
}

function TelegramBody({ job, busy, toast, copyFile, openIn, reveal }) {
  // Pre-entity dialog walk: tg_fetch_json's _resolve_via_dialog_walk fallback
  // streams `resolve_progress` events while it scans iter_dialogs() looking
  // for a private chat by title. Show a hint above the unified progress
  // panel so the user knows what the «Поиск чата» counter actually means.
  const stillResolving =
    job.status === 'running' && !job.entity_title && !job.items_done
  // Show the live progress block whenever there's anything dynamic to render
  // (resolve walk, items counter, or any media-kind activity). Once the job
  // is done JobProgress shows the final counters; we hide it then because
  // the static «Что собрано» Section below already covers that case more
  // richly (with type breakdown, duration, dates).
  const isLive = job.status === 'running' || job.status === 'awaiting_ai'
  return (
    <>
      <EntityCard platform="telegram" target={job.target} title={job.entity_title} kind={job.entity_kind} />

      {/* Empty-result notice (amber) — turns a mute «готово · 0» into a plain
          «ничего не найдено». Neutral by design: an empty fetch is never a
          wrong target (personal chats parse fine — they were just empty).
          Carried on job.warning by job-runner (snapshot + historic hydration);
          the message is already user-ready Russian. */}
      {!job.error && job.warning?.message && (
        <div className="mt-4 rounded-lg border border-amber-700/40 bg-amber-950/30 px-4 py-3 text-amber-200/90 leading-relaxed"
             style={{ fontSize: '13px' }}>
          {job.warning.message}
        </div>
      )}

      {isLive && (
        <Section title="Сейчас">
          <JobProgress job={job} variant="full" />
          {stillResolving && job.resolve_scanned > 0 && (
            <div className="text-zinc-500 mt-2" style={{ fontSize: '13px' }}>
              Это приватный чат — Telegram не умеет искать его по названию,
              ищем линейным проходом по всем диалогам сессии.
            </div>
          )}
        </Section>
      )}

      <Section title="Что собрано">
        <KV k="Айтемов всего" v={job.items_total ?? job.items_done ?? 0} />
        {job.type_breakdown && Object.keys(job.type_breakdown).length > 0 && (
          <KV k="По типам" v={
            <TypeBreakdownChips
              breakdown={job.type_breakdown}
              mediaPhase={job.media_phase}
            />
          } />
        )}
        <KV k="Длительность" v={`${
          (job.finished_at && job.started_at)
            ? (job.finished_at - job.started_at) + 's'
            : '—'
        }`} />
        <KV k="Запущено"   v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено"  v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>

      <Section title="Параметры запуска">
        <KV k="Режим"  v={MODE_LABELS[job.params?.mode] || job.params?.mode || '—'} />
        {job.params?.limit != null && <KV k="Лимит" v={job.params.limit} />}
        {job.params?.date  && (
          <KV k={job.params?.date_to ? 'Период' : 'Дата'}
              v={job.params?.date_to ? `${job.params.date} — ${job.params.date_to}` : job.params.date} />
        )}
        {job.params?._range_plan?.intervals_total > 1 && (
          <KV k="План" v={`${job.params._range_plan.intervals_total} непокрытых интервала`} />
        )}
        {job.params?.url   && <KV k="URL"   v={
          <a
            href="#"
            onClick={e => { e.preventDefault(); window.api?.openUrl?.(job.params.url) }}
            className="text-xs break-all text-zinc-300 hover:text-zinc-100 underline decoration-zinc-700 hover:decoration-zinc-400"
            title={job.params.url}
          >
            <code>{job.params.url}</code>
          </a>
        } />}
      </Section>

      <FileCard job={job} busy={busy} toast={toast} copyFile={copyFile} openIn={openIn} reveal={reveal} />
    </>
  )
}

function YoutubeCommentsBody({ job, busy, toast, copyFile, copyFlash, openIn, reveal }) {
  const yc = job.yt_comments || {}
  const p  = job.params || {}
  const sortLabel  = (yc.sort  || p.sort)  === 'top' ? 'по топу' : 'по новизне'
  const limit      = (yc.limit != null ? yc.limit : p.limit)
  const limitLabel = !limit ? 'все доступные' : Number(limit).toLocaleString('ru-RU')
  const replies    = (yc.include_replies != null ? yc.include_replies : p.include_replies)
  const total      = yc.count_total   ?? p.count_total
  const top        = yc.count_top     ?? p.count_top
  const repliesN   = yc.count_replies ?? p.count_replies
  return (
    <>
      {/* Вся карточка кликабельна → открыть видео на YouTube (target = watch-URL).
          Та же механика, что у YoutubeCard выше. */}
      <div
        onClick={() => job.target && window.api?.openUrl?.(job.target)}
        role="button"
        title="Открыть видео на YouTube"
        className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 flex items-center gap-4 cursor-pointer hover:border-zinc-600 transition-colors"
      >
        <PlatformLogo platform="youtube" size={32} />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">
            {yc.title || job.entity_title || 'Комментарии'}
          </div>
          <div className="text-zinc-500 truncate" style={{ fontSize: '14px' }}>
            {yc.channel ? <>{yc.channel} · </> : null}
            <code className="text-xs break-all">{job.target}</code>
          </div>
        </div>
      </div>

      <Section title="Параметры">
        <KV k="Сортировка" v={sortLabel} />
        <KV k="Лимит"      v={limitLabel} />
        <KV k="Ответы"     v={replies ? 'включены' : 'только верхнеуровневые'} />
      </Section>

      <Section title="Результат">
        {total != null && <KV k="Всего"   v={`${Number(total).toLocaleString('ru-RU')} комментариев`} />}
        {top != null   && <KV k="Тредов"  v={Number(top).toLocaleString('ru-RU')} />}
        {repliesN > 0  && <KV k="Ответов" v={Number(repliesN).toLocaleString('ru-RU')} />}
        <KV k="Запущено"   v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено"  v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>

      <FileCard
        job={job} busy={busy} toast={toast}
        copyFile={copyFile} copyFlash={copyFlash}
        openIn={openIn} reveal={reveal}
      />
    </>
  )
}

function YoutubeBatchCommentsBody({ job }) {
  const b = job.yt_batch || {}
  const total = job.items_total || (job.params?.video_ids?.length || 0)
  const done = (b.saved || 0) + (b.skipped || 0) + (b.errors || 0)
  const sortLabel = (job.params?.sort || 'new') === 'top' ? 'по топу' : 'по новизне'
  const limit = job.params?.limit
  const limitLabel = !limit ? 'все' : Number(limit).toLocaleString('ru-RU')
  const replies = !!(job.params?.includeReplies ?? job.params?.include_replies)
  // Live current-video detail.
  const cur = b.current
  // Per-video log (cached + saved + skipped + error all live in b.log).
  const logByVid = useMemo(() => {
    const m = new Map()
    for (const r of (b.log || [])) m.set(r.video_id, r)
    return m
  }, [b.log])
  const videoIds = Array.isArray(job.params?.video_ids) ? job.params.video_ids : []

  return (
    <>
      <Section title="Параметры">
        <KV k="Сортировка" v={sortLabel} />
        <KV k="Лимит на видео" v={limitLabel} />
        <KV k="Ответы"     v={replies ? 'включены' : 'только верхнеуровневые'} />
      </Section>

      <Section title="Прогресс">
        <KV k="Всего видео"   v={`${total}`} />
        <KV k="Сохранено"     v={`${b.saved || 0}`} />
        {(b.skipped || 0) > 0 && <KV k="Пропущено" v={`${b.skipped}`} />}
        {(b.errors  || 0) > 0 && <KV k="Ошибок"    v={<span className="text-red-400">{b.errors}</span>} />}
        <KV k="Запущено"   v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено"  v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>

      {cur && job.status === 'running' && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-zinc-600 border-t-zinc-200 animate-spin" />
            <span className="text-zinc-200 truncate">
              [{cur.i}/{cur.n}] {cur.title || cur.video_id}
            </span>
          </div>
          <div className="text-zinc-500 tabular-nums" style={{ fontSize: '14px' }}>
            {cur.got != null && cur.expected != null && cur.expected > 0
              ? `Получено ${cur.got.toLocaleString('ru-RU')} из ${cur.expected.toLocaleString('ru-RU')}…`
              : 'Подключаюсь…'}
          </div>
        </div>
      )}

      <Section title="Видео">
        <div className="rounded-md border border-zinc-800 divide-y divide-zinc-900 overflow-hidden">
          {videoIds.length === 0 && (
            <div className="px-3 py-2 text-zinc-600 italic" style={{ fontSize: '14px' }}>—</div>
          )}
          {videoIds.map(vid => {
            const r = logByVid.get(vid)
            return (
              <div key={vid} className="px-3 py-2 flex items-center gap-2 text-zinc-300" style={{ fontSize: '14px' }}>
                <span className="shrink-0">
                  {r?.kind === 'comments' && <span className="text-emerald-400">✓</span>}
                  {r?.kind === 'cache'    && <span className="text-emerald-300">✓ кэш</span>}
                  {r?.kind === 'skipped'  && <span className="text-zinc-500">— пропущено</span>}
                  {r?.kind === 'error'    && <span className="text-red-400">✗</span>}
                  {!r && <span className="text-zinc-600">○</span>}
                </span>
                <span className="font-mono text-zinc-500" style={{ fontSize: '12px' }}>{vid}</span>
                {r?.count_total != null && (
                  <span className="text-zinc-500 ml-auto tabular-nums">{Number(r.count_total).toLocaleString('ru-RU')}</span>
                )}
                {r?.message && <span className="text-red-400 ml-auto truncate max-w-[200px]" title={r.message}>{r.message}</span>}
              </div>
            )
          })}
        </div>
      </Section>
    </>
  )
}

function LocalBody({ job, busy, toast, copyFile, openIn, reveal }) {
  const local = job.local || {}
  const fileName = local.name || (job.target ? job.target.slice(job.target.lastIndexOf('/') + 1) : '—')
  return (
    <>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 flex items-center gap-4">
        <PlatformLogo platform="local" size={32} />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{fileName}</div>
          <div className="text-zinc-500 truncate" style={{ fontSize: '14px' }}>
            <code className="text-xs break-all">{job.target}</code>
          </div>
        </div>
      </div>

      <Section title="Транскрипт">
        <KV k="Источник" v={`AI · ${local.engine || job.params?.engine || ''}`.trim()} />
        {local.chars     != null && <KV k="Размер"     v={`${local.chars.toLocaleString('ru-RU')} символов`} />}
        {local.cost_usd  > 0     && <KV k="Стоимость"  v={`$${Number(local.cost_usd).toFixed(4)}`} />}
        {local.duration_sec > 0  && <KV k="Длина файла" v={fmtSecs(local.duration_sec)} />}
        {local.size_bytes != null && <KV k="Размер файла" v={fmtBytes(local.size_bytes)} />}
        <KV k="Запущено"  v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено" v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>

      <FileCard job={job} busy={busy} toast={toast} copyFile={copyFile} openIn={openIn} reveal={reveal} />
    </>
  )
}

function fmtBytes(n) {
  if (n == null) return ''
  if (n < 1024)        return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtMonthYear(unix) {
  if (!unix) return null
  const d = new Date(unix * 1000)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' }).replace('.', '')
}

function fmtDurShort(secs) {
  if (!secs) return '—'
  secs = Math.round(secs)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}ч ${m}м`
  if (m > 0) return `${m}м ${s.toString().padStart(2, '0')}с`
  return `${s}с`
}

function fmtViewsShort(n) {
  if (!n) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function SearchHeaderRow({ query, url }) {
  const display = (() => {
    if (!query && url) {
      try {
        const u = new URL(url)
        return (u.searchParams.get('search_query') || url).replace(/\+/g, ' ')
      } catch { return url }
    }
    return query
  })()
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 flex items-center gap-4">
      <div className="w-12 h-12 rounded-full bg-zinc-950 border border-zinc-800 shrink-0 flex items-center justify-center text-zinc-400 text-xl">
        🔍
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{display || '—'}</div>
        <div className="text-zinc-500" style={{ fontSize: '14px' }}>
          Поиск на YouTube
        </div>
      </div>
    </div>
  )
}

function YoutubeBody({ job, busy, toast, copyFile, openIn, reveal }) {
  const yt = job.yt || {}
  const src = yt.kind === 'ai' ? `AI · ${yt.engine || ''}`.trim() : `субтитры · ${yt.lang || ''}`.trim()
  return (
    <>
      <YoutubeCard yt={yt} url={job.target} title={job.entity_title} />

      <Section title="Транскрипт">
        <KV k="Источник" v={src} />
        {yt.chars   != null && <KV k="Размер"   v={`${yt.chars.toLocaleString('ru-RU')} символов`} />}
        {yt.cost_usd > 0  && <KV k="Стоимость" v={`$${Number(yt.cost_usd).toFixed(4)}`} />}
        {yt.duration_sec > 0 && <KV k="Видео"     v={fmtSecs(yt.duration_sec)} />}
        <KV k="Запущено"  v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено" v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>

      <FileCard job={job} busy={busy} toast={toast} copyFile={copyFile} openIn={openIn} reveal={reveal} />
    </>
  )
}

function YoutubeChannelBody({ job }) {
  const c = job.yt_channel || {}
  const sources = useSources()
  const matched = c.channel_id
    ? sources.find(s => s.platform === 'youtube' && s.external_id === c.channel_id)
    : null
  return (
    <>
      <div
        onClick={matched ? () => pushScreen('source-detail', { sourceId: matched.id, platform: matched.platform }) : undefined}
        role={matched ? 'button' : undefined}
        className={`bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 flex items-center gap-4 ${
          matched ? 'hover:border-zinc-600 cursor-pointer' : ''
        }`}
      >
        {c.avatar_url
          ? <img src={c.avatar_url} alt="" className="w-12 h-12 rounded-full bg-zinc-800 shrink-0" />
          : <PlatformLogo platform="youtube" size={32} />}
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{c.title || job.target}</div>
          <div className="text-zinc-500" style={{ fontSize: '14px' }}>
            {c.handle || '—'}
            {c.subs_count != null && <> · {c.subs_count.toLocaleString('ru-RU')} подписчиков</>}
          </div>
        </div>
        {matched && <span className="text-zinc-600 shrink-0">→</span>}
      </div>

      <Section title="Что собрано">
        <KV k="Видео получено" v={(job.items_done || 0).toLocaleString('ru-RU')} />
        {c.total_duration_sec ? <KV k="Общая длительность" v={fmtSecs(c.total_duration_sec)} /> : null}
        {(c.date_min && c.date_max) && (
          <KV k="Диапазон дат" v={`${formatDateOnly(c.date_min)} – ${formatDateOnly(c.date_max)}`} />
        )}
        <KV k="Длительность парсинга" v={`${(job.finished_at && job.started_at) ? (job.finished_at - job.started_at) + 's' : '—'}`} />
        <KV k="Запущено"  v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено" v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>
    </>
  )
}

function YoutubeBatchBody({ job }) {
  const b = job.yt_batch || {}
  const total = job.items_total || 0
  const done = (b.saved || 0) + (b.skipped || 0) + (b.errors || 0)
  const isSearch = !!job.params?.is_search
  const isInterrupted = job.status === 'interrupted'
  const [items, setItems] = useState([])           // [{external_id,title,url,transcript_path}]
  const [busy, setBusy] = useState(null)
  const [toast, setToast] = useState(null)
  const [estimate, setEstimate] = useState(null)   // { bytes, tokens, count }
  // Title-search filter — applied client-side over `items`. Long batches
  // (55+) are unscrollable without it.
  const [search, setSearch] = useState('')
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter(it => (it.title || '').toLowerCase().includes(q)
      || (it.uploader || '').toLowerCase().includes(q))
  }, [items, search])

  // Load items table to enrich the saved-video list with titles + paths.
  // For live jobs, b.log gives video_id+file_path; titles come from items.
  // For finished/restored jobs, b.log may be empty — items table is the
  // single source of truth.
  // For SEARCH-batches, items come from params.search_videos / video_files
  // (no items table involvement).
  useEffect(() => {
    let alive = true
    const sourceId = job.source_id || job.params?.source_id
    const videoIds = job.params?.video_ids

    if (isSearch && Array.isArray(videoIds)) {
      const meta = Array.isArray(job.params?.search_videos)
        ? new Map(job.params.search_videos.map(v => [v.video_id, v]))
        : new Map()
      const files = job.params?.video_files || {}
      // Augment with live b.log paths (for in-flight jobs, params.video_files
      // is empty until close).
      const liveFiles = new Map((b.log || [])
        .filter(r => r.file_path)
        .map(r => [r.video_id, r.file_path]))
      setItems(videoIds.map(vid => {
        const m = meta.get(vid) || {}
        return {
          external_id:     vid,
          title:           m.title || '',
          url:             m.url || `https://www.youtube.com/watch?v=${vid}`,
          duration_seconds: m.duration_sec || null,
          views:           m.view_count || null,
          published_at:    m.timestamp || null,
          uploader:        m.uploader || null,
          transcript_path: files[vid] || liveFiles.get(vid) || null,
        }
      }))
      return
    }

    if (!sourceId || !Array.isArray(videoIds) || videoIds.length === 0) {
      setItems([]); return
    }
    if (!window.api?.ytItemsState) return
    window.api.ytItemsState({ source_id: sourceId, video_ids: videoIds })
      .then(rows => {
        if (!alive) return
        // Preserve original order from params.video_ids
        const byId = new Map(rows.map(r => [r.external_id, r]))
        setItems(videoIds.map(vid => byId.get(vid) || { external_id: vid }))
      })
    return () => { alive = false }
  }, [job.id, job.source_id, job.status, isSearch, b.log])

  // Per-video status from b.log (live) takes precedence over items state.
  const logByVid = useMemo(() => {
    const m = new Map()
    for (const r of (b.log || [])) m.set(r.video_id, r)
    return m
  }, [b.log])

  // Token / size preview — sums file sizes server-side without reading bodies.
  // Fires after items are loaded so the user sees "~Nk токенов · KB" by the
  // time they reach for Copy all.
  useEffect(() => {
    if (!window.api?.ytAssembleBatch) { setEstimate(null); return }
    const hasAnyTranscript = items.some(it => it?.transcript_path) || (b.log || []).some(r => r.file_path)
    if (!hasAnyTranscript) { setEstimate(null); return }
    let alive = true
    ;(async () => {
      try {
        const r = await window.api.ytAssembleBatch({ jobId: job.id, action: 'estimate' })
        if (alive && r?.ok) setEstimate({ bytes: r.bytes, tokens: r.tokens, count: r.count })
      } catch {}
    })()
    return () => { alive = false }
  }, [job.id, items.length, b.log?.length])

  async function resume() {
    if (!window.api?.ytResumeBatch) return
    setBusy('resume')
    try {
      const r = await window.api.ytResumeBatch({ jobId: job.id })
      if (r?.ok) {
        setToast(`Продолжаем · ${r.remaining} из ${r.total} осталось`)
      } else if (r?.already_done) {
        setToast('Все видео уже транскрибированы')
      } else {
        setToast(`Не удалось: ${r?.error || 'unknown'}`)
      }
    } finally {
      setBusy(null)
      setTimeout(() => setToast(null), 3000)
    }
  }

  async function copyAll() {
    setBusy('copy')
    try {
      const r = await window.api.ytAssembleBatch({ jobId: job.id, action: 'copy' })
      setToast(r.ok ? `Скопировано · ${r.count} видео · ${formatBytes(r.bytes)}` : `Ошибка: ${r.error}`)
    } finally {
      setBusy(null)
      setTimeout(() => setToast(null), 2500)
    }
  }
  async function saveCombined() {
    setBusy('save')
    try {
      const r = await window.api.ytAssembleBatch({ jobId: job.id, action: 'save' })
      if (r.ok) {
        setToast(`Сохранено · ${r.count} видео · ${formatBytes(r.bytes)}`)
        if (r.file_path) window.api.openExternal(r.file_path)
      } else {
        setToast(`Ошибка: ${r.error}`)
      }
    } finally {
      setBusy(null)
      setTimeout(() => setToast(null), 2500)
    }
  }

  const savedCount = (items || []).filter(it => it?.transcript_path).length
                     || (b.saved || 0)

  return (
    <>
      {isSearch && (
        <SearchHeaderRow
          query={job.params?.search_query || ''}
          url={job.target}
        />
      )}

      <Section title="Прогресс">
        <KV k="Всего видео" v={total} />
        <KV k="Сохранено" v={<span className="text-emerald-400">{b.saved || savedCount}</span>} />
        {b.skipped > 0 && <KV k="Пропущено" v={b.skipped} />}
        {b.errors  > 0 && <KV k="Ошибок"   v={<span className="text-red-400">{b.errors}</span>} />}
        {b.cost_usd > 0 && <KV k="Потрачено" v={`$${Number(b.cost_usd).toFixed(4)}`} />}
        <KV k="Длительность" v={`${(job.finished_at && job.started_at) ? (job.finished_at - job.started_at) + 's' : '—'}`} />
        <KV k="Запущено"  v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено" v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>

      {isInterrupted && (
        <Section title="Транскрипция была прервана">
          <div className="text-zinc-400 mb-3" style={{ fontSize: '14px' }}>
            Приложение перезапустилось во время транскрипции.
            Можно продолжить — пропустим уже сохранённые видео.
          </div>
          <div className="flex gap-2">
            <Button onClick={resume} busy={busy === 'resume'}>
              <span className="inline-flex items-center gap-1.5"><Play size={14} />Продолжить</span>
            </Button>
          </div>
          {toast && <div className="text-xs text-zinc-400 mt-2">{toast}</div>}
        </Section>
      )}

      {savedCount > 0 && (
        <Section title="Все транскрипты">
          <div className="text-zinc-500 mb-3 flex items-center gap-3" style={{ fontSize: '14px' }}>
            <span>Все сохранённые тексты собираются в один блок через разделитель.</span>
            {estimate && (
              <span className="ml-auto tabular-nums text-zinc-400">
                ~<span className="text-zinc-200">{fmtTokensJobDetail(estimate.tokens)}</span> токенов · {formatBytes(estimate.bytes)}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={copyAll}      busy={busy === 'copy'}>
              <span className="inline-flex items-center gap-1.5"><Copy size={14} />Скопировать все</span>
            </Button>
            <Button onClick={saveCombined} busy={busy === 'save'}>
              <span className="inline-flex items-center gap-1.5"><Save size={14} />Сохранить вместе</span>
            </Button>
          </div>
          {toast && <div className="text-xs text-zinc-400 mt-2">{toast}</div>}
        </Section>
      )}

      <Section title={
        <div className="flex items-center gap-3">
          <span>Видео ({total})</span>
          {/* Title-search input — long batches (55+ rows) are unusable
              without one. Mirrors the picker's "Поиск по заголовку…"
              affordance so the search-mode UX is consistent. */}
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по заголовку…"
            className="ml-auto bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
            style={{ fontSize: '13px', width: 200 }}
          />
          {search && (
            <span className="text-zinc-500 tabular-nums" style={{ fontSize: '12px' }}>
              {filteredItems.length} из {items.length}
            </span>
          )}
        </div>
      }>
        <div className="max-h-96 overflow-auto -m-4 divide-y divide-zinc-900">
          {items.length === 0 && (b.log || []).length === 0 && (
            <div className="px-4 py-3 text-zinc-600 italic" style={{ fontSize: '14px' }}>Пока нет результатов</div>
          )}
          {filteredItems.length === 0 && items.length > 0 && search && (
            <div className="px-4 py-3 text-zinc-600 italic" style={{ fontSize: '14px' }}>Ничего не найдено</div>
          )}
          {filteredItems.map((it, idx) => {
            const log = logByVid.get(it.external_id)
            // Is this row the *currently in-flight* transcription?
            // b.current.video_id (set per-video in job-runner) is the
            // single source of truth — log[] only flips after completion.
            const isCurrent = job.status === 'running'
              && b.current?.video_id === it.external_id
            // After the job is done, log[] is empty for restored snapshots
            // (it's in-memory only). We fall back to: "✓ готово" if a file
            // exists, "✗ ошибка" if the job is finished and there's no file
            // (per-video error message is lost, but the *fact* of failure
            // is visible — was previously rendered as a confusing dash).
            const isFinishedJob = job.status === 'done' || job.status === 'error'
            const status = log
              ? (log.kind === 'subs'    ? { color: 'text-emerald-400', text: '✓ субтитры' }
              :  log.kind === 'ai'      ? { color: 'text-emerald-400', text: '✓ AI' }
              :  log.kind === 'cache'   ? { color: 'text-emerald-300', text: '✓ из кэша' }
              :  log.kind === 'skipped' ? { color: 'text-zinc-500',    text: 'пропущено' }
              :  log.kind === 'error'   ? { color: 'text-red-400',     text: 'ошибка' }
              :                           null)
              : (it.transcript_path
                  ? { color: 'text-emerald-400', text: '✓ готово' }
                  : isFinishedJob
                    ? { color: 'text-red-400', text: '✗ ошибка' }
                    : null)
            // Live row beats the resolved-status pill — spinner + engine name.
            const liveStatus = isCurrent ? {
              color: 'text-emerald-300',
              text:  b.current?.stage === 'transcribing'
                ? `↻ ${b.current.engine || 'AI'}…`
                : b.current?.stage === 'awaiting_ai'
                  ? '⌛ ждёт подтв.'
                  : b.current?.stage === 'subs_found'
                    ? '↻ субтитры…'
                    : '↻ ищем…',
            } : null
            const finalStatus = liveStatus || status
            const path = log?.file_path || it.transcript_path
            // Search-mode rows mirror the picker layout (no checkbox, finalized view):
            // date · title · uploader · ✓ · duration · views.
            if (isSearch) {
              return (
                <div
                  key={idx}
                  className={`px-4 py-2 flex items-center gap-3 ${isCurrent ? 'bg-emerald-950/30' : ''}`}
                  onClick={path ? () => window.api?.openExternal?.(path) : undefined}
                  role={path ? 'button' : undefined}
                  style={path ? { cursor: 'pointer' } : undefined}
                  title={path ? 'Открыть транскрипт' : undefined}
                >
                  <span className="text-zinc-500 shrink-0 tabular-nums whitespace-nowrap" style={{ fontSize: '14px' }}>
                    {fmtMonthYear(it.published_at) || '—'}
                  </span>
                  <span className="text-zinc-200 truncate flex-1" title={it.title}>
                    {it.title || <code className="text-zinc-500" style={{ fontSize: '13px' }}>{it.external_id}</code>}
                  </span>
                  {it.uploader && (
                    <span className="text-zinc-500 shrink-0 truncate max-w-[120px]" style={{ fontSize: '13px' }} title={it.uploader}>
                      {it.uploader}
                    </span>
                  )}
                  {finalStatus ? (
                    <span className={`${finalStatus.color} shrink-0 inline-flex items-center gap-1`} style={{ fontSize: '14px' }}>
                      {isCurrent && <Spinner />}
                      {finalStatus.text}
                    </span>
                  ) : (
                    <span className="text-zinc-600 shrink-0" style={{ fontSize: '14px' }}>—</span>
                  )}
                  <span className="text-zinc-500 shrink-0 tabular-nums whitespace-nowrap" style={{ fontSize: '14px' }}>
                    {fmtDurShort(it.duration_seconds)}
                  </span>
                  {it.views != null && (
                    <span className="text-zinc-600 shrink-0 tabular-nums whitespace-nowrap" style={{ fontSize: '14px' }}>
                      {fmtViewsShort(it.views)}
                    </span>
                  )}
                </div>
              )
            }
            return (
              // Вся строка кликабельна, когда есть транскрипт (path) — то же
              // действие, что кнопка «Открыть». Search-режим выше уже так
              // работает; channel-режим разъезжался с ним.
              <div
                key={idx}
                onClick={path ? () => window.api?.openExternal?.(path) : undefined}
                role={path ? 'button' : undefined}
                title={path ? 'Открыть транскрипт' : undefined}
                className={`px-4 py-2 flex items-center gap-3 ${isCurrent ? 'bg-emerald-950/30' : ''} ${path ? 'cursor-pointer hover:bg-zinc-900/60' : ''}`}
              >
                {finalStatus ? (
                  <span style={{ fontSize: '14px' }} className={`${finalStatus.color} shrink-0 inline-flex items-center gap-1`}>
                    {isCurrent && <Spinner />}
                    {finalStatus.text}
                  </span>
                ) : (
                  <span style={{ fontSize: '14px' }} className="text-zinc-600 shrink-0">—</span>
                )}
                <span className="text-zinc-200 truncate flex-1" title={it.title}>
                  {it.title || <code className="text-zinc-500" style={{ fontSize: '13px' }}>{it.external_id}</code>}
                </span>
                {log?.message && <span className="text-zinc-500 truncate" style={{ fontSize: '14px' }} title={log.message}>{log.message}</span>}
                {path && (
                  <button
                    onClick={e => { e.stopPropagation(); window.api?.openExternal?.(path) }}
                    className="text-zinc-500 hover:text-zinc-200 shrink-0"
                    style={{ fontSize: '14px' }}
                  >Открыть</button>
                )}
              </div>
            )
          })}
          {items.length === 0 && (b.log || []).map((row, idx) => (
            <div key={idx} className="px-4 py-2 flex items-center gap-3">
              <span style={{ fontSize: '14px' }}>
                {row.kind === 'subs'    ? <span className="text-emerald-400">✓ субтитры</span>
                : row.kind === 'ai'     ? <span className="text-emerald-400">✓ AI</span>
                : row.kind === 'skipped'? <span className="text-zinc-500">пропущено</span>
                : row.kind === 'error'  ? <span className="text-red-400">ошибка</span>
                : '—'}
              </span>
              <code className="text-zinc-500 shrink-0" style={{ fontSize: '13px' }}>{row.video_id}</code>
              {row.message && <span className="text-zinc-500 truncate" style={{ fontSize: '14px' }} title={row.message}>{row.message}</span>}
              {row.file_path && (
                <button
                  onClick={() => window.api?.openExternal?.(row.file_path)}
                  className="ml-auto text-zinc-500 hover:text-zinc-200 shrink-0"
                  style={{ fontSize: '14px' }}
                >Открыть</button>
              )}
            </div>
          ))}
        </div>
      </Section>
    </>
  )
}

function InstagramProfileBody({ job }) {
  const sources = useSources()
  const cleanHandle = String(job.target || '').replace(/^@/, '')
  const matched = sources.find(s => s.platform === 'instagram' && s.handle === cleanHandle)
  return (
    <>
      <EntityCard
        platform="instagram"
        target={job.target}
        title={job.entity_title}
        kind={job.entity_kind || 'profile'}
      />

      <Section title="Что собрано">
        <KV k="Всего" v={(job.items_done || 0).toLocaleString('ru-RU')} />
        {job.type_breakdown && Object.keys(job.type_breakdown).length > 0 && (
          <KV k="По типам" v={
            <span className="space-x-2">
              {Object.entries(job.type_breakdown).map(([t, n]) => (
                <span key={t} className="inline-block text-zinc-300 bg-zinc-800 rounded px-1.5 py-0.5 text-xs">
                  {t === 'video' ? 'reels/video' : t} <span className="text-zinc-500">{n}</span>
                </span>
              ))}
            </span>
          } />
        )}
        <KV k="Длительность" v={`${
          (job.finished_at && job.started_at)
            ? (job.finished_at - job.started_at) + 's'
            : '—'
        }`} />
        <KV k="Запущено"  v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено" v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        <KV k="Стоимость" v={
          (job.params?.backend === 'apify' || (job.cost_usd && job.cost_usd > 0))
            ? `$${Number(job.cost_usd || 0).toFixed(4)}`
            : <span className="text-zinc-500">бесплатно</span>
        } />
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>

      <Section title="Параметры запуска">
        <KV k="Backend" v={backendLabel(job.params?.backend)} />
        <KV k="Режим"   v={
          job.params?.mode === 'reels' ? 'Reels'
          : job.params?.mode === 'posts' ? 'Posts'
          : job.params?.mode === 'both'  ? 'Reels + Posts'
          : (job.params?.mode || '—')
        } />
        {job.params?.limit != null && <KV k="Лимит" v={job.params.limit || '— (весь профиль)'} />}
      </Section>

      {/* Profile-fetch собирает метадату — combined-файла нет. Юзеру
          важнее перейти в источник и работать там (picker, ChatView). */}
      {matched && (
        <div className="text-zinc-500 italic" style={{ fontSize: '14px' }}>
          Профиль и его reels доступны в библиотеке — слева в Library или
          {' '}
          <button
            onClick={() => pushScreen('source-detail', { sourceId: matched.id, platform: matched.platform })}
            className="underline text-zinc-300 hover:text-zinc-100"
          >открой страницу источника</button>.
        </div>
      )}
    </>
  )
}

function InstagramBatchBody({ job, busy, toast, copyFile, openIn, reveal }) {
  const b = job.yt_batch || {}            // shared shape with YT batch
  const total = job.items_total || 0
  const items = useMemo(() => {
    const arr = Array.isArray(job.params?.shortcodes) ? job.params.shortcodes : []
    return arr.map(code => ({ video_id: code, external_id: `reel:${code}` }))
  }, [job.params?.shortcodes])
  const logByVid = useMemo(() => {
    const m = new Map()
    for (const r of (b.log || [])) m.set(r.video_id, r)
    return m
  }, [b.log])

  return (
    <>
      <Section title="Прогресс">
        <KV k="Всего reels" v={total} />
        <KV k="Сохранено"  v={<span className="text-emerald-400">{b.saved || 0}</span>} />
        {b.errors > 0 && <KV k="Ошибок" v={<span className="text-red-400">{b.errors}</span>} />}
        {b.cost_usd > 0 && <KV k="Потрачено" v={`$${Number(b.cost_usd).toFixed(4)}`} />}
        <KV k="Длительность" v={`${(job.finished_at && job.started_at) ? (job.finished_at - job.started_at) + 's' : '—'}`} />
        <KV k="Запущено"  v={job.started_at  ? formatTs(job.started_at)  : '—'} />
        <KV k="Закончено" v={job.finished_at ? formatTs(job.finished_at) : '—'} />
        {job.error && <KV k="Ошибка" v={<span className="text-red-400">{job.error}</span>} />}
      </Section>

      <Section title={`Reels (${total})`}>
        <div className="max-h-72 overflow-auto -m-4 divide-y divide-zinc-900">
          {items.length === 0 && (
            <div className="px-4 py-3 text-zinc-600 italic" style={{ fontSize: '14px' }}>Пока нет результатов</div>
          )}
          {items.map((it, idx) => {
            const log = logByVid.get(it.video_id)
            const status = log
              ? (log.kind === 'ai'    ? { color: 'text-emerald-400', text: '✓ AI' }
              :  log.kind === 'error' ? { color: 'text-red-400',     text: 'ошибка' }
              :                         null)
              : null
            const path = log?.file_path
            return (
              <div key={idx} className="px-4 py-2 flex items-center gap-3">
                {status ? (
                  <span style={{ fontSize: '14px' }} className={`${status.color} shrink-0`}>{status.text}</span>
                ) : (
                  <span style={{ fontSize: '14px' }} className="text-zinc-600 shrink-0">—</span>
                )}
                <code className="text-zinc-500 shrink-0" style={{ fontSize: '13px' }}>{it.video_id}</code>
                {log?.message && <span className="text-zinc-500 truncate flex-1" style={{ fontSize: '14px' }} title={log.message}>{log.message}</span>}
                {path && (
                  <button
                    onClick={() => window.api?.openExternal?.(path)}
                    className="ml-auto text-zinc-500 hover:text-zinc-200 shrink-0"
                    style={{ fontSize: '14px' }}
                  >Открыть</button>
                )}
              </div>
            )
          })}
        </div>
      </Section>

      <FileCard job={job} busy={busy} toast={toast} copyFile={copyFile} openIn={openIn} reveal={reveal} />
    </>
  )
}

function formatDateOnly(unix) {
  if (!unix) return '—'
  const d = new Date(unix * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}

function FileCard({ job, busy, toast, copyFile, copyFlash, openIn, reveal }) {
  return (
    <Section title="Файл результата">
      {job.file_path ? (
        <>
          <div className="text-xs text-zinc-500 mb-3 break-all font-mono">{job.file_path}</div>
          <div className="flex gap-2">
            <Button onClick={copyFile} busy={busy === 'copy'} flash={copyFlash}>
              {copyFlash ? `✓ ${copyFlash}` : <span className="inline-flex items-center gap-1.5"><Copy size={14} />Копировать</span>}
            </Button>
            <Button onClick={openIn}   busy={busy === 'open'}>
              <span className="inline-flex items-center gap-1.5"><FileText size={14} />Открыть в Sublime</span>
            </Button>
            <Button onClick={reveal}   variant="ghost">
              <span className="inline-flex items-center gap-1.5"><FolderOpen size={14} />Показать в Finder</span>
            </Button>
          </div>
          {toast && <div className="text-xs text-zinc-400 mt-2">{toast}</div>}
        </>
      ) : (
        <div className="text-zinc-600 italic text-sm">
          {job.status === 'running' ? 'Файл будет создан после завершения' : 'Файл не сохранён'}
        </div>
      )}
    </Section>
  )
}

function YoutubeCard({ yt, url, title }) {
  const vid = yt?.video_id
  return (
    <div
      onClick={() => window.api?.openUrl?.(url)}
      role="button"
      title="Открыть на YouTube"
      className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 flex items-start gap-4 cursor-pointer hover:border-zinc-600 transition-colors"
    >
      {vid ? (
        <img
          src={`https://i.ytimg.com/vi/${vid}/mqdefault.jpg`}
          alt=""
          className="w-24 h-14 object-cover rounded bg-zinc-800 border border-zinc-800 shrink-0"
          onError={e => { e.currentTarget.style.visibility = 'hidden' }}
        />
      ) : (
        <div className="w-24 h-14 rounded bg-zinc-800 border border-zinc-800 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{title || url}</div>
        <div className="text-zinc-500" style={{ fontSize: '14px' }}>
          {yt?.channel || '—'}
        </div>
        <a
          href="#"
          onClick={e => { e.preventDefault(); e.stopPropagation(); window.api?.openUrl?.(url) }}
          className="text-zinc-500 hover:text-zinc-300 truncate inline-block max-w-full mt-1"
          style={{ fontSize: '13px' }}
          title={url}
        >
          {url}
        </a>
      </div>
    </div>
  )
}

function fmtSecs(secs) {
  if (!secs) return '—'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function EntityCard({ platform = 'telegram', target, title, kind }) {
  const sources = useSources()
  const cleanHandle = String(target || '').replace(/^@/, '')
  const matched = sources.find(s => s.platform === platform && s.handle === cleanHandle)
  const clickable = !!matched
  const onClick = clickable
    ? () => pushScreen('source-detail', { sourceId: matched.id, platform })
    : undefined
  return (
    <div
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      title={clickable ? 'Открыть источник в библиотеке' : undefined}
      className={`bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 flex items-center gap-4 ${
        clickable ? 'hover:border-zinc-600 cursor-pointer' : ''
      }`}
    >
      <PlatformLogo platform={platform} size={32} />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{title || target}</div>
        <div className="text-zinc-500" style={{ fontSize: '14px' }}>
          {kind || 'unknown'} · @{cleanHandle}
        </div>
      </div>
      {clickable && <span className="text-zinc-600 shrink-0">→</span>}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="mb-8">
      <div className="text-xs uppercase tracking-wider text-zinc-500 mb-3">{title}</div>
      <div className="rounded-md border border-zinc-800 bg-zinc-950 p-4 space-y-2">
        {children}
      </div>
    </div>
  )
}

function KV({ k, v }) {
  return (
    <div className="flex items-baseline gap-4">
      <div className="text-sm text-zinc-500 w-32 shrink-0">{k}</div>
      <div className="text-sm text-zinc-200 flex-1 min-w-0">{v}</div>
    </div>
  )
}

function Spinner() {
  // Tiny inline spinner for "currently in flight" rows. 12px so it sits
  // cleanly next to 14px status text without breaking the row baseline.
  return (
    <span className="inline-block w-3 h-3 rounded-full border-2 border-emerald-700 border-t-emerald-200 animate-spin" />
  )
}

function Button({ children, onClick, busy, variant, flash }) {
  const base = 'px-3 py-1.5 rounded-md text-sm transition-colors'
  // `flash` (truthy) replaces the primary palette with a confirmation
  // colour for the duration of the post-action display. Used for Copy
  // buttons so the label can morph into "✓ Скопировано · ~Nk токенов".
  const styles = flash
    ? 'bg-emerald-700 text-emerald-50 cursor-default'
    : variant === 'ghost'
      ? 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
      : 'bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500'
  return (
    <button onClick={onClick} disabled={busy && !flash} className={`${base} ${styles}`}>
      {busy && !flash ? 'Обрабатываю…' : children}
    </button>
  )
}

function StatusPill({ status }) {
  const palette = {
    running:      ['bg-emerald-900/30 text-emerald-300', '⚡ выполняется'],
    awaiting_ai:  ['bg-amber-900/30 text-amber-300',     '⌛ ждёт подтверждения'],
    done:         ['bg-zinc-800 text-zinc-300',          '✓ готово'],
    error:        ['bg-red-900/30 text-red-300',         '✗ ошибка'],
    cancelled:    ['bg-zinc-800 text-zinc-500',          'отменено'],
    interrupted:  ['bg-amber-900/30 text-amber-300',     '⏸ прервано'],
  }[status] || ['bg-zinc-800 text-zinc-400', status]
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${palette[0]}`}>{palette[1]}</span>
  )
}

function formatTs(unix) {
  const d = new Date(unix * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtTokensJobDetail(n) {
  if (n == null) return '—'
  if (n < 1000)        return String(n)
  if (n < 1_000_000)   return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
