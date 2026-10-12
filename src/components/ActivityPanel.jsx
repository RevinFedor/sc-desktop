import React, { useEffect, useRef, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { useJobsSelector, cancelJob } from '../lib/jobs'
import { EMPTY_JOBS, sameArrayItems } from '../lib/jobSelectorCore.mjs'
import { pushScreen, closeActivity } from '../lib/store'
import { useSources } from '../lib/sources'
import { useFolders } from '../lib/folders'
import JobProgress from './JobProgress'

// Сколько строк истории видно сразу и шаг догрузки. Полный список (live
// Map + исторические снапшоты из DB) уже в памяти — «догрузка» здесь
// только про rendering: не рисовать сотни карточек, пока юзер не доскроллил.
const HISTORY_PAGE = 15

export default function ActivityPanel({ mountedVisible = true }) {
  // The panel stays mounted for its slide animation, but while translated
  // off-screen it must be inert from a render-cost perspective. Rehydrate the
  // current snapshot synchronously when the user opens it.
  const selectedJobs = useJobsSelector(
    list => mountedVisible ? list : EMPTY_JOBS,
    sameArrayItems,
  )
  const frozenJobsRef = useRef(EMPTY_JOBS)
  if (mountedVisible) frozenJobsRef.current = selectedJobs
  // Keep the last rendered rows/scroll geometry while hidden, but stop
  // receiving new job snapshots. Opening rehydrates from the current store in
  // the same render, so no progress event is required to wake the panel.
  const jobs = mountedVisible ? selectedJobs : frozenJobsRef.current
  // Hide per-chat children of a folder fetch — the umbrella row already
  // shows aggregate progress ("3/12 чатов") and the per-chat detail lives
  // on TelegramScreen itself (↻ парсю · ✓ N · ✗ ошибка). Showing 12+ rows
  // for a single folder action would just spam the panel. Chat fetches
  // started outside a folder umbrella have no _folder_umbrella_id and
  // continue to render normally.
  const visible = jobs.filter(isVisibleRequestJob)
  const active = visible.filter(isActiveRequestJob)
  const history = visible.filter(j => !isActiveRequestJob(j))
  // Infinite scroll: по умолчанию HISTORY_PAGE строк, сентинел внизу
  // догружает ещё страницу при появлении в viewport'е.
  const [shown, setShown] = useState(HISTORY_PAGE)
  const recent = history.slice(0, shown)
  const sentinelRef = useRef(null)
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || shown >= history.length) return
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) setShown(n => n + HISTORY_PAGE)
    }, { threshold: 0.1 })
    obs.observe(node)
    return () => obs.disconnect()
  }, [shown, history.length])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-zinc-500">Запросы</div>
        {active.length > 0 && (
          <span className="text-xs text-emerald-400">{active.length} активн.</span>
        )}
      </div>

      <div className="flex-1 overflow-auto px-3 pb-3 space-y-3">
        {active.length === 0 && history.length === 0 && (
          <div className="text-zinc-600 text-sm italic px-1 py-2">
            Ничего не выполняется
          </div>
        )}

        {active.map(j => <RequestJobRow key={j.id} job={j} active />)}

        {recent.length > 0 && (
          <>
            <div className="text-xs uppercase tracking-wider text-zinc-600 mt-4 mb-1 px-1">История</div>
            {recent.map(j => <RequestJobRow key={j.id} job={j} />)}
          </>
        )}
        {shown < history.length && (
          <div ref={sentinelRef} className="px-1 py-2 text-center text-xs text-zinc-600">
            Прокрутите вниз — ещё {history.length - shown}
          </div>
        )}
      </div>
    </div>
  )
}

export function isActiveRequestJob(job) {
  return job?.status === 'running' || job?.status === 'awaiting_ai' || job?.status === 'cancelling'
}

export function isVisibleRequestJob(job) {
  if (job?.params?._history_suppressed) return false
  if (job?.params?._range_plan_child) return false
  return !job?.params?._folder_umbrella_id
}

