import React, { useEffect, useState, useRef } from 'react'
import { RotateCw, Trash2, MessageCircle, Copy, Save, BarChart3, Settings, StickyNote, ListChecks, UserRound, TriangleAlert } from 'lucide-react'
import { pushScreen, goHome } from '../lib/store'
import PlatformLogo from '../components/PlatformLogo'
import Avatar from '../components/Avatar'
import SendersBlock from '../components/SendersBlock'
import CopySavedPanel from '../components/CopySavedPanel'
import CoverageBars from '../components/CoverageBars'
import ChatView from '../components/ChatView'
import RedditThreadView from '../components/RedditThreadView'
import RedditSearchView from '../components/RedditSearchView'
import SocialSourceOverview from '../components/SocialSourceOverview'
import YouTubeBatchPicker from '../components/YouTubeBatchPicker'
import TikTokBatchPicker from '../components/TikTokBatchPicker'
import InstagramBatchPicker from '../components/InstagramBatchPicker'
import TelegramConfigForm from '../components/TelegramConfigForm'
import InstagramConfigForm from '../components/InstagramConfigForm'
import YouTubeQuickFetchForm from '../components/YouTubeQuickFetchForm'
import IndexButton from '../components/IndexButton'
import ToolbarButton from '../components/ToolbarButton'
import NewRequestSplitButton from '../components/NewRequestSplitButton'
import JobProgress, { cleanErrorMessage } from '../components/JobProgress'
import BoostySourceDetail from '../components/BoostySourceDetail'
import { refreshSources } from '../lib/sources'
import { useJobs } from '../lib/jobs'
import { useInvalidator } from '../lib/dataBus'
import {
  loadLastUsedContent, loadLastUsedEngine, buildContentParams, lastUsedContentLabels,
} from '../lib/tgFetchParams'

