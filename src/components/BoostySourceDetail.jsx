import React, { useEffect, useMemo, useState } from 'react'
import {
  Captions, Check, ChevronDown, ChevronRight, Copy, Download, ExternalLink,
  FolderOpen, RotateCw, Search, SlidersHorizontal, Square, StickyNote, Trash2, Video,
} from 'lucide-react'
import Avatar from './Avatar'
import PlatformLogo from './PlatformLogo'
import { goHome, pushScreen } from '../lib/store'
import { refreshSources } from '../lib/sources'
import { useJobs } from '../lib/jobs'
import { useInvalidator } from '../lib/dataBus'

export default function BoostySourceDetail({ source: initialSource, jobs: historicJobs = [] }) {
  const sourceId = Number(initialSource.id)
  const [payload, setPayload] = useState(null)
  const [storage, setStorage] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [expanded, setExpanded] = useState(new Set())
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('new')
  const [query, setQuery] = useState('')
  const [requestOpen, setRequestOpen] = useState(false)
  const [requestLimit, setRequestLimit] = useState('all')
  const [customLimit, setCustomLimit] = useState('500')
  const [requestOrder, setRequestOrder] = useState('desc')
  const [requestTag, setRequestTag] = useState('')
  const [requestFrom, setRequestFrom] = useState('')
  const [requestTo, setRequestTo] = useState('')
  const [requestOnlyAllowed, setRequestOnlyAllowed] = useState(false)
  const [busy, setBusy] = useState(null)
  const [notice, setNotice] = useState(null)
  const jobs = useJobs()
  const sourceVer = useInvalidator(`source:${sourceId}`)
  const itemsVer = useInvalidator(`items:${sourceId}`)

  async function reload() {
    if (!window.api?.boostyPosts) return
    const [next, disk] = await Promise.all([
      window.api.boostyPosts({ source_id: sourceId }),
      window.api.sourceStorage?.(sourceId),
    ])
    if (next?.ok) setPayload(next)
    if (disk?.ok) setStorage(disk)
  }

  useEffect(() => { reload().catch(err => flash(cleanError(err))) }, [sourceId, sourceVer, itemsVer])

  const liveForSource = useMemo(() => jobs.filter(job => (
    Number(job.source_id) === sourceId &&
    (job.type === 'boosty_channel_fetch' || job.type === 'boosty_batch_transcribe')
  )), [jobs, sourceId])
  const activeJob = liveForSource.find(job => job.status === 'running') || null
  const terminalSignature = liveForSource
    .filter(job => job.status !== 'running')
    .map(job => `${job.id}:${job.status}:${job.finished_at || 0}`)
    .join('|')
  useEffect(() => { if (terminalSignature) reload().catch(() => {}) }, [terminalSignature])

  const source = payload?.source || initialSource
  const meta = payload?.meta || parseMeta(source.meta_json)
  const posts = payload?.posts || []
  const stats = payload?.stats || {
    posts: Number(source.items_count || 0),
    videos: Number(source.boosty_videos_count || 0),
    transcribed: Number(source.boosty_transcribed_count || 0),
    audio_bytes: 0,
  }

  const visiblePosts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru-RU')
    const filtered = posts.filter(post => {
      if (needle && !`${post.title || ''}\n${post.caption || ''}`.toLocaleLowerCase('ru-RU').includes(needle)) return false
      if (filter === 'transcribed') return post.transcribed_count > 0
      if (filter === 'untranscribed') return post.known_videos_count > post.transcribed_count && post.meta.access_state === 'accessible'
      if (filter === 'audio') return post.media_present_count > 0
      if (filter === 'locked') return post.meta.access_state === 'locked' || post.meta.access_state === 'lost'
      return true
    })
    return [...filtered].sort((a, b) => {
      if (sort === 'old') return Number(a.published_at || 0) - Number(b.published_at || 0)
      if (sort === 'long') return Number(b.duration_seconds || 0) - Number(a.duration_seconds || 0)
      if (sort === 'heavy') return Number(b.media_bytes || 0) - Number(a.media_bytes || 0)
      return Number(b.published_at || 0) - Number(a.published_at || 0)
    })
  }, [posts, filter, sort, query])

  function flash(message) {
    setNotice(message)
    setTimeout(() => setNotice(current => current === message ? null : current), 3200)
  }

  async function refreshCatalog(request = {}) {
    if (busy || activeJob) return
    setBusy('catalog')
    try {
      await window.api.boostyChannelFetch({
        target: meta.canonical_url || `https://boosty.to/${source.handle}`,
        limit: Number(request.limit || 0),
        order: request.order === 'asc' ? 'asc' : 'desc',
        from_ts: request.from_ts || null,
        to_ts: request.to_ts || null,
        tags: Array.isArray(request.tags) ? request.tags : [],
        only_allowed: !!request.only_allowed,
      })
      flash('Обновление каталога запущено')
    } catch (err) {
      flash(cleanError(err))
    } finally {
      setBusy(null)
    }
  }

  function submitCatalogRequest(event) {
    event.preventDefault()
    const limit = requestLimit === 'all'
      ? 0
      : requestLimit === 'custom'
        ? Math.max(1, Number(customLimit || 1))
        : Number(requestLimit)
    const fromTs = requestFrom
      ? Math.floor(new Date(`${requestFrom}T00:00:00`).getTime() / 1000)
      : null
    const toTs = requestTo
      ? Math.floor(new Date(`${requestTo}T23:59:59`).getTime() / 1000)
      : null
    if (fromTs && toTs && fromTs > toTs) {
      flash('Начало периода должно быть раньше конца')
      return
    }
    refreshCatalog({
      limit,
      order: requestOrder,
      from_ts: fromTs,
      to_ts: toTs,
      tags: requestTag ? [requestTag] : [],
      only_allowed: requestOnlyAllowed,
    })
  }

  async function runBatch(mode, ids = [...selected]) {
    const unique = [...new Set(ids.map(String).filter(Boolean))]
    if (!unique.length || busy || activeJob) return
    setBusy(mode)
    try {
      await window.api.boostyBatchTranscribe({ source_id: sourceId, video_ids: unique, mode })
      flash(mode === 'download' ? `Скачивание запущено: ${unique.length}` : `Расшифровка запущена: ${unique.length}`)
    } catch (err) {
      flash(cleanError(err))
    } finally {
      setBusy(null)
    }
  }

  async function copyTranscripts(ids = [...selected]) {
    const result = await window.api.boostyCopyTranscripts({ source_id: sourceId, video_ids: ids })
    flash(result?.ok ? `Скопировано расшифровок: ${result.count}` : (result?.error || 'Нечего копировать'))
  }

  async function deleteAudio(ids, label, expectedBytes = 0) {
    const unique = [...new Set(ids.map(String).filter(Boolean))]
    if (!unique.length) return
    const yes = window.confirm(
      `Удалить локальное аудио ${label}${expectedBytes ? ` (${fmtSize(expectedBytes)})` : ''}?\n\n` +
      'Посты, обложки, метаданные и расшифровки останутся. Аудио можно скачать заново.'
    )
    if (!yes) return
    setBusy('delete')
    try {
      const result = await window.api.boostyDeleteAudio({ source_id: sourceId, video_ids: unique })
      await reload()
      flash(`Освобождено ${fmtSize(result?.bytes || 0)} · файлов: ${result?.removed || 0}`)
    } catch (err) {
      flash(cleanError(err))
    } finally {
      setBusy(null)
    }
  }

  async function deleteAllAudio() {
    const ids = posts.flatMap(post => post.videos).filter(video => video.media_present).map(video => video.external_id)
    await deleteAudio(ids, `для автора «${source.display_name || source.handle}»`, stats.audio_bytes)
  }

  async function deleteSource() {
    const yes = window.confirm(
      `Удалить источник «${source.display_name || source.handle}» вместе с постами, расшифровками в библиотеке и историей?\n\n` +
      'Это нельзя отменить. Локальные файлы на диске останутся.'
    )
    if (!yes) return
    await window.api.sourcesDelete(sourceId)
    await refreshSources()
    goHome()
  }

  function toggleVideo(id) {
    setSelected(prev => {
      const next = new Set(prev)
      const key = String(id)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  function togglePost(post) {
    const ids = post.videos.map(video => String(video.external_id))
    if (!ids.length) return
    const all = ids.every(id => selected.has(id))
    setSelected(prev => {
      const next = new Set(prev)
      for (const id of ids) all ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleExpanded(id) {
    setExpanded(prev => {
      const next = new Set(prev)
      const key = String(id)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const selectedVideos = posts.flatMap(post => post.videos).filter(video => selected.has(String(video.external_id)))
  const selectedAudio = selectedVideos.filter(video => video.media_present)
  const selectedTranscribed = selectedVideos.filter(video => video.transcript_present)
  const selectedAudioBytes = selectedAudio.reduce((sum, video) => sum + Number(video.media_bytes || 0), 0)
  const dateValues = posts.map(post => Number(post.published_at || 0)).filter(Boolean)
  const minDate = dateValues.length ? Math.min(...dateValues) : null
  const maxDate = dateValues.length ? Math.max(...dateValues) : null

  return (
    <div className="h-full overflow-auto px-8 py-6">
      <div className="max-w-6xl mx-auto pb-12">
        <div className="mb-6 flex items-center gap-3">
          <div className="relative shrink-0">
            <Avatar source={source} size={42} />
            <span className="absolute -bottom-0.5 -right-0.5 ring-2 ring-zinc-950 rounded-full bg-zinc-950 leading-none"><PlatformLogo platform="boosty" size={15} /></span>
          </div>
          <div className="min-w-0">
            <div className="text-xl font-semibold text-zinc-100 truncate">{source.display_name || `@${source.handle}`}</div>
            <div className="text-zinc-500 text-sm">@{source.handle}{meta.subscription?.name ? ` · уровень «${meta.subscription.name}»` : ''}</div>
          </div>
          <button type="button" onClick={() => pushScreen('notes', { sourceId })} className="ml-auto h-9 px-3 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 inline-flex items-center gap-2"><StickyNote size={14} /> Заметки</button>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-4">
          <Stat label="Известно постов" value={Number(stats.posts || 0).toLocaleString('ru-RU')} />
          <Stat label="Расшифровано видео" value={`${Number(stats.transcribed || 0).toLocaleString('ru-RU')} / ${Number(stats.videos || 0).toLocaleString('ru-RU')}`} />
          <Stat label="Аудио на диске" value={fmtSize(stats.audio_bytes || 0)} />
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-4">
          <button type="button" onClick={() => refreshCatalog()} disabled={!!activeJob || busy === 'catalog'} className="h-9 px-3 rounded-md bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500 inline-flex items-center gap-2"><RotateCw size={14} className={activeJob?.type === 'boosty_channel_fetch' ? 'animate-spin' : ''} /> {activeJob?.type === 'boosty_channel_fetch' ? 'Читаю каталог…' : 'Обновить весь каталог'}</button>
          <button type="button" onClick={() => setRequestOpen(value => !value)} aria-expanded={requestOpen} className={`h-9 px-3 rounded-md border inline-flex items-center gap-2 ${requestOpen ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}><SlidersHorizontal size={14} /> Новый запрос…</button>
          <button type="button" onClick={() => window.api?.openUrl?.(meta.canonical_url || `https://boosty.to/${source.handle}`)} className="h-9 px-3 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-2"><ExternalLink size={14} /> Открыть Boosty</button>
          {notice && <span className="text-zinc-400 text-sm ml-2">{notice}</span>}
        </div>

        {requestOpen && (
          <form onSubmit={submitCatalogRequest} className="mb-4 rounded-md border border-zinc-800 bg-zinc-950 p-4 grid grid-cols-2 gap-4 text-sm">
            <label className="space-y-1.5">
              <span className="text-zinc-500">Сколько постов</span>
              <div className="flex gap-2">
                <select value={requestLimit} onChange={event => setRequestLimit(event.target.value)} className="h-9 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-zinc-200">
                  <option value="all">Вся лента</option>
                  <option value="200">Последние / первые 200</option>
                  <option value="custom">Своё число</option>
                </select>
                {requestLimit === 'custom' && <input type="number" min="1" value={customLimit} onChange={event => setCustomLimit(event.target.value)} className="h-9 w-24 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-zinc-200" />}
              </div>
            </label>
            <label className="space-y-1.5">
              <span className="text-zinc-500">Направление</span>
              <select value={requestOrder} onChange={event => setRequestOrder(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-zinc-200">
                <option value="desc">Новые сначала</option>
                <option value="asc">Старые сначала</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-zinc-500">Период с</span>
              <input type="date" value={requestFrom} onChange={event => setRequestFrom(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-zinc-200" />
            </label>
            <label className="space-y-1.5">
              <span className="text-zinc-500">по</span>
              <input type="date" value={requestTo} onChange={event => setRequestTo(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-zinc-200" />
            </label>
            <label className="space-y-1.5">
              <span className="text-zinc-500">Тег</span>
              <select value={requestTag} onChange={event => setRequestTag(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-zinc-200">
                <option value="">Все теги</option>
                {(meta.catalog_tags || []).map(tag => <option key={tag.id} value={tag.id}>{tag.title || tag.id}{tag.count != null ? ` · ${tag.count}` : ''}</option>)}
              </select>
            </label>
            <div className="flex items-end justify-between gap-4">
              <label className="h-9 inline-flex items-center gap-2 text-zinc-400">
                <input type="checkbox" checked={requestOnlyAllowed} onChange={event => setRequestOnlyAllowed(event.target.checked)} />
                Только доступные мне
              </label>
              <button type="submit" disabled={!!activeJob || busy === 'catalog'} className="h-9 px-4 rounded-md bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500">Запросить</button>
            </div>
            <div className="col-span-2 text-zinc-600">Запрос сохраняет только список постов и видео. Аудио и платная расшифровка запускаются отдельно из выбора ниже.</div>
          </form>
        )}

        <CoverageLine complete={meta.catalog_complete} posts={stats.posts} minDate={minDate} maxDate={maxDate} syncedAt={source.last_synced_at} />

        {storage && (
          <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950 px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className="text-zinc-500">На диске</span>
            <StorageChip label="Аудио" bytes={storage.media?.bytes} />
            <StorageChip label="Обложки" bytes={storage.thumbnails?.bytes} />
            <StorageChip label="Расшифровки" bytes={storage.transcripts?.bytes} />
            {Number(storage.text?.bytes || 0) > 0 && <StorageChip label="Текст" bytes={storage.text.bytes} />}
            {Number(storage.index?.bytes || 0) > 0 && <StorageChip label="Индекс" bytes={storage.index.bytes} />}
            <span className="text-zinc-700">·</span>
            <span className="text-zinc-400">всего <span className="text-zinc-100 font-medium tabular-nums">{fmtSize(storage.total_bytes)}</span></span>
            {stats.audio_bytes > 0 && <button type="button" onClick={deleteAllAudio} className="ml-auto h-8 px-2.5 rounded text-red-300 hover:bg-red-950/40 inline-flex items-center gap-1.5"><Trash2 size={14} /> Удалить всё аудио · {fmtSize(stats.audio_bytes)}</button>}
            <button type="button" onClick={() => window.api?.storageOpenRoot?.(storage.root)} title="Открыть хранилище" className={`${stats.audio_bytes > 0 ? '' : 'ml-auto'} p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800`}><FolderOpen size={15} /></button>
          </div>
        )}

        {activeJob?.type === 'boosty_batch_transcribe' && <ActiveBatch job={activeJob} />}

        <div className="mt-6 flex items-center gap-2">
          <h2 className="text-zinc-200 font-medium mr-auto">Видеопосты</h2>
          <select value={filter} onChange={event => setFilter(event.target.value)} className="h-9 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-zinc-300 text-sm">
            <option value="all">Все</option>
            <option value="transcribed">Есть расшифровка</option>
            <option value="untranscribed">Нет расшифровки</option>
            <option value="audio">Аудио на диске</option>
            <option value="locked">Нет доступа</option>
          </select>
          <select value={sort} onChange={event => setSort(event.target.value)} className="h-9 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-zinc-300 text-sm">
            <option value="new">Новые сначала</option>
            <option value="old">Старые сначала</option>
            <option value="long">Сначала длинные</option>
            <option value="heavy">Сначала тяжёлые</option>
          </select>
          <label className="h-9 w-56 rounded-md border border-zinc-800 bg-zinc-950 px-3 flex items-center gap-2 focus-within:border-zinc-600">
            <Search size={14} className="text-zinc-600" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск" className="bg-transparent outline-none min-w-0 flex-1 text-zinc-200 text-sm" />
          </label>
        </div>

        {selected.size > 0 && (
          <div className="mt-3 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 flex items-center gap-2 text-sm sticky top-2 z-10 shadow-xl">
            <span className="text-zinc-300 mr-2">Выбрано: {selected.size}</span>
            <button type="button" onClick={() => runBatch('transcribe')} className="h-8 px-2.5 rounded bg-zinc-100 text-zinc-900 hover:bg-white">Расшифровать · {selected.size}</button>
            <button type="button" onClick={() => runBatch('download')} className="h-8 px-2.5 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 inline-flex items-center gap-1.5"><Download size={13} /> Скачать аудио</button>
            {selectedTranscribed.length > 0 && <button type="button" onClick={() => copyTranscripts(selectedTranscribed.map(video => video.external_id))} className="h-8 px-2.5 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 inline-flex items-center gap-1.5"><Copy size={13} /> Скопировать · {selectedTranscribed.length}</button>}
            {selectedAudio.length > 0 && <button type="button" onClick={() => deleteAudio(selectedAudio.map(video => video.external_id), `для ${selectedAudio.length} видео`, selectedAudioBytes)} className="h-8 px-2.5 rounded text-red-300 hover:bg-red-950/40 inline-flex items-center gap-1.5"><Trash2 size={13} /> Удалить аудио · {fmtSize(selectedAudioBytes)}</button>}
            <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-zinc-500 hover:text-zinc-200">Снять выбор</button>
          </div>
        )}

        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 divide-y divide-zinc-900 overflow-hidden">
          {!visiblePosts.length && <div className="px-4 py-8 text-zinc-500 text-center">По этому фильтру постов нет</div>}
          {visiblePosts.map(post => (
            <PostRow
              key={post.external_id}
              post={post}
              selected={selected}
              expanded={expanded.has(String(post.external_id))}
              onTogglePost={() => togglePost(post)}
              onToggleVideo={toggleVideo}
              onToggleExpanded={() => toggleExpanded(post.external_id)}
              onTranscribe={ids => runBatch('transcribe', ids)}
              onDownload={ids => runBatch('download', ids)}
              onCopy={copyTranscripts}
              onDelete={(ids, label, bytes) => deleteAudio(ids, label, bytes)}
            />
          ))}
        </div>

        <div className="mt-8">
          <div className="flex items-center mb-2"><h2 className="text-zinc-300 font-medium">История запросов</h2><span className="ml-2 text-zinc-600 text-sm">{historicJobs.length}</span></div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 divide-y divide-zinc-900">
            {!historicJobs.length && <div className="px-4 py-4 text-zinc-600 text-sm">История пока пуста</div>}
            {historicJobs.slice(0, 20).map(job => (
              <button key={job.id} type="button" onClick={() => pushScreen('job-detail', { jobId: job.id, job })} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-zinc-900 text-sm">
                <span className={`w-2 h-2 rounded-full ${job.status === 'done' ? 'bg-emerald-500' : job.status === 'error' ? 'bg-red-500' : 'bg-zinc-500'}`} />
                <span className="text-zinc-300">{job.type === 'boosty_channel_fetch' ? 'Каталог постов' : job.parameters_json?.includes('download') ? 'Скачивание аудио' : 'Расшифровка видео'}</span>
                <span className="text-zinc-600 tabular-nums">{Number(job.items_done || 0)} / {Number(job.items_total || 0)}</span>
                <span className="ml-auto text-zinc-600">{job.started_at ? new Date(job.started_at * 1000).toLocaleString('ru-RU') : '—'}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-10 rounded-lg border border-red-950/80 bg-red-950/10 p-4 flex items-center gap-4">
          <div className="flex-1"><div className="text-red-300 font-medium">Опасная зона</div><div className="text-zinc-600 text-sm mt-0.5">Удаление источника необратимо. Удаление аудио выше — обратимый кэш.</div></div>
          <button type="button" onClick={deleteSource} className="h-9 px-3 rounded-md border border-red-900 text-red-300 hover:bg-red-950/40 inline-flex items-center gap-2"><Trash2 size={14} /> Удалить источник</button>
        </div>
      </div>
    </div>
  )
}

function PostRow({ post, selected, expanded, onTogglePost, onToggleVideo, onToggleExpanded, onTranscribe, onDownload, onCopy, onDelete }) {
  const ids = post.videos.map(video => String(video.external_id))
  const checked = ids.length > 0 && ids.every(id => selected.has(id))
  const partial = !checked && ids.some(id => selected.has(id))
  const accessState = post.meta.access_state || (post.meta.has_access ? 'accessible' : 'locked')
  const multi = post.video_count > 1 || post.videos.length > 1
  const one = post.videos.length === 1 ? post.videos[0] : null
  return (
    <div className={accessState === 'lost' ? 'bg-red-950/10' : ''}>
      <div className="px-4 py-3 flex items-center gap-3 group">
        <button type="button" onClick={onTogglePost} disabled={!ids.length} className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${checked || partial ? 'bg-orange-500 border-orange-500 text-white' : 'border-zinc-700'} disabled:opacity-30`}>
          {(checked || partial) && <Check size={13} />}
        </button>
        {post.thumbnail_path ? <img src={assetSrc(post.thumbnail_path)} alt="" className="w-20 aspect-video object-cover rounded bg-zinc-900 shrink-0" /> : <div className="w-20 aspect-video rounded bg-zinc-900 flex items-center justify-center shrink-0"><Video size={18} className="text-zinc-700" /></div>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500 text-sm tabular-nums shrink-0">{formatDate(post.published_at)}</span>
            <span className="text-zinc-200 truncate">{post.title || 'Пост Boosty'}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-sm">
            {accessState === 'locked' && <span className="text-amber-400">нужен уровень «{post.meta.subscription_level?.name || 'подписки'}»</span>}
            {accessState === 'lost' && <span className="text-red-400">доступ пропал · сохранённые данные остались</span>}
            {accessState === 'accessible' && <span className="text-zinc-600">{post.video_count || post.videos.length} видео</span>}
            {post.duration_seconds > 0 && <><span className="text-zinc-800">·</span><span className="text-zinc-500 tabular-nums">{fmtDuration(post.duration_seconds)}</span></>}
            {post.transcribed_count > 0 && <><span className="text-zinc-800">·</span><span className="text-emerald-400">{post.transcribed_count === post.known_videos_count ? 'расшифровано' : `${post.transcribed_count} расшифровано`}</span></>}
            {post.media_bytes > 0 && <><span className="text-zinc-800">·</span><span className="text-zinc-400 tabular-nums">{fmtSize(post.media_bytes)}</span></>}
            {!post.media_bytes && one?.download_status === 'evicted' && <><span className="text-zinc-800">·</span><span className="text-zinc-600">аудио удалено</span></>}
          </div>
        </div>
        {accessState === 'accessible' && one && !one.transcript_present && <button type="button" onClick={() => onTranscribe([one.external_id])} title="Расшифровать" className="p-2 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800"><RotateCw size={15} /></button>}
        {one?.transcript_present && <button type="button" onClick={() => onCopy([one.external_id])} title="Скопировать расшифровку" className="p-2 rounded text-emerald-500 hover:text-emerald-300 hover:bg-zinc-800"><Copy size={15} /></button>}
        {one?.srt_present && <button type="button" onClick={() => window.api?.openExternal?.(one.srt_path)} title="Открыть субтитры SRT" className="p-2 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800"><Captions size={15} /></button>}
        {accessState === 'accessible' && one && !one.media_present && <button type="button" onClick={() => onDownload([one.external_id])} title="Скачать аудио" className="p-2 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800"><Download size={15} /></button>}
        {one?.media_present && <button type="button" onClick={() => onDelete([one.external_id], `для «${post.title}»`, one.media_bytes)} title={`Удалить локальное аудио (${fmtSize(one.media_bytes)})`} className="p-2 rounded text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-950/30"><Trash2 size={15} /></button>}
        {multi && <button type="button" onClick={onToggleExpanded} className="p-2 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800" title={expanded ? 'Свернуть видео' : 'Показать видео'}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>}
        <button type="button" onClick={() => window.api?.openUrl?.(post.url)} title="Открыть оригинал" className="p-2 rounded text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800"><ExternalLink size={15} /></button>
      </div>
      {expanded && post.videos.length > 0 && (
        <div className="ml-32 mr-4 mb-3 rounded-md border border-zinc-800 divide-y divide-zinc-900 bg-zinc-900/30">
          {post.videos.map((video, index) => (
            <div key={video.external_id} className="px-3 py-2.5 flex items-center gap-3 group/video text-sm">
              <button type="button" onClick={() => onToggleVideo(video.external_id)} className={`w-4 h-4 rounded border flex items-center justify-center ${selected.has(String(video.external_id)) ? 'bg-orange-500 border-orange-500 text-white' : 'border-zinc-700'}`}>{selected.has(String(video.external_id)) && <Check size={11} />}</button>
              <span className="w-5 text-zinc-600 tabular-nums">{index + 1}</span>
              <span className="flex-1 min-w-0 truncate text-zinc-300">{video.title || `Видео ${index + 1}`}</span>
              <span className="text-zinc-600 tabular-nums">{fmtDuration(video.duration_seconds)}</span>
              {video.transcript_present && <span className="text-emerald-400">готово</span>}
              {video.media_present ? <span className="text-zinc-400 tabular-nums">{fmtSize(video.media_bytes)}</span> : video.download_status === 'evicted' ? <span className="text-zinc-600">аудио удалено</span> : null}
              {video.transcript_present ? <button type="button" onClick={() => onCopy([video.external_id])} className="p-1 text-emerald-500 hover:text-emerald-300"><Copy size={14} /></button> : accessState === 'accessible' ? <button type="button" onClick={() => onTranscribe([video.external_id])} className="p-1 text-zinc-500 hover:text-zinc-200"><RotateCw size={14} /></button> : null}
              {video.srt_present && <button type="button" onClick={() => window.api?.openExternal?.(video.srt_path)} title="Открыть субтитры SRT" className="p-1 text-zinc-500 hover:text-zinc-200"><Captions size={14} /></button>}
              {!video.media_present && accessState === 'accessible' && <button type="button" onClick={() => onDownload([video.external_id])} className="p-1 text-zinc-500 hover:text-zinc-200"><Download size={14} /></button>}
              {video.media_present && <button type="button" onClick={() => onDelete([video.external_id], `для «${video.title || post.title}»`, video.media_bytes)} className="p-1 text-zinc-600 opacity-0 group-hover/video:opacity-100 hover:text-red-400"><Trash2 size={14} /></button>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ActiveBatch({ job }) {
  const batch = job.boosty_batch || {}
  const current = batch.current
  const percent = current?.stage === 'downloading' ? current.percent : null
  return (
    <div className="mt-3 rounded-md border border-orange-900/50 bg-orange-950/10 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="w-4 h-4 rounded-full border-2 border-orange-900 border-t-orange-300 animate-spin" />
        <div className="flex-1 min-w-0"><div className="text-zinc-200">{batch.mode === 'download' ? 'Скачиваю аудио' : 'Скачиваю и расшифровываю'} · {job.items_done || 0} / {job.items_total || 0}</div><div className="text-zinc-500 text-sm truncate mt-0.5">{current?.title || 'Готовлю следующее видео'}{current?.stage ? ` · ${stageLabel(current.stage)}` : ''}</div></div>
        <button type="button" onClick={() => window.api?.cancelJob?.(job.id)} className="h-8 px-2.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-1.5"><Square size={13} /> Стоп</button>
      </div>
      {current?.stage === 'downloading' && <div className="mt-3 h-1.5 rounded-full bg-zinc-900 overflow-hidden"><div className={`h-full bg-orange-500 ${percent == null ? 'w-1/3 animate-pulse' : ''}`} style={percent == null ? undefined : { width: `${percent}%` }} /></div>}
    </div>
  )
}

function CoverageLine({ complete, posts, minDate, maxDate, syncedAt }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 px-4 py-3 flex items-center gap-2 text-sm">
      <span className="text-zinc-500">Охват:</span>
      <span className="text-zinc-200 tabular-nums">{Number(posts || 0).toLocaleString('ru-RU')} постов</span>
      {minDate && maxDate && <><span className="text-zinc-700">·</span><span className="text-zinc-400">с {formatDate(minDate)} по {formatDate(maxDate)}</span></>}
      <span className="text-zinc-700">·</span>
      <span className={complete ? 'text-emerald-400' : 'text-amber-400'}>{complete ? 'вся лента' : 'лента может быть неполной'}</span>
      {syncedAt && <span className="ml-auto text-zinc-600">проверено {new Date(syncedAt * 1000).toLocaleString('ru-RU')}</span>}
    </div>
  )
}

function Stat({ label, value }) {
  return <div className="rounded-md border border-zinc-800 bg-zinc-950 px-4 py-3"><div className="text-zinc-500 text-sm">{label}</div><div className="text-zinc-100 text-xl font-medium tabular-nums mt-1">{value}</div></div>
}

function StorageChip({ label, bytes = 0 }) {
  return <span className="text-zinc-400">{label} <span className="text-zinc-200 tabular-nums">{fmtSize(bytes)}</span></span>
}

function assetSrc(value) {
  if (!value) return ''
  if (/^https?:\/\//i.test(value) || value.startsWith('sc-asset://')) return value
  return `sc-asset://${String(value).replace(/^\/+/, '')}`
}

function parseMeta(value) {
  try { return JSON.parse(value || '{}') } catch { return {} }
}

function cleanError(value) {
  return String(value?.message || value || 'Ошибка Boosty')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
}

function formatDate(value) {
  if (!value) return '—'
  return new Date(Number(value) * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0)))
  if (!seconds) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

function fmtSize(value) {
  const n = Number(value || 0)
  if (!n) return '0 Б'
  if (n < 1024) return `${n} Б`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} КБ`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`
}

function stageLabel(stage) {
  if (stage === 'downloading') return 'скачиваю'
  if (stage === 'extracting') return 'собираю MP3'
  if (stage === 'transcribing') return 'AssemblyAI'
  return 'читаю пост'
}