export function RequestJobRow({ job, active, onClose = closeActivity }) {
  const sources = useSources()
  const [cancelError, setCancelError] = useState(null)
  const cancelling = job.status === 'cancelling'
  const cleanHandle = String(job.target || '').replace(/^@/, '')
  const isIndex = job.type === 'tg_index' || job.type === 'yt_index'
  // Match strategy: tg by handle, YouTube types by source_id when available.
  // yt_transcribe (single) is sourceless so it stays unlinked.
  const matchedSource = (
    isIndex && job.source_id
      ? sources.find(s => Number(s.id) === Number(job.source_id))
    : (job.type === 'tg_fetch' || job.type === 'tg_preview')
      ? (job.source_id
          ? sources.find(s => s.id === job.source_id)
          : sources.find(s => s.platform === 'telegram' && s.handle === cleanHandle))
    : (job.type === 'yt_channel_fetch' || job.type === 'yt_batch_transcribe'
       || job.type === 'tk_channel_fetch' || job.type === 'tk_batch_transcribe') && job.source_id
        ? sources.find(s => s.id === job.source_id)
    : job.type === 'ig_profile_fetch' && job.source_id
        ? sources.find(s => s.id === job.source_id)
    : (job.type === 'boosty_channel_fetch' || job.type === 'boosty_batch_transcribe') && job.source_id
        ? sources.find(s => s.id === job.source_id)
    : null
  )
  const sourceTitle = job.entity_title || (isIndex
    ? matchedSource?.display_name || matchedSource?.handle || (job.source_id ? `источник #${job.source_id}` : job.target)
    : job.target)
  const showFragmentProgress = isIndex && job.unit === 'messages' &&
    Number(job.fragments_total || 0) > Math.max(1, Number(job.messages_selected || job.items_total || 0))
  const pct = job.items_total ? Math.min(100, Math.round((job.items_done / job.items_total) * 100)) : null
  const ago = active ? '' : humanAgo(Math.floor(Date.now() / 1000) - (job.finished_at || job.started_at || 0))

  // Folder fetch — keeps a "N/M чатов · ↻ @x" subtitle mirroring the
  // per-chat status on TelegramScreen, but the click contract is the
  // same as every other Activity row: open JobDetail. See fact-navigation
  // ::Auto-close on job-row click — universal rule, no per-type detours.
  const isFolder        = job.type === 'tg_folder_fetch' || job.type === 'tg_catchup'
  const isFolderRefresh = job.type === 'tg_folder_refresh'
  const onRowClick = () => {
    pushScreen('job-detail', { jobId: job.id, job })
    onClose?.()
  }

  return (
    <div
      data-request-job-id={job.id}
      onClick={onRowClick}
      className="rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 cursor-pointer hover:border-zinc-600 transition-colors"
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot status={job.status} />
        {/* min-w-0 + flex-1 — длинный label сжимается с «…», а время справа
            никогда не переносится на вторую строку («17 ч / назад»). */}
        <span className="text-zinc-300 truncate flex-1 min-w-0">{labelFor(job.type, job)}</span>
        <span className="text-zinc-600 shrink-0 whitespace-nowrap" style={{ fontSize: '14px' }}>{ago}</span>
      </div>
      {isFolder ? (
        <FolderRowBody job={job} active={active} />
      ) : isFolderRefresh ? (
        <FolderRefreshRowBody job={job} active={active} />
      ) : (
        <>
          <div className="text-zinc-500 mt-1 flex items-center gap-2" style={{ fontSize: '14px' }}>
            <span className="truncate flex-1">
              {sourceTitle}
            </span>
            {matchedSource && (
              <button
                onClick={e => { e.stopPropagation(); pushScreen('source-detail', { sourceId: matchedSource.id }); onClose?.() }}
                title="Открыть источник в библиотеке"
                className="text-zinc-600 hover:text-zinc-200 shrink-0 inline-flex items-center"
              ><ArrowRight size={14} /></button>
            )}
          </div>
          {/* Unified progress — items counter, dialog-walk scan, per-kind
              media phase. Hides itself when there's nothing to show. */}
          {job.type !== 'yt_transcribe' && job.type !== 'rutube_transcribe' && job.type !== 'tk_transcribe' && job.type !== 'boosty_transcribe' && (
            <JobProgress job={job} variant="compact" />
          )}
          {isIndex && active && job.phase === 'starting' && (
            <div className="text-zinc-500 mt-1" style={{ fontSize: '14px' }}>Подготавливаю индекс…</div>
          )}
          {showFragmentProgress && (
            <div data-index-fragments-progress className="text-zinc-500 mt-1 tabular-nums" style={{ fontSize: '14px' }}>
              Фрагменты: {Number(job.fragments_embedded || 0).toLocaleString('ru-RU')} / {Number(job.fragments_total).toLocaleString('ru-RU')}
            </div>
          )}
        </>
      )}
      {active && pct !== null && (
        <div className="mt-2 h-1 bg-zinc-800 rounded">
          <div className="h-1 bg-emerald-500 rounded transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {active && pct === null && (
        <div className="mt-2 h-1 bg-zinc-800 rounded overflow-hidden">
          <div className="h-1 bg-emerald-500 animate-pulse rounded" style={{ width: '40%' }} />
        </div>
      )}
      {job.error && (
        <div className="text-xs text-red-400 mt-1 truncate" title={job.error}>{job.error}</div>
      )}
      {/* Non-fatal warning (amber) — explains an otherwise-mute «готово · 0».
          Not truncated: the whole point is that the user reads WHY it's empty.
          Distinct from red error so a successful-but-empty job doesn't look
          broken. See job-runner snapshot.warning + tg_fetch_json warning evt. */}
      {!job.error && job.warning?.message && (
        <div className="text-xs text-amber-400/90 mt-1 leading-snug" title={job.warning.message}>
          {job.warning.message}
        </div>
      )}
      {active && (
        <div className="mt-1 flex justify-end">
          <button
            data-cancel-job
            onClick={async (e) => {
              e.stopPropagation()
              if (cancelling) return
              setCancelError(null)
              try {
                const ok = await cancelJob(job.id, { identity: 'live', type: job.type })
                if (ok !== true) setCancelError('Не удалось остановить')
              } catch {
                setCancelError('Не удалось остановить')
              }
            }}
            disabled={cancelling}
            className="text-xs text-zinc-500 hover:text-red-400 disabled:text-amber-400 disabled:cursor-wait"
          >
            {cancelling ? 'Отменяю…' : 'Отмена'}
          </button>
        </div>
      )}
      {cancelError && (
        <div className="text-xs text-red-400 mt-1 text-right">{cancelError}</div>
      )}
    </div>
  )
}