export default function SourceDetail({ payload }) {
  const sourceId = payload?.sourceId
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  // «Новый запрос…» toggle — opens the inline platform-specific form
  // (TelegramConfigForm / InstagramConfigForm / YouTubeQuickFetchForm).
  // One mental model: «inline form whenever I want to fetch».
  const [newFetchOpen, setNewFetchOpen] = useState(false)
  // «📊 Обзор» — inline panel with cheap stats: pre-analysis for TG
  // (last_n=500 preview) or web_profile_info for IG (single HTTP). YT
  // / TK don't have a free preview endpoint — for them we just show
  // sources.meta data we already have (rendered in the Stats block at
  // the top of the page), so no Обзор button.
  const [overviewOpen, setOverviewOpen] = useState(false)
  // «📋 Скопировать сохранённое» — inline assemble-panel toggle. Lives in
  // the action-row alongside «Новый запрос…» — both are operations on the
  // source, fetch and assemble share the same mental shelf.
  const [copyOpen, setCopyOpen] = useState(false)
  // Default-open the picker for YouTube channels — that's the page's primary
  // action. For Telegram the picker doesn't apply.
  const [pickerOpen, setPickerOpen] = useState(false)
  useEffect(() => {
    setNewFetchOpen(false)
    setCopyOpen(false)
    setPickerOpen(false)
    setOverviewOpen(false)
  }, [sourceId])
  useEffect(() => {
    const p = data?.source?.platform
    if (p === 'youtube' || p === 'tiktok' || p === 'instagram') {
      setPickerOpen(true)
    }
  }, [data?.source?.platform])
  useEffect(() => {
    const p = data?.source?.platform
    if (!p) return
    setOverviewOpen(isSocialSource(p))
  }, [sourceId, data?.source?.platform])

  // Semantic-index status for the IndexButton. Polled on mount + after start +
  // on job:update for own job. Shape: { state: 'idle'|'running', done, total }.
  const [idxStatus, setIdxStatus] = useState({ state: 'idle' })
  // One-line toast in the action-row. Used for "индекс уже полный" and
  // similar quick-feedback events that don't deserve a job row.
  const [pageToast, setPageToast] = useState(null)
  function flashToast(msg) {
    setPageToast(msg)
    setTimeout(() => setPageToast(prev => (prev === msg ? null : prev)), 3500)
  }
  async function refreshIdxStatus() {
    if (!window.api?.tgIndexStatus || !sourceId) return
    try {
      const s = await window.api.tgIndexStatus(sourceId)
      if (s) setIdxStatus(s)
    } catch (err) {
      console.error('[SourceDetail] tgIndexStatus failed', err)
    }
  }
  useEffect(() => { refreshIdxStatus() }, [sourceId])
  useEffect(() => {
    if (!window.api?.onJobUpdate) return
    const off = window.api.onJobUpdate((job) => {
      if (job?.type === 'tg_index' && job.source_id === sourceId) {
        refreshIdxStatus()
      }
    })
    return off
  }, [sourceId])

  async function startIndex(limit) {
    if (!window.api?.tgIndex) {
      console.error('[SourceDetail] tgIndex IPC not available')
      return
    }
    if (Number(idxStatus?.total || 0) > 0
        && Number(idxStatus?.done || 0) >= Number(idxStatus?.total || 0)
        && idxStatus?.state !== 'running') {
      flashToast('Все сообщения уже проиндексированы')
      return
    }
    try {
      const r = await window.api.tgIndex({ sourceId, limit })
      if (r && r.noop) {
        flashToast('Все сообщения уже проиндексированы')
        return
      }
      // optimistic — handler also fires job:update once running
      setIdxStatus({ state: 'running', done: 0, total: limit || data?.source?.items_count || 0 })
    } catch (err) {
      console.error('[SourceDetail] tgIndex failed', err)
      window.alert(`Ошибка индексации: ${err?.message || err}`)
    }
  }

  // Two slices, two refresh cadences:
  //   • full reload — only on source:<id> (terminal job, manual refresh).
  //     This is the heavy one (sourceDetail() returns header/stats/
  //     breakdown/coverage/senders/jobs all at once).
  //   • jobs-only — on jobs:<id> (progress ticks, throttled). Updates the
  //     "История парсинга" row in place without re-rendering CoverageBars,
  //     ChatView, or the form panel.
  // «История парсинга» — постраничная: сервер по умолчанию отдаёт 20 строк
  // (SQL LIMIT), «показать ещё» докручивает jobsLimit и перечитывает только
  // jobs-срез. Без этого записи старше 20-й были недостижимы вообще.
  const JOBS_PAGE = 20
  const [jobsLimit, setJobsLimit] = useState(JOBS_PAGE)
  useEffect(() => { setJobsLimit(JOBS_PAGE) }, [sourceId])
  async function reloadAll() {
    if (!window.api || !sourceId) return
    const detail = await window.api.sourceDetail(sourceId)
    // sourceDetail отдаёт первую страницу jobs (20). Если юзер уже раскрутил
    // историю глубже — доберём её jobs-путём, не теряя позицию.
    if (jobsLimit > JOBS_PAGE && window.api.jobsListForSource) {
      try {
        detail.jobs = await window.api.jobsListForSource({ id: sourceId, limit: jobsLimit })
      } catch {}
    }
    setData(detail)
  }
  async function reloadJobs(limit = jobsLimit) {
    if (!window.api?.jobsListForSource || !sourceId) return
    try {
      const jobs = await window.api.jobsListForSource({ id: sourceId, limit })
      setData(prev => prev ? { ...prev, jobs } : prev)
    } catch (err) {
      console.error('[SourceDetail] jobs reload failed', err)
    }
  }
  function showMoreJobs() {
    const next = jobsLimit + JOBS_PAGE
    setJobsLimit(next)
    reloadJobs(next)
  }
  // Keep the public name for callers (deleteJob, clearJobsHistory) — they
  // expect a heavy refresh after a destructive op.
  const reload = reloadAll

  const sourceVer = useInvalidator(`source:${sourceId}`)
  const jobsVer   = useInvalidator(`jobs:${sourceId}`)
  useEffect(() => { reloadAll() }, [sourceId, sourceVer])
  // jobs-only path skips the first run (handled by reloadAll above).
  const jobsVerFirst = useRef(true)
  useEffect(() => {
    if (jobsVerFirst.current) { jobsVerFirst.current = false; return }
    reloadJobs()
    // eslint-disable-next-line
  }, [jobsVer])

  // Live in-memory snapshots — used to enrich each row in «История парсинга»
  // with the same per-kind progress that ActivityPanel shows. SourceDetail's
  // history rows come from the SQLite jobs table (snapshots in time), so
  // they have no media_phase / resolve_scanned. Match by snapshot.db_id ==
  // db row id so a single running job appears live in BOTH places without
  // duplication.
  const liveJobs = useJobs()
  const liveByDbId = React.useMemo(() => {
    const m = new Map()
    for (const j of liveJobs) {
      if (j && j.db_id != null) m.set(j.db_id, j)
    }
    return m
  }, [liveJobs])

  // Is a quick catch-up fetch for THIS source already in flight? Drives the
  // split button's right-segment loader and disables re-launch. Matches any
  // running tg_fetch on this source EXCEPT media_only (those are the per-
  // message «перевести» jobs from ChatView, a different operation).
  const quickBusy = React.useMemo(
    () => liveJobs.some(j => j && j.source_id === sourceId
      && j.type === 'tg_fetch'
      && (j.status === 'running' || j.status === 'awaiting_ai')
      && j.params?.mode !== 'media_only'),
    [liveJobs, sourceId],
  )

  // One-click catch-up: pull everything newer than the last saved message with
  // the user's last-used content/engine, no form. sync_new + sinceMessageId is
  // the same path the sidebar «Запросить до конца» and folder-batch use (see
  // fact-fetch-strategies.md::Incremental sync). Empty source (no tip) falls
  // back to last_n=200, mirroring job-runner's catch-up default.
  const [quickToast, setQuickToast] = useState(null)
  async function quickCatchUp() {
    const src = data?.source
    if (!src || src.platform !== 'telegram' || !window.api?.tgFetch) return
    if (quickBusy) return
    if (src.tg_session_conflict) {
      flashQuickToast('Выбери Telegram-аккаунт')
      return
    }
    if (!src.tg_session) {
      flashQuickToast('Telegram-аккаунт не выбран')
      return
    }
    try {
      const content = loadLastUsedContent()
      const engine = loadLastUsedEngine()
      const params = {
        target: '@' + String(src.handle).replace(/^@/, ''),
        _source_id: sourceId,
        _tg_session_override: src.tg_session,
        ...buildContentParams(content, engine),
      }
      let since = 0
      if (window.api.sourceMaxExternalId) {
        try { since = Number(await window.api.sourceMaxExternalId(sourceId)) || 0 } catch {}
      }
      if (since > 0) { params.mode = 'sync_new'; params.sinceMessageId = since }
      else           { params.mode = 'last_n'; params.limit = 200 }
      await window.api.tgFetch(params)
      flashQuickToast(since > 0 ? 'Догружаю новые…' : 'Первая загрузка (200)…')
    } catch (err) {
      console.error('[SourceDetail] quick catch-up failed', err)
      flashQuickToast('Ошибка запуска')
    }
  }
  function flashQuickToast(msg) {
    setQuickToast(msg)
    setTimeout(() => setQuickToast(prev => (prev === msg ? null : prev)), 3000)
  }

  if (!data || !data.source) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-500">
        Loading source…
      </div>
    )
  }

  const s = data.source
  if (s.platform === 'boosty') {
    return <BoostySourceDetail source={s} jobs={data.jobs || []} />
  }
  const savedTypeBreakdown = data.typeBreakdown || []
  const totalItems = savedTypeBreakdown.reduce((sum, r) => sum + (r.count || 0), 0)
  // Preview analysis and saved rows answer different questions.  Only when
  // there are no saved rows at all do we use the analysis as the distribution
  // fallback; the top «Сохранено сообщений» count intentionally stays zero.
  // Each fallback row carries analysis_missing so CoverageBars can mark every
  // discovered type (including text/service) as not yet saved.
  const analysisTypeBreakdown = s.platform === 'telegram' && totalItems === 0
    ? telegramAnalysisBreakdown(data.telegramAnalysis)
    : []
  const distributionTypeBreakdown = analysisTypeBreakdown.length
    ? analysisTypeBreakdown
    : savedTypeBreakdown
  const distributionTotalItems = distributionTypeBreakdown.reduce(
    (sum, row) => sum + (row.count || 0),
    0,
  )
  const distributionIsAnalysisOnly = analysisTypeBreakdown.length > 0
  const lastItemAt = s.last_item_at ? new Date(s.last_item_at * 1000) : null
  const lastSyncedAt = s.last_synced_at ? new Date(s.last_synced_at * 1000) : null
  const canOpenNewRequest = hasNewRequestForm(s.platform)

  // Aggregated date range across all coverage rows
  const cov = data.coverage || []
  const minDate = cov.reduce((m, r) => (!m || (r.date_from && r.date_from < m) ? r.date_from : m), null)
  const maxDate = cov.reduce((m, r) => (!m || (r.date_to && r.date_to > m) ? r.date_to : m), null)

  async function deleteSource() {
    const yes = window.confirm(
      `Удалить источник «${s.display_name || s.handle}» вместе со всеми сообщениями, ` +
      `coverage и историей jobs?\n\nЭто нельзя отменить. Файлы JSON в jobs/ остаются.`
    )
    if (!yes) return
    await window.api.sourcesDelete(sourceId)
    await refreshSources()
    goHome()
  }

  async function clearJobsHistory() {
    const yes = window.confirm('Очистить историю парсинга для этого источника? Сообщения останутся.')
    if (!yes) return
    await window.api.jobsClearForSource(sourceId)
    reload()
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto px-8 py-6">
        <div className="max-w-5xl mx-auto">
          {/* Source identity row — replaces the old header bar. */}
          <div className="mb-6 flex items-center gap-3">
            <div className="relative shrink-0">
              <Avatar source={s} size={36} />
              {/* Platform marker overlaid bottom-right — keeps brand context when
                  multiple platforms have similar-looking chat avatars. */}
              <span className="absolute -bottom-0.5 -right-0.5 ring-2 ring-zinc-950 rounded-full bg-zinc-950 leading-none">
                <PlatformLogo platform={s.platform} size={14} />
              </span>
            </div>
            <span className="text-xl font-semibold text-zinc-100">
              {s.display_name && s.display_name !== s.handle ? s.display_name : `@${s.handle}`}
            </span>
            <span className="text-zinc-700">·</span>
            <span className="text-zinc-500">@{s.handle}</span>
            {s.platform === 'telegram' && (
              <SessionBadge source={s} onPinned={reload} />
            )}
            <button
              onClick={() => pushScreen('notes', { sourceId })}
              className="ml-auto px-3 py-1.5 rounded-md text-zinc-300 bg-zinc-800 hover:bg-zinc-700 flex items-center gap-1.5"
              style={{ fontSize: '14px' }}
              title="Открыть заметки по источнику"
            >
              <StickyNote size={14} /> Заметки
            </button>
          </div>

          {/* Top stats bar */}
          <div className="grid grid-cols-3 gap-3 mb-6">
            <Stat
              label={
                s.platform === 'youtube'   ? 'Сохранено видео'
                : s.platform === 'tiktok'    ? 'Сохранено видео'
                : s.platform === 'instagram' ? 'Сохранено reels'
                : isSocialSource(s.platform) ? 'Сохранено строк'
                : 'Сохранено сообщений'
              }
              value={totalItems.toLocaleString()}
            />
            <Stat
              label="Период"
              value={renderPeriod(data.dateRange, s.platform, lastItemAt)}
            />
            <Stat
              label="Последний sync"
              value={lastSyncedAt ? humanAgo((Date.now() - lastSyncedAt.getTime()) / 1000) : '—'}
            />
          </div>

          {/* Action row — operations on the source, ordered left-to-right.
                "📊 Обзор"        — cheap stats (TG: pre-analysis preview;
                                    IG: web_profile_info). YT/TK: omitted,
                                    they don't have a free preview API.
                "⚙ Новый запрос…" — opens an inline form to fetch data.
                "📋 Скопировать"  — TG-only: assemble saved items into the
                                    clipboard / .txt (lives next to «Новый
                                    запрос» because both are operations on
                                    the source).
                "⚙ Picker"        — pick from already-saved items.
              All buttons share <ToolbarButton> for consistent height/font;
              variants only differ in colour weight (primary action gets a
              brighter outline, accent action stays emerald). */}
          {/* flex-wrap is load-bearing: the row holds a variable number of
              buttons (Обзор / Новый запрос / Скопировать / Дотянуть / Индекс)
              whose count and width depend on platform, totals and live job
              state. Without wrap, a wide combo (e.g. IndexButton swinging to
              «Индексирую… 12 000 / 32 145 (37%)») overflows the row's right
              edge — buttons visually escape the line. Wrap drops the overflow
              to a second row instead. gap-y keeps the two rows from touching. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 mb-4">
            {hasOverview(s.platform) && (
              <ToolbarButton
                variant="neutral"
                active={overviewOpen}
                onClick={() => {
                  // Mutex больших inline-панелей: Обзор / Форма / Скопировать
                  // не живут одновременно (picker — основной контент страницы
                  // YT/TT/IG, он вне мьютекса).
                  setOverviewOpen(v => !v)
                  setNewFetchOpen(false)
                  setCopyOpen(false)
                }}
                title="Быстрая статистика по источнику без полного парсинга"
                idleLabel={<><BarChart3 size={14} /> Обзор</>}
                activeLabel={<><BarChart3 size={14} /> Скрыть обзор</>}
              />
            )}
            {canOpenNewRequest && s.platform === 'telegram' ? (
              <NewRequestSplitButton
                open={newFetchOpen}
                onToggle={() => {
                  // Mutually exclusive with «Скопировать» и «Обзор»: opening
                  // one always closes the others so the page never holds two
                  // big inline panels stacked underneath the same action row.
                  setNewFetchOpen(v => !v)
                  setCopyOpen(false)
                  setOverviewOpen(false)
                }}
                onQuickFetch={quickCatchUp}
                busy={quickBusy}
                quickTitle="Догрузить новые сообщения (от последнего сохранённого до сейчас) с последними выбранными параметрами — без открытия формы"
                tooltipContent={<QuickParamsTooltip />}
              />
            ) : canOpenNewRequest ? (
              <ToolbarButton
                variant="primary"
                active={newFetchOpen}
                onClick={() => {
                  setNewFetchOpen(v => !v)
                  setCopyOpen(false)
                  setOverviewOpen(false)
                }}
                title="Открыть форму с параметрами запроса"
                idleLabel={<><Settings size={14} /> Новый запрос…</>}
                activeLabel={<><Settings size={14} /> Скрыть форму</>}
              />
            ) : null}
            {s.platform === 'telegram' && totalItems > 0 && (
              <ToolbarButton
                variant="neutral"
                active={copyOpen}
                onClick={() => {
                  setCopyOpen(v => !v)
                  setNewFetchOpen(false)
                  setOverviewOpen(false)
                }}
                title="Собрать срез сохранённых сообщений и скопировать / сохранить"
                idleLabel={<><Copy size={14} /> Скопировать · {totalItems.toLocaleString('ru-RU')}</>}
                activeLabel={<><Copy size={14} /> Скрыть копирование</>}
              />
            )}
            {(s.platform === 'youtube' || s.platform === 'tiktok' || s.platform === 'instagram') && (
              <ToolbarButton
                variant="neutral"
                active={pickerOpen}
                onClick={() => setPickerOpen(v => !v)}
                title={
                  s.platform === 'instagram'
                    ? 'Выбрать reels для транскрипции / копирования'
                    : 'Выбрать видео для транскрипции / копирования'
                }
                idleLabel={<><ListChecks size={14} /> Picker</>}
                activeLabel={<><ListChecks size={14} /> Скрыть picker</>}
              />
            )}
            {/* «Дотянуть комментарии» — Telegram channels with linked
                discussion that have posts without stored comments. Opens
                a comments-only fetch over post-ids that aren't covered yet.
                See fact-database.md::post_comments. */}
            {s.platform === 'telegram'
             && s.has_discussion === 1
             && totalItems > 0
             && (data.postsWithComments || 0) < totalItems && (
              <CatchUpCommentsButton
                sourceId={sourceId}
                handle={s.handle}
                totalPosts={totalItems}
                postsWithComments={data.postsWithComments || 0}
              />
            )}
            {/* Semantic-index button — Telegram only for now. Pinned right
                via ml-auto inside the component itself. */}
            {s.platform === 'telegram' && (
              <IndexButton
                sourceId={sourceId}
                status={idxStatus}
                onStart={startIndex}
              />
            )}
            {pageToast && (
              <span className="ml-3 self-center text-zinc-400" style={{ fontSize: '13px' }}>
                {pageToast}
              </span>
            )}
            {quickToast && (
              <span className="ml-2 self-center text-emerald-400/90" style={{ fontSize: '13px' }}>
                {quickToast}
              </span>
            )}
          </div>

          {/* «Обзор» panel — Instagram only.  TG gets pre-analysis
              inside the «Новый запрос…» form because it depends on the
              chosen range; YT/TK don't have a free preview at all. */}
          {overviewOpen && s.platform === 'instagram' && (
            <div className="mb-8">
              <InstagramOverview handle={s.handle} />
            </div>
          )}
          {overviewOpen && isSocialSource(s.platform) && (
            <div className="mb-8">
              <SocialSourceOverview sourceId={sourceId} source={s} />
            </div>
          )}

          {/* Inline form for «Новый запрос…».  Toggle-state, closes on
              submit. */}
          {newFetchOpen && s.platform === 'telegram' && (
            <div className="mb-8 rounded-lg border border-zinc-800 bg-zinc-950 p-6">
              <TelegramConfigForm
                target={'@' + s.handle}
                sourceId={sourceId}
                sourceSession={s.tg_session || null}
                sourceSessionConflict={!!s.tg_session_conflict}
                notifyOnLaunch
                onStarted={() => setNewFetchOpen(false)}
              />
            </div>
          )}
          {newFetchOpen && s.platform === 'instagram' && (
            <div className="mb-8">
              <InstagramConfigForm
                target={s.handle}
                forceForm
                onStarted={() => setNewFetchOpen(false)}
              />
            </div>
          )}
          {newFetchOpen && (s.platform === 'youtube' || s.platform === 'tiktok') && (
            <div className="mb-8">
              <YouTubeQuickFetchForm
                target={s.handle ? `@${s.handle}` : s.external_id}
                platform={s.platform}
                onStarted={() => setNewFetchOpen(false)}
              />
            </div>
          )}

          {/* Inline assemble-panel for «📋 Скопировать». Controlled — the
              toolbar button owns open-state. Lives directly under the
              action-row alongside the «Новый запрос…» form so both
              operations on the source share the same visual shelf. */}
          {copyOpen && s.platform === 'telegram' && totalItems > 0 && (
            <div className="mb-8">
              <CopySavedPanel
                sourceId={sourceId}
                typeBreakdown={data.typeBreakdown || []}
                commentsCount={data.commentsCount || 0}
                open={copyOpen}
                onToggle={setCopyOpen}
              />
            </div>
          )}

          {/* Spacer between action-row and the rest if no panel is open. */}
          {!newFetchOpen && !overviewOpen && !copyOpen && <div className="mb-4" />}

          {s.platform === 'youtube' && pickerOpen && (
            <div className="mb-8">
              <YouTubeBatchPicker
                sourceId={sourceId}
                onStarted={() => { /* job appears in Activity panel */ }}
                onClose={() => setPickerOpen(false)}
              />
            </div>
          )}

          {s.platform === 'tiktok' && pickerOpen && (
            <div className="mb-8">
              <TikTokBatchPicker
                sourceId={sourceId}
                handle={s.handle}
                onStarted={() => { /* job appears in Activity panel */ }}
                onClose={() => setPickerOpen(false)}
              />
            </div>
          )}

          {s.platform === 'instagram' && pickerOpen && (
            <div className="mb-8">
              <InstagramBatchPicker sourceId={sourceId} />
            </div>
          )}

          {/* Distribution by content type */}
          <Section title="Распределение по типам">
            {distributionTypeBreakdown.length === 0 ? (
              <div className="text-zinc-600 italic">Пока пусто. Запустите анализ канала или парсинг.</div>
            ) : (
              <CoverageBars
                sourceId={sourceId}
                typeBreakdown={distributionTypeBreakdown}
                totalItems={distributionTotalItems}
                platform={s.platform}
                indexed={idxStatus?.done || 0}
                commentsCount={data.commentsCount || 0}
                analysisOnly={distributionIsAnalysisOnly}
                analyzedAt={data.telegramAnalysis?.analyzed_at || null}
              />
            )}
          </Section>

          {/* «Скопировать сохранённое» moved into the action-row above
              (controlled by `copyOpen`). Was a collapsed inline section
              under the type-breakdown chart — folded into the action-row
              so all source operations live on one shelf. */}

          {/* Senders (for chats / groups) — collapsed by default; expand
              reveals search + select-all + checkbox-list. */}
          {(data.senders && data.senders.length > 1) && (
            <SendersBlock senders={data.senders} />
          )}

          {/* Jobs history */}
          <div className="mb-8">
            <div className="flex items-center mb-3">
              <div className="text-xs uppercase tracking-wider text-zinc-500">История парсинга</div>
              {data.jobs && data.jobs.length > 0 && (
                <button
                  onClick={clearJobsHistory}
                  className="ml-auto text-zinc-500 hover:text-red-400"
                >
                  Очистить историю
                </button>
              )}
            </div>
            {data.jobs && data.jobs.length > 0 ? (
              <div className="rounded-md border border-zinc-800 bg-zinc-950 divide-y divide-zinc-800 max-h-80 overflow-auto">
                {data.jobs.filter(isVisibleHistoryJobRow).map(j => (
                  <JobHistoryRow
                    key={j.id}
                    job={j}
                    source={s}
                    liveJob={liveByDbId.get(j.id) || null}
                    onDelete={async () => {
                      await window.api.jobsDeleteOne(j.id)
                      reload()
                    }}
                    onCancel={async () => {
                      // Same IPC the ActivityPanel uses — kills the child
                      // process; status will flip to 'cancelled' and reload
                      // picks it up via the data bus.
                      try { await window.api.cancelJob(j.id) } catch {}
                      reload()
                    }}
                  />
                ))}
                {/* Сервер отдал ровно столько, сколько просили — почти
                    наверняка есть хвост старше. Докрутка читает следующую
                    страницу тем же jobs-путём. */}
                {data.jobs.length >= jobsLimit && (
                  <button
                    onClick={showMoreJobs}
                    className="w-full px-4 py-2 text-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900/60"
                    style={{ fontSize: '13px' }}
                  >
                    Показать ещё
                  </button>
                )}
              </div>
            ) : (
              <div className="text-zinc-600 italic">Ещё не было парсингов</div>
            )}
          </div>

          {/* Chat / videos / reddit-tree viewer */}
          {s.platform === 'reddit' ? (
            (() => {
              let kind = null
              try { kind = JSON.parse(s.meta_json || '{}').kind } catch {}
              if (kind === 'thread') {
                return (
                  <Section title="Тред">
                    <div className="h-[calc(100vh-360px)] min-h-[400px] border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950">
                      <RedditThreadView sourceId={sourceId} />
                    </div>
                  </Section>
                )
              }
              return (
                <Section title="Найденные посты">
                  <div className="h-[calc(100vh-360px)] min-h-[400px] border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950">
                    <RedditSearchView sourceId={sourceId} />
                  </div>
                </Section>
              )
            })()
          ) : (
            <Section title={
              s.platform === 'youtube'   ? 'Видео'
              : s.platform === 'tiktok'    ? 'Видео'
              : s.platform === 'instagram' ? 'Публикации'
              : s.platform === 'twitter'   ? 'Посты и ответы'
              : 'Сообщения'
            }>
              <ChatView sourceId={sourceId} platform={s.platform} />
            </Section>
          )}

          {/* Danger zone — last block, separated visually. */}
          <div className="mt-12 pt-6 border-t border-zinc-900">
            <div className="text-xs uppercase tracking-wider text-zinc-600 mb-3">Опасная зона</div>
            <button
              onClick={deleteSource}
              className="px-4 py-2 rounded-md text-red-400 border border-red-900/60 hover:bg-red-900/20 hover:text-red-300 inline-flex items-center gap-1.5"
            >
              <Trash2 size={16} /> Удалить источник
            </button>
            <div className="text-zinc-600 mt-2" style={{ fontSize: '14px' }}>
              Удалит источник вместе со всеми сообщениями, coverage и историей парсинга. Файлы JSON в jobs/ остаются.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="mb-8">
      <div className="text-xs uppercase tracking-wider text-zinc-500 mb-3">{title}</div>
      {children}
    </div>
  )
}