function FolderRefreshRowBody({ job, active }) {
  const r = job.tg_folder_refresh || {}
  const done  = r.done_folders || 0
  const total = r.total_folders || 0
  return (
    <div className="text-zinc-500 mt-1" style={{ fontSize: '14px' }}>
      <div className="truncate">
        <span className="text-zinc-300 tabular-nums">
          {total > 0 ? `${done}/${total} папок` : 'считаю папки…'}
        </span>
        {!active && (r.synced || r.removed) ? (
          <span className="text-zinc-600 ml-2">
            +{r.synced || 0}{r.removed ? ` · −${r.removed}` : ''}
          </span>
        ) : null}
      </div>
      {active && r.current_title && (
        <div className="truncate text-zinc-600 mt-0.5">↻ {r.current_title}</div>
      )}
    </div>
  )
}

function FolderRowBody({ job, active }) {
  const folders = useFolders()
  const fid = job.tg_folder?.folder_id
  const folder = folders.find(f => f.id === fid)
  const isCatchUp = job.type === 'tg_catchup'
  const isAuto = isCatchUp && job.params?.auto === true
  const folderTitle = isCatchUp
    ? `${job.tg_folder?.total_chats || 0} ${isAuto ? 'авто-чатов' : 'выбранных чатов'}`
    : (folder?.title || job.entity_title || `папка #${fid ?? '?'}`)
  const done  = job.tg_folder?.done_chats || 0
  const total = job.tg_folder?.total_chats || job.items_total || 0
  const cur   = job.tg_folder?.current_target
  const errs  = (job.tg_folder?.per_chat || []).filter(p => p.status === 'error').length
  return (
    <div className="text-zinc-500 mt-1" style={{ fontSize: '14px' }}>
      <div className="truncate">
        <span className="text-zinc-300">{folderTitle}</span>
        <span className="text-zinc-600 ml-2">
          {total > 0 ? `${done}/${total} чатов` : ''}
        </span>
      </div>
      {active && cur && (
        <div className="truncate text-zinc-600 mt-0.5">
          ↻ парсю @{String(cur).replace(/^@/, '')}
        </div>
      )}
      {!active && errs > 0 && (
        <div className="truncate text-red-300 mt-0.5">
          {errs} с ошибкой
        </div>
      )}
    </div>
  )
}

function StatusDot({ status }) {
  const color = {
    running:     '#10b981',
    awaiting_ai: '#f59e0b',
    cancelling:  '#f59e0b',
    done:        '#71717a',
    error:       '#ef4444',
    cancelled:   '#a1a1aa',
    pending:     '#a1a1aa',
  }[status] || '#71717a'
  const pulse = status === 'running' || status === 'awaiting_ai'
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${pulse ? 'animate-pulse' : ''}`}
      style={{ background: color }}
    />
  )
}

function labelFor(type, job) {
  // On-demand media (re)processing rides on the tg_fetch type but reads very
  // differently to the user — it's «перевести these picked messages», not a
  // channel fetch. Disambiguate by the media_only param marker.
  if (type === 'tg_fetch' && job?.params?.mode === 'media_only') {
    return 'Telegram · перевод медиа'
  }
  if (type === 'tg_fetch' && job?.params?.mode === 'id_list') {
    return 'Telegram · сохранение найденного'
  }
  if (type === 'tg_catchup' && job?.params?.auto === true) {
    return 'Telegram · автообновление'
  }
  return ({
    tg_index:             'Telegram · индексация',
    yt_index:             'YouTube · индексация',
    tg_fetch:             'Telegram · парсинг',
    tg_preview:           'Telegram · анализ',
    tg_folder_fetch:      'Telegram · папка',
    tg_folder_refresh:    'Telegram · обновление папок',
    tg_catchup:           'Telegram · до конца',
    tg_live_search:       'Telegram · поиск',
    tg_live_context:      'Telegram · контекст',
    tg_live_range:        'Telegram · диапазон',
    tg_live_attachment:   'Telegram · вложение',
    tg_live_transcribe:    'Telegram · расшифровка',
    tg_live_public_search: 'Telegram · публичный поиск',
    tg_live_join:          'Telegram · вступление',
    tg_live_leave:         'Telegram · выход',
    sync_source:          'Синхронизация',
    transcribe:           'Транскрипция',
    download_item:        'Загрузка',
    bulk_transcribe:      'Пакетная транскрипция',
    yt_transcribe:        'YouTube · транскрипт',
    rutube_transcribe:    'Rutube · расшифровка',
    yt_comments:          'YouTube · комментарии',
    yt_batch_comments:    'YouTube · комментарии (пакет)',
    yt_channel_fetch:     'YouTube · канал',
    yt_batch_transcribe:  'YouTube · пакет',
    tk_transcribe:        'TikTok · транскрипт',
    tk_channel_fetch:     'TikTok · канал',
    tk_batch_transcribe:  'TikTok · пакет',
    ig_profile_fetch:     'Instagram · профиль',
    boosty_transcribe:    'Boosty · видео',
    boosty_channel_fetch: 'Boosty · каталог',
    boosty_batch_transcribe: 'Boosty · пакет',
    local_transcribe:     'Локальный файл',
  })[type] || type
}

function humanAgo(secs) {
  if (secs < 5)         return 'только что'
  if (secs < 60)        return `${secs} сек назад`
  if (secs < 3600)      return `${Math.round(secs / 60)} мин назад`
  if (secs < 86400)     return `${Math.round(secs / 3600)} ч назад`
  return `${Math.round(secs / 86400)} дн назад`
}