// Cmd+hover tooltip body for the split «Новый запрос» button. Echoes the
// last-used content types so the user knows, before clicking the ⚡ quick-
// catch-up, exactly what it would pull — without opening the form.
// Reads from the same localStorage blob the form persists (tgFetchParams.js).
function QuickParamsTooltip() {
  const labels = lastUsedContentLabels()
  const engine = loadLastUsedEngine()
  const content = loadLastUsedContent()
  const needsEngine = content.voice || content.video
  const engineLabel = needsEngine
    ? (engine === 'gemini' ? 'Gemini' : 'AssemblyAI')
    : null
  return (
    <div style={{ fontSize: '13px' }} className="leading-relaxed">
      <div className="text-zinc-400 mb-0.5" style={{ fontSize: '11px' }}>
        ⚡ догрузка пойдёт с параметрами:
      </div>
      <div className="text-zinc-100">
        {labels.length ? labels.join(', ') : 'ничего не выбрано'}
      </div>
      {(engineLabel) && (
        <div className="text-zinc-500 mt-0.5">
          {`движок: ${engineLabel}`}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1">{label}</div>
      <div className="text-base font-medium text-zinc-100">{value}</div>
    </div>
  )
}

// Бейдж «через какую сессию читается этот чат» в identity-row TG-источника.
// Три состояния:
//   • привязан (tg_session, без конфликта) — серый chip с именем аккаунта;
//   • конфликт (tg_session_conflict=1 — чат трогали из разных сессий) —
//     amber chip «выбери сессию», клик открывает выбор;
//   • не привязан (legacy до ввода привязки) — пустой chip «сессия?»,
//     тоже кликабелен для ручного пина.
// Выбор пишет sources.tg_session напрямую (sources:setSession) и гасит
// конфликт-флаг — детерминированная привязка до следующего фетча.
function SessionBadge({ source, onPinned }) {
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState(null)   // null = ещё не грузили
  const wrapRef = useRef(null)
  const conflict = Boolean(source.tg_session_conflict)
  const bound = source.tg_session || null

  useEffect(() => {
    if (!bound || sessions != null || !window.api?.tgListSessions) return
    let alive = true
    window.api.tgListSessions()
      .then(r => { if (alive) setSessions(r?.sessions || []) })
      .catch(() => { if (alive) setSessions([]) })
    return () => { alive = false }
  }, [bound, sessions])

  useEffect(() => {
    if (!open) return
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    // setTimeout(0) — иначе открывший клик сам же закроет popover
    // (см. fix-popover-outside-click.md).
    const id = setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    return () => { clearTimeout(id); document.removeEventListener('mousedown', onDoc) }
  }, [open])

  async function toggleOpen() {
    const next = !open
    setOpen(next)
    if (next && sessions == null && window.api?.tgListSessions) {
      try {
        const r = await window.api.tgListSessions()
        setSessions(r?.sessions || [])
      } catch { setSessions([]) }
    }
  }

  async function pin(name) {
    try {
      await window.api.sourceSetSession(source.id, name)
      setOpen(false)
      onPinned?.()
    } catch (err) {
      console.error('[SessionBadge] pin failed', err)
    }
  }

  function sessLabel(sess) {
    const who = sess.me || sess.me_cached
    return who?.username ? `@${who.username}` : (who?.first_name || sess.name)
  }

  function sessNick(sess) {
    const who = sess.me || sess.me_cached
    return who?.username || who?.first_name || sess.name
  }

  const boundSession = bound && Array.isArray(sessions)
    ? sessions.find(sess => sess.name === bound)
    : null
  const boundDisplay = boundSession
    ? sessNick(boundSession)
    : (bound && sessions == null && /^session[_-]?\d+$/i.test(bound) ? 'сессия…' : bound)
  const boundTitle = boundSession
    ? `Чат привязан к сессии «${sessLabel(boundSession)}» (${bound}). Клик — сменить.`
    : `Чат привязан к сессии «${bound}». Клик — сменить.`

  return (
    <span className="relative inline-flex" ref={wrapRef}>
      <button
        onClick={toggleOpen}
        className={`px-2 py-0.5 rounded-md border inline-flex items-center gap-1.5 ${
          conflict
            ? 'border-amber-700/60 bg-amber-900/20 text-amber-300 hover:bg-amber-900/40'
            : bound
              ? 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
              : 'border-zinc-800 text-zinc-600 hover:text-zinc-300 hover:border-zinc-600'
        }`}
        style={{ fontSize: '12px' }}
        title={conflict
          ? 'Чат запрашивался из разных сессий — выбери, к какой он относится'
          : bound
            ? boundTitle
            : 'Сессия не определена (старый чат). Клик — привязать вручную.'}
      >
        {conflict ? <TriangleAlert size={12} /> : <UserRound size={12} />}
        {conflict ? 'выбери сессию' : (boundDisplay || 'сессия?')}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-60 z-50 rounded-md border border-zinc-700 bg-zinc-900 shadow-xl py-1">
          <div className="px-3 py-1.5 text-xs uppercase tracking-wider text-zinc-500">
            Привязать к сессии
          </div>
          {sessions == null && (
            <div className="px-3 py-2 text-zinc-500" style={{ fontSize: '13px' }}>Загружаю…</div>
          )}
          {sessions != null && sessions.length === 0 && (
            <div className="px-3 py-2 text-zinc-500" style={{ fontSize: '13px' }}>
              Сессий не найдено — открой настройки Telegram.
            </div>
          )}
          {(sessions || []).map(sess => (
            <button
              key={sess.name}
              onClick={() => pin(sess.name)}
              className={`w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-zinc-800 ${
                sess.name === bound ? 'text-zinc-100' : 'text-zinc-300'
              }`}
              style={{ fontSize: '13px' }}
            >
              <UserRound size={13} className="shrink-0 text-zinc-500" />
              <span className="truncate flex-1">{sessLabel(sess)}</span>
              <span className="text-zinc-600 shrink-0" style={{ fontSize: '11px' }}>{sess.name}</span>
              {sess.authorized === false && (
                <TriangleAlert size={12} className="text-amber-400 shrink-0" />
              )}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

function isVisibleHistoryJobRow(job) {
  try {
    const params = JSON.parse(job?.parameters_json || '{}')
    if (params?._range_plan_child) return false
  } catch {}
  return true
}

function telegramAnalysisBreakdown(analysis) {
  const counts = analysis?.type_counts
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return []
  return Object.entries(counts)
    .map(([type, rawCount]) => ({
      type,
      count: Math.max(0, Math.floor(Number(rawCount) || 0)),
      with_media: 0,
      transcribed: 0,
      processed: 0,
      with_caption: 0,
      analysis_missing: Math.max(0, Math.floor(Number(rawCount) || 0)),
    }))
    .filter(row => row.count > 0)
}

function JobHistoryRow({ job, source, liveJob, onDelete, onCancel }) {
  const [expanded, setExpanded] = useState(false)
  let params = {}
  try { params = JSON.parse(job.parameters_json || '{}') } catch {}
  const dt = job.started_at ? new Date(job.started_at * 1000) : null
  // Effective row: when a live in-memory snapshot exists for this DB row,
  // prefer its items_done / status (it ticks per-event). Falls back to the
  // DB row when the job is finished or has no live counterpart. We do NOT
  // merge wholesale — the DB row keeps started_at/finished_at/error which
  // we want for the static columns, the live snap supplies progress fields.
  const eff = liveJob ? { ...job, ...liveJob, status: liveJob.status, items_done: liveJob.items_done } : job
  const dur = (eff.finished_at && eff.started_at) ? eff.finished_at - eff.started_at : null
  const { label, count, kindIcon, kindColor } = jobRowLabel(eff, params)
  const issue = jobHistoryIssue(eff, params, source)
  const labelTitle = [job.parameters_json, issue.title]
    .filter(Boolean)
    .join('\n')

  // Batch transcribe expands inline — its details (saved/skipped/cost +
  // per-video file list with Open) live entirely in DB + transcripts/, no
  // need for a separate page. tg_fetch still opens full JobDetail.
  // Both YT and TK batch share the same shape, so the same inline panel works.
  const isBatch = job.type === 'yt_batch_transcribe' || job.type === 'tk_batch_transcribe'
  const handleClick = isBatch
    ? () => setExpanded(v => !v)
    : () => pushScreen('job-detail', { jobId: job.id, job })

  const isLive = liveJob && (liveJob.status === 'running' || liveJob.status === 'awaiting_ai')
  return (
    <div className={isBatch && expanded ? 'bg-zinc-950' : ''}>
      <div
        onClick={handleClick}
        className="px-4 py-2 flex items-center gap-3 group cursor-pointer hover:bg-zinc-900/60"
      >
        <StatusDot status={eff.status} />
        <span className={`shrink-0 ${kindColor || 'text-zinc-500'}`} style={{ fontSize: '14px' }} title={kindIcon.title}>
          {kindIcon.glyph}
        </span>
        <span className="text-zinc-400 shrink-0 whitespace-nowrap tabular-nums" style={{ fontSize: '14px' }}>
          {dt ? dt.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${kindColor || 'text-zinc-300'}`} title={labelTitle}>{label}</span>
          {issue.text && (
            <span
              className={`mt-0.5 block truncate ${issue.className}`}
              style={{ fontSize: '12px' }}
              title={issue.title}
            >
              {issue.text}
            </span>
          )}
        </span>
        <span className="text-zinc-500 shrink-0 tabular-nums" style={{ fontSize: '14px' }}>{count}</span>
        {dur !== null && (
          <span className="text-zinc-600 shrink-0 tabular-nums" style={{ fontSize: '14px' }}>
            {dur}s
          </span>
        )}
        {isBatch && (
          <span className="text-zinc-600 shrink-0" style={{ fontSize: '14px' }}>
            {expanded ? '▴' : '▾'}
          </span>
        )}
        {onCancel && (eff.status === 'running' || eff.status === 'pending'
                       || eff.status === 'awaiting_ai') && (
          <button
            onClick={e => { e.stopPropagation(); onCancel() }}
            title="Остановить выполнение"
            className="ml-1 px-2 py-0.5 rounded text-amber-400 border border-amber-700/40 hover:bg-amber-900/20 hover:text-amber-300"
            style={{ fontSize: '12px' }}
          >Стоп</button>
        )}
        {onDelete && (
          <button
            onClick={e => { e.stopPropagation(); onDelete() }}
            title="Удалить запись из истории"
            className="ml-1 text-zinc-700 group-hover:text-red-400 opacity-0 group-hover:opacity-100 inline-flex items-center"
          ><Trash2 size={14} /></button>
        )}
      </div>
      {/* Live progress strip — only shown while the job is actually running.
          Same component used in ActivityPanel and JobDetail; renders nothing
          when there's no media phase or counter to surface, so this row stays
          tidy for plain-text fetches that don't process media. */}
      {isLive && (
        <div className="px-4 pb-2 -mt-1">
          <JobProgress job={liveJob} variant="compact" />
        </div>
      )}
      {isBatch && expanded && (
        <BatchJobInlineDetail jobDbId={job.id} params={params} costUsd={job.cost_usd || 0} />
      )}
    </div>
  )
}

function parseEmbeddedErrorMessage(raw) {
  const s = String(raw || '')
  const brace = s.indexOf('{')
  if (brace < 0) return ''
  try {
    const data = JSON.parse(s.slice(brace))
    return data?.error?.message || data?.message || ''
  } catch {
    return ''
  }
}

function compactOneLine(s, max = 180) {
  const line = String(s || '').replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  return `${line.slice(0, Math.max(0, max - 1))}…`
}

function jobHistoryErrorText(job) {
  if (!job?.error) return ''
  const cleaned = cleanErrorMessage(job.error)
  const message = parseEmbeddedErrorMessage(cleaned) || cleaned
  if (!message) return ''
  if (/GEMINI_API_KEY/i.test(message)) return 'Ключ Gemini не найден'
  if (/API key expired|API_KEY_INVALID|API key not valid|key expired|key is invalid/i.test(message)) {
    return 'Ключ Gemini недоступен'
  }
  if (/Gemini\s+429|quota|rate limit/i.test(message)) return 'Gemini: превышена квота'
  if (/telethon.*not installed|not installed.*telethon|No module named ['"]?telethon/i.test(message)) {
    return 'Telethon не установлен'
  }
  return compactOneLine(message)
}

function isPlainTelegramHistoryFetch(params) {
  const mode = params?.mode || 'last_n'
  if (mode !== 'last_n' && mode !== 'all') return false
  if (params?.date || params?.date_to || params?.url || params?.sinceMessageId) return false
  if (params?.include_comments) return false
  if (Array.isArray(params?.topic_ids) && params.topic_ids.length > 0) return false
  if (Array.isArray(params?._comments_only_post_ids) && params._comments_only_post_ids.length > 0) return false
  if (Array.isArray(params?._media_only_msg_ids) && params._media_only_msg_ids.length > 0) return false
  return true
}

function jobHistoryWarningText(job, params, source) {
  const warning = job?.warning || params?._warning
  if (!warning?.message) return ''
  const itemsDone = Number(job?.items_done || job?.items_total || 0)
  const sourceItems = Number(source?.items_count || 0)
  if (warning.code === 'empty_result' && itemsDone === 0 && sourceItems > 0 && isPlainTelegramHistoryFetch(params)) {
    return 'Telegram вернул 0 сообщений: проверь сессию'
  }
  return compactOneLine(warning.message)
}

function jobHistoryIssue(job, params, source) {
  const errorText = jobHistoryErrorText(job)
  if (errorText) {
    return {
      text: errorText,
      title: cleanErrorMessage(job.error),
      className: 'text-red-400/90',
    }
  }
  const warningText = jobHistoryWarningText(job, params, source)
  if (!warningText) return { text: '', title: '', className: '' }
  const warning = job?.warning || params?._warning
  return {
    text: warningText,
    title: warning?.message || warningText,
    className: warning?.code === 'empty_result' && warningText.includes('проверь сессию')
      ? 'text-red-400/90'
      : 'text-amber-400/90',
  }
}

/**
 * Inline detail panel for a finished yt_batch_transcribe job.  Loads its
 * video list + transcript paths from the items table by external_id, so
 * everything still works after restart (in-memory log is gone).
 */
function BatchJobInlineDetail({ jobDbId, params, costUsd }) {
  const [items, setItems] = useState([])
  const [busy, setBusy] = useState(null)
  const [toast, setToast] = useState(null)
  const sourceId = params?.source_id
  const videoIds = Array.isArray(params?.video_ids) ? params.video_ids : []
  const total = videoIds.length

  useEffect(() => {
    let alive = true
    if (!sourceId || !window.api?.ytItemsState || !videoIds.length) return
    window.api.ytItemsState({ source_id: sourceId, video_ids: videoIds })
      .then(rows => {
        if (!alive) return
        const byId = new Map(rows.map(r => [r.external_id, r]))
        setItems(videoIds.map(vid => byId.get(vid) || { external_id: vid }))
      })
    return () => { alive = false }
  }, [sourceId, videoIds.join(',')]) // eslint-disable-line

  const savedCount = items.filter(it => it?.transcript_path).length

  async function copyAll() {
    setBusy('copy')
    try {
      const r = await window.api.ytAssembleBatch({
        source_id: sourceId, video_ids: videoIds, action: 'copy',
      })
      setToast(r.ok ? `Copied · ${r.count} видео · ${formatBytes(r.bytes)}` : `Failed: ${r.error}`)
    } finally {
      setBusy(null)
      setTimeout(() => setToast(null), 2500)
    }
  }
  async function saveCombined() {
    setBusy('save')
    try {
      const r = await window.api.ytAssembleBatch({
        source_id: sourceId, video_ids: videoIds, action: 'save',
      })
      if (r.ok) {
        setToast(`Saved · ${r.count} видео`)
        if (r.file_path) window.api.openExternal(r.file_path)
      } else setToast(`Failed: ${r.error}`)
    } finally {
      setBusy(null)
      setTimeout(() => setToast(null), 2500)
    }
  }

  return (
    <div className="px-4 py-3 border-t border-zinc-800/80 bg-zinc-950">
      <div className="flex items-center gap-3 mb-2 text-zinc-400" style={{ fontSize: '14px' }}>
        <span>Сохранено: <span className="text-emerald-400 tabular-nums">{savedCount}</span> / {total}</span>
        {costUsd > 0 && <span>· потрачено <span className="text-zinc-200 tabular-nums">${Number(costUsd).toFixed(4)}</span></span>}
        {params?.engine && <span>· движок <span className="text-zinc-300">{params.engine}</span></span>}
        {params?.lang && <span>· lang <span className="text-zinc-300">{params.lang}</span></span>}
      </div>

      {savedCount > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={(e) => { e.stopPropagation(); copyAll() }}
            disabled={busy === 'copy'}
            className="px-3 py-1.5 rounded-md text-sm bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500 inline-flex items-center gap-1.5"
          ><Copy size={14} /> Скопировать всё</button>
          <button
            onClick={(e) => { e.stopPropagation(); saveCombined() }}
            disabled={busy === 'save'}
            className="px-3 py-1.5 rounded-md text-sm text-zinc-300 hover:bg-zinc-900 inline-flex items-center gap-1.5"
          ><Save size={14} /> Сохранить вместе</button>
          {toast && <span className="text-zinc-400 ml-2" style={{ fontSize: '14px' }}>{toast}</span>}
        </div>
      )}

      <div className="rounded-md border border-zinc-800 divide-y divide-zinc-900 max-h-60 overflow-auto">
        {items.length === 0 && (
          <div className="px-3 py-2 text-zinc-600 italic" style={{ fontSize: '14px' }}>Нет данных по видео</div>
        )}
        {items.map((it) => (
          // Строка с транскриптом кликабельна целиком — то же действие, что
          // кнопка «Открыть» (паттерн «весь блок кликабелен», не только кнопка).
          <div
            key={it.external_id}
            onClick={it.transcript_path
              ? () => window.api?.openExternal?.(it.transcript_path)
              : undefined}
            role={it.transcript_path ? 'button' : undefined}
            title={it.transcript_path ? 'Открыть транскрипт' : undefined}
            className={`px-3 py-1.5 flex items-center gap-3 ${it.transcript_path ? 'cursor-pointer hover:bg-zinc-900/60' : ''}`}
            style={{ fontSize: '14px' }}
          >
            <span className={`shrink-0 ${it.transcript_path ? 'text-emerald-400' : 'text-zinc-600'}`}>
              {it.transcript_path ? '✓' : '—'}
            </span>
            <span className="text-zinc-300 truncate flex-1" title={it.title}>
              {it.title || <code className="text-zinc-500">{it.external_id}</code>}
            </span>
            {it.transcript_path && (
              <button
                onClick={(e) => { e.stopPropagation(); window.api?.openExternal?.(it.transcript_path) }}
                className="text-zinc-500 hover:text-zinc-200 shrink-0"
              >Открыть</button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function jobRowLabel(job, params) {
  const t = job.type
  // YouTube/TikTok channel listing — both via yt-dlp --flat-playlist, $0.
  if (t === 'yt_channel_fetch' || t === 'tk_channel_fetch') {
    // If the channel turned out to have fewer videos than the requested
    // limit, the job effectively pulled the *full* channel — show that
    // instead of "N=200" which misleads ("I asked for 200 but got 6").
    const got = job.items_done || 0
    const limit = params.limit
    const sizeStr = (limit && got < limit) ? `Full · ${got}` : (limit ? `N=${limit}` : null)
    return {
      label: `Список видео${sizeStr ? ` · ${sizeStr}` : ''} · бесплатно (yt-dlp)`,
      count: `${got.toLocaleString()} видео`,
      kindIcon: { glyph: '📋', title: 'Парсинг списка видео — yt-dlp, $0' },
      kindColor: 'text-zinc-400',
    }
  }
  // YouTube/TikTok batch transcribe — same shape, same engine field.
  if (t === 'yt_batch_transcribe' || t === 'tk_batch_transcribe') {
    const total = job.items_total || (params.video_ids?.length ?? 0)
    const failed = job.items_failed || 0
    const cost = Number(job.cost_usd || 0)
    // Always show cost — even $0 (subs path on YouTube). Free batches deserve
    // an explicit label so the user doesn't wonder if it broke.
    const costStr = cost > 0 ? ` · $${cost.toFixed(4)}` : ' · бесплатно'
    return {
      label: `Транскрипция${params.engine ? ` · ${params.engine}` : ''}${params.with_ts ? ' · с TS' : ''}${costStr}`,
      count: `${(job.items_done || 0).toLocaleString()}/${total}${failed ? ` · ${failed} err` : ''}`,
      kindIcon: { glyph: '🎤', title: cost > 0 ? `Транскрибация — $${cost.toFixed(4)}` : 'Транскрибация — бесплатно (только субтитры)' },
      kindColor: 'text-emerald-400',
    }
  }
  // Semantic indexing — separate from tg_fetch because it has no `mode`
  // and its progress is "embeddings done / total to embed", not msgs.
  // Reuses the same Activity-bar shape (items_done / items_total),
  // which IndexJob now keeps current via mid-run db.updateJob calls.
  if (t === 'tg_index') {
    const total = job.items_total || 0
    const done  = job.items_done || 0
    return {
      label: `Семантический индекс${params.limit ? ` · N=${params.limit}` : ''}`,
      count: total ? `${done.toLocaleString()} / ${total.toLocaleString()}` : `${done.toLocaleString()}`,
      kindIcon: { glyph: '🧠', title: 'Векторный индекс — Gemini embedding' },
      kindColor: 'text-zinc-400',
    }
  }
  // Reply backfill — sweeps existing items adding parent_external_id.
  if (t === 'tg_reply_backfill') {
    const total = job.items_total || 0
    const done  = job.items_done || 0
    return {
      label: 'Reply-граф — backfill',
      count: total ? `${done.toLocaleString()} / ${total.toLocaleString()}` : `${done.toLocaleString()}`,
      kindIcon: { glyph: '🧵', title: 'Дозабор reply-связей' },
      kindColor: 'text-zinc-400',
    }
  }
  // Pre-analysis — short, fixed shape; just say "пред-анализ".
  if (t === 'tg_preview') {
    return {
      label: 'Пред-анализ',
      count: job.items_done ? `${job.items_done.toLocaleString()} msgs` : '',
      kindIcon: { glyph: '🔎', title: 'Пред-анализ диапазона' },
      kindColor: 'text-zinc-400',
    }
  }
  // On-demand media (re)processing of picked messages — rides on tg_fetch but
  // reads as «перевод медиа», not a fetch. Count comes from media_phase
  // (done/total across kinds) since job.items_done is 0 (no metadata walk).
  if (t === 'tg_fetch' && params.mode === 'media_only') {
    const mp = job.media_phase || {}
    let done = 0, total = 0
    for (const k of ['voice', 'photo', 'pdf']) {
      if (mp[k]) { done += mp[k].done || 0; total += mp[k].total || 0 }
    }
    const n = Array.isArray(params._media_only_msg_ids) ? params._media_only_msg_ids.length : total
    return {
      label: `Перевод медиа${params.transcribe_engine ? ` · ${params.transcribe_engine}` : ''}`,
      count: total ? `${done} / ${total}` : (n ? `${n}` : ''),
      kindIcon: { glyph: '🎤', title: 'On-demand транскрипция / описание выбранных сообщений' },
      kindColor: 'text-emerald-400',
    }
  }
  // tg_fetch and friends
  return {
    label: `${modeLabel(params.mode)}${params.limit ? ` · N=${params.limit}` : ''}${params.date ? ` · ${params.date}` : ''}`,
    count: `${(job.items_done || 0).toLocaleString()} msgs`,
    kindIcon: { glyph: '📥', title: 'Парсинг сообщений' },
    kindColor: 'text-zinc-400',
  }
}

function StatusDot({ status }) {
  // Active statuses get a small rotating ring instead of a static dot, so a
  // running job in "История парсинга" reads as "в процессе" without having
  // to compare timestamps. Done / error / cancelled remain plain dots.
  if (status === 'running' || status === 'awaiting_ai' || status === 'pending') {
    const ringColor = status === 'awaiting_ai' ? '#f59e0b' : '#10b981'
    return (
      <span
        className="inline-block w-3 h-3 rounded-full shrink-0 animate-spin"
        style={{
          border: '2px solid rgba(255,255,255,0.12)',
          borderTopColor: ringColor,
        }}
      />
    )
  }
  const color = {
    done:        '#71717a',
    error:       '#ef4444',
    cancelled:   '#a1a1aa',
    // Zombie row left running by a previous session — startup cleanup
    // flips them to 'interrupted'. Distinct from cancelled (user
    // intent) and error (real failure); same muted-amber as awaiting_ai
    // ring since it's a "needs attention" state.
    interrupted: '#f59e0b',
  }[status] || '#71717a'
  return <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
}

// Render the saved-items date range as a compact "DD.MM.YY — DD.MM.YY"
// (or "мар 24 — апр 26" for streaming platforms whose timestamps are
// month-precision). Falls back to last-item-only if min/max collapse,
// and to "—" if nothing is known.
function renderPeriod(range, platform, lastItemAt) {
  const min = range?.min_at, max = range?.max_at
  if (!min && !max) {
    if (!lastItemAt) return '—'
    return platform === 'youtube'
      ? lastItemAt.toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' }).replace('.', '')
      : lastItemAt.toLocaleDateString('ru-RU')
  }
  const fmt = ts => {
    const d = new Date(ts * 1000)
    if (isNaN(d.getTime())) return '—'
    return platform === 'youtube'
      ? d.toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' }).replace('.', '')
      : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
  }
  if (min === max || !min) return fmt(max)
  return `${fmt(min)} — ${fmt(max)}`
}

// «Обзор» button — only platforms with a cheap, fetch-independent
// summary that's worth its own UI affordance.  IG's web_profile_info is
// the ideal case: one HTTP, returns global profile stats that don't
// depend on what you're about to parse — so it makes sense as a
// separate button.  TG's pre-analysis IS a preview of the configured
// request (last_n / from_date / range / …) — it lives *inside* the
// «Новый запрос…» form because it depends on those params; making it a
// separate top-level button hardcodes a single range and breaks the
// determinism principle (the user wanted to see THE preview of what
// they're about to fetch).  YT/TK don't have a free preview at all.
function hasOverview(platform) {
  return platform === 'instagram' || isSocialSource(platform)
}

function hasNewRequestForm(platform) {
  return platform === 'telegram'
      || platform === 'instagram'
      || platform === 'youtube'
      || platform === 'tiktok'
}

function isSocialSource(platform) {
  return platform === 'reddit' || platform === 'twitter'
}

function modeLabel(mode) {
  return ({
    last_n:     'Последние N',
    all:        'Весь чат',
    from_date:  'С даты',
    date_range: 'Диапазон',
    between:    'Между URL',
    single:     'Одно сообщение',
  })[mode] || mode || '—'
}

function humanAgo(secs) {
  if (secs < 60)        return `${Math.round(secs)} сек назад`
  if (secs < 3600)      return `${Math.round(secs / 60)} мин назад`
  if (secs < 86400)     return `${Math.round(secs / 3600)} ч назад`
  return `${Math.round(secs / 86400)} дн назад`
}

// ─── Обзор panels ─────────────────────────────────────────────────────

function InstagramOverview({ handle }) {
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  async function run() {
    if (busy || !window.api?.igOverview) return
    setBusy(true); setErr(null)
    try {
      const r = await window.api.igOverview({ handle })
      if (r?.ok) setData(r.profile)
      else setErr(r?.error || 'overview failed')
    } catch (e) {
      setErr(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { run() }, [])    // eslint-disable-line

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
      <div className="text-zinc-300 font-medium mb-3" style={{ fontSize: '15px' }}>
        Обзор · публичные данные профиля
      </div>
      {err && (
        <div className="px-3 py-2 rounded bg-red-950/40 border border-red-900/60 text-red-300" style={{ fontSize: '14px' }}>
          {err}
        </div>
      )}
      {busy && !data && (
        <div className="text-zinc-500 italic" style={{ fontSize: '14px' }}>Загрузка…</div>
      )}
      {data && (
        <div className="flex items-start gap-4">
          {data.profile_pic_url && (
            <img
              src={data.profile_pic_url}
              alt=""
              className="w-16 h-16 rounded-full bg-zinc-800 shrink-0"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="flex-1 min-w-0 space-y-1 text-zinc-300" style={{ fontSize: '14px' }}>
            <div className="flex items-baseline gap-2">
              <span className="font-medium text-zinc-100">{data.full_name || data.username}</span>
              {data.is_verified && <span className="text-emerald-400 text-xs">✓ verified</span>}
              {data.is_private && <span className="text-amber-400 text-xs">🔒 приватный</span>}
            </div>
            <div className="text-zinc-500">@{data.username}</div>
            {data.biography && (
              <div className="text-zinc-400 whitespace-pre-wrap" style={{ fontSize: '13px' }}>{data.biography}</div>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2">
              {data.media_count != null && (
                <span><span className="text-zinc-500">Публикаций:</span> {data.media_count.toLocaleString('ru-RU')}</span>
              )}
              {data.follower_count != null && (
                <span><span className="text-zinc-500">Подписчиков:</span> {data.follower_count.toLocaleString('ru-RU')}</span>
              )}
              {data.following_count != null && (
                <span><span className="text-zinc-500">Подписок:</span> {data.following_count.toLocaleString('ru-RU')}</span>
              )}
            </div>
            {data.external_url && (
              <a
                href="#"
                onClick={e => { e.preventDefault(); window.api?.openExternal?.(data.external_url) }}
                className="text-zinc-500 hover:text-zinc-300 break-all inline-block"
                style={{ fontSize: '13px' }}
              >{data.external_url}</a>
            )}
            <div className="text-zinc-600 pt-2" style={{ fontSize: '13px' }}>
              media_count = posts + reels (Instagram не разбивает по типам в этом эндпоинте).
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Telegram-only: «Дотянуть комментарии» action. Posts and their msg_ids are
// already in the items table; this fires a comments-only fetch (no metadata
// re-walk) for the post-ids that don't yet have any stored comments.
//
// `comments_limit` defaults to 0 (no limit) — same as the form. If the user
// wants per-post limit they should re-run from «Новый запрос…» with the
// limit input set; this button is the «just dotянуть everything missing»
// shortcut, optimised for one click.
function CatchUpCommentsButton({ sourceId, handle, totalPosts, postsWithComments }) {
  const [busy, setBusy] = React.useState(false)
  const remaining = Math.max(0, totalPosts - postsWithComments)
  async function go() {
    if (busy || !window.api?.tgPostsWithComments || !window.api?.itemsList) return
    setBusy(true)
    try {
      // 1. Pull all post msg_ids from items, 2. subtract ones we have, 3. fire.
      // No paging: TG channels rarely have >50k posts and items.external_id is
      // an indexed column. Single SELECT is fine.
      const itemsRes = await window.api.itemsList({
        source_id: sourceId, limit: 100000, offset: 0,
        order: 'published_at DESC',
      })
      const allIds = new Set((itemsRes || []).map(it => String(it.external_id)))
      const covered = new Set((await window.api.tgPostsWithComments(sourceId)) || [])
      const missing = []
      for (const id of allIds) if (!covered.has(id)) missing.push(id)
      if (missing.length === 0) return
      await window.api.tgCatchUpComments({
        target:         handle ? '@' + String(handle).replace(/^@/, '') : null,
        source_id:      sourceId,
        post_ids:       missing.map(s => Number(s)).filter(Number.isFinite),
        comments_limit: 0,
      })
    } finally {
      setBusy(false)
    }
  }
  // h-9 to line up with the other action-row buttons (ToolbarButton is h-9;
  // the old py-2 made this ~2px taller and broke the baseline). Fixed label
  // text via a stable label string keeps width from collapsing to «…» width
  // mid-run — the spinner replaces the glyph, not the whole label.
  const label = `Дотянуть комментарии${remaining ? ` (${remaining})` : ''}`
  return (
    <button
      onClick={go}
      disabled={busy}
      title={`Догнать комментарии для ${remaining} постов без обсуждений в БД`}
      className="h-9 px-4 inline-flex items-center gap-1.5 rounded-md text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
    >
      {busy
        ? <RotateCw size={14} className="animate-spin shrink-0" />
        : <MessageCircle size={15} className="shrink-0" />}
      <span>{label}</span>
    </button>
  )
}
