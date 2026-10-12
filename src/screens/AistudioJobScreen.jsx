import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Copy, ExternalLink, FileText, FolderOpen, Image as ImageIcon, X } from 'lucide-react'
import { useAistudioJobs, clearAistudioJob, refreshAistudioJobs } from '../lib/aistudioJobs'
import McpJobTimer, { hasMcpTimer } from '../components/McpJobTimer'

export default function AistudioJobScreen({ payload }) {
  const jobId = payload?.jobId
  const jobs = useAistudioJobs()
  const [detailFallback, setDetailFallback] = useState(null)
  const [detailLoadedFor, setDetailLoadedFor] = useState(null)
  const job = jobs.find(j => j.jobId === jobId) || (detailFallback?.jobId === jobId ? detailFallback : null)
  const acknowledged = useRef(null)
  const [copyToast, setCopyToast] = useState('')

  // Navbar/history receive compact summaries. Pull full answers only when the
  // user opens one detail screen; this preserves the complete postmortem UI
  // without moving ~4.4 MB through a loopback poll every 1.5 seconds.
  useEffect(() => {
    let alive = true
    setDetailFallback(null)
    setDetailLoadedFor(null)
    ;(async () => {
      const result = await refreshAistudioJobs({ full: true })
      if (!alive) return
      if (result?.jobs?.some(job => job.jobId === jobId)) { setDetailLoadedFor(jobId); return }
      const exact = await window.api?.aistudioListJobs?.({ full: true, jobId })
      const selected = exact?.jobs?.find(job => job.jobId === jobId)
      if (alive && selected) { setDetailFallback(selected); setDetailLoadedFor(jobId) }
      else if (alive && payload?.navigationRequestId) {
        await window.api?.researchOpenAck?.({ requestId: payload.navigationRequestId, jobId, success: false,
          error: exact?.error || 'research_job_not_found' })
      }
    })().catch(error => console.error('[ResearchNavigation] detail read failed', error))
    return () => { alive = false }
  }, [jobId])
  useLayoutEffect(() => {
    const requestId = payload?.navigationRequestId
    if (!job || detailLoadedFor !== jobId || !requestId || acknowledged.current === requestId) return
    acknowledged.current = requestId
    window.api?.researchOpenAck?.({ requestId, jobId, success: true })
      .catch(error => console.error('[ResearchNavigation] ACK failed', error))
  }, [job, jobId, detailLoadedFor, payload?.navigationRequestId])

  // Full refresh above hydrates responseText/sources for this screen. Compact
  // push updates merge over that object without dropping its heavy fields.

  async function copyText(text) {
    const payload = text || job?.responseText
    if (!payload) return
    try {
      await navigator.clipboard.writeText(payload)
      setCopyToast('Скопировано')
      setTimeout(() => setCopyToast(''), 1500)
    } catch {
      setCopyToast('Не удалось')
      setTimeout(() => setCopyToast(''), 2000)
    }
  }

  async function copyPath(filePath) {
    if (!filePath) return
    try {
      await navigator.clipboard.writeText(filePath)
      setCopyToast('Путь скопирован')
      setTimeout(() => setCopyToast(''), 1500)
    } catch {
      setCopyToast('Не удалось')
      setTimeout(() => setCopyToast(''), 2000)
    }
  }

  if (!job) {
    return (
      <div className="p-6 text-zinc-500">
        <div>Job <code className="text-zinc-300">{jobId || '?'}</code> не найден в зеркале.</div>
        <div className="mt-2 text-sm">
          Возможно sc-desktop рестартовал и потерял RAM-state, либо bridge не запущен.
          Расширение восстановит запись на следующем log-event этого job'а.
        </div>
        <button
          onClick={() => refreshAistudioJobs()}
          className="mt-4 px-3 py-1.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:border-zinc-600"
        >Обновить</button>
      </div>
    )
  }

  const legacyParts = splitLegacyResearchResponse(job.responseText)
  const answerText = displayAnswerText(job, legacyParts)
  const answerHead = job.answerHead || job.responseHead || ''
  const hasAnswer = !!(answerText || answerHead)
  const sources = Array.isArray(job.sources) && job.sources.length > 0
    ? job.sources
    : legacyParts.sources
  const sourcesMeta = mergeSourcesMeta(job.sourcesMeta, legacyParts.sourcesMeta)
  const sourceActivityCount = sourceActivityItems(sourcesMeta, job).length
  const sourcesText = formatSourcesText(sources, sourcesMeta, job)
  const inputImages = normalizeJobImages(job.inputImages)
  const inputFiles = normalizeJobFiles(job.inputFiles)
  const outputImages = normalizeJobImages(job.images)
  const chatTurns = buildChatTurns(jobs, job)

  return (
    <div data-research-job-id={jobId} className="h-full overflow-auto p-6 space-y-4" style={{ scrollbarGutter: 'stable' }}>
      <div className="flex items-center gap-3">
        <Dot status={job.status} />
        <h1 className="text-xl text-zinc-200">{providerTitle(job)}</h1>
        <span className="text-zinc-600 text-sm">{job.jobId}</span>
        <div className="ml-auto flex items-center gap-2">
          {job.url && (
            <button
              onClick={() => openInBrowser(job.url)}
              className="text-sm px-2 py-1 rounded text-zinc-400 hover:text-zinc-100 inline-flex items-center gap-1"
              title="Открыть вкладку в браузере"
            ><ExternalLink size={14} /> В браузере</button>
          )}
          <button
            onClick={async () => { await clearAistudioJob({ id: job.jobId }); setDetailFallback(null) }}
            className="text-sm px-2 py-1 rounded text-zinc-400 hover:text-red-400 inline-flex items-center gap-1"
            title="Снять с трекинга"
          ><X size={14} /> Удалить</button>
        </div>
      </div>

      {/* Компактная мета-строка: статус · режим · модель · время. Без
          2-колоночной grid с пустотой, без «Канал/Tab ID/Response chars/Links»
          (это шум — провайдер уже в заголовке, ответ виден ниже). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Meta label="Статус" value={statusLabel(job)} />
        {job.mode && <Meta label="Режим" value={modeField(job.mode)} />}
        <Meta label="Модель" value={modelField(job)} />
        {(inputImages.length > 0 || outputImages.length > 0) && (
          <Meta
            label="Картинки"
            value={[
              inputImages.length ? `вход ${inputImages.length}` : '',
              outputImages.length ? `ответ ${outputImages.length}` : '',
            ].filter(Boolean).join(' · ')}
          />
        )}
        {inputFiles.length > 0 && <Meta label="Файлы" value={`вход ${inputFiles.length}`} />}
        {hasMcpTimer(job) && (
          <Meta label="Время" value={<McpJobTimer job={job} className="tabular-nums" />} />
        )}
        {copyToast && <span className="text-xs text-emerald-400">{copyToast}</span>}
      </div>

      {job.error && (
        <div className="rounded border border-red-700 bg-red-950 text-red-300 p-3 text-sm">
          <div className="text-zinc-400 text-xs mb-1">Ошибка</div>
          <div className="whitespace-pre-wrap">{job.error}</div>
        </div>
      )}

      {/* Сначала Prompt (что просили), потом Response (что получили). */}
      {(job.fullPrompt || job.promptHead) && (
        <CollapsibleText
          label="Промпт"
          text={job.fullPrompt || (job.promptHead + (job.promptLen > 140 ? '…' : ''))}
          textClassName="text-zinc-300 text-sm whitespace-pre-wrap"
        />
      )}

      {inputImages.length > 0 && (
        <ImageGallery
          label="Входные изображения"
          images={inputImages}
          onCopyPath={copyPath}
        />
      )}

      {inputFiles.length > 0 && (
        <InputFileList files={inputFiles} onCopyPath={copyPath} />
      )}

      {hasAnswer && (
        <CollapsibleText
          label={`Ответ${!answerText && answerHead ? ' (превью)' : ''}`}
          text={answerText || (answerHead + '…')}
          pre
          textClassName="text-zinc-200 whitespace-pre-wrap text-sm"
          actions={
            <>
              {answerText && (
                <button
                  onClick={() => copyText(answerText)}
                  className="text-xs px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:border-zinc-600"
                >Скопировать</button>
              )}
              {copyToast && <span className="text-xs text-emerald-400">{copyToast}</span>}
            </>
          }
        />
      )}

      {outputImages.length > 0 && (
        <ImageGallery
          label="Картинки ответа"
          images={outputImages}
          onCopyPath={copyPath}
        />
      )}

      {sourcesText && (
        <CollapsibleText
          label={sourceActivityCount
            ? `Источники (${sources.length.toLocaleString('ru-RU')} · ${sourceActivityCount.toLocaleString('ru-RU')} шагов)`
            : `Источники (${sources.length.toLocaleString('ru-RU')})`}
          text={sourcesText}
          pre
          textClassName="text-zinc-200 whitespace-pre-wrap text-sm"
        />
      )}

      {chatTurns.length > 1 && (
        <ChatHistoryBlock
          turns={chatTurns}
          currentJobId={job.jobId}
          onCopyPath={copyPath}
        />
      )}
    </div>
  )
}

// Сворачиваемый текстовый блок (Промпт / Ответ). Тексты длиннее порога по
// умолчанию свёрнуты до превью; toggle в заголовочной строке. `actions` —
// дополнительные кнопки справа (например «Скопировать» — копирует полный
// текст независимо от свёрнутости, ему передаётся исходный job.responseText).
const COLLAPSE_THRESHOLD = 600

function CollapsibleText({ label, text, pre = false, textClassName = '', actions = null }) {
  const [expanded, setExpanded] = useState(false)
  const full = text || ''
  const isLong = full.length > COLLAPSE_THRESHOLD
  const shown = isLong && !expanded ? full.slice(0, COLLAPSE_THRESHOLD) + '…' : full
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-zinc-500 text-xs">
          {label} <span className="text-zinc-600">· {full.length.toLocaleString('ru-RU')} симв.</span>
        </div>
        {isLong && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1"
            style={{ fontSize: '13px' }}
          >
            {expanded
              ? <><ChevronUp size={14} /> Свернуть</>
              : <><ChevronDown size={14} /> Раскрыть</>}
          </button>
        )}
        <span className="ml-auto" />
        {actions}
      </div>
      {pre ? (
        <pre className={textClassName} style={{ fontFamily: 'inherit' }}>{shown}</pre>
      ) : (
        <div className={textClassName}>{shown}</div>
      )}
    </div>
  )
}

// Inline-мета «label: value» одной строкой (без grid-колонок и пустот).
function Meta({ label, value }) {
  if (value == null || value === '' || value === '—') return null
  return (
    <span className="text-zinc-400">
      {label && <><span className="text-zinc-600">{label}:</span>{' '}</>}
      <span className="text-zinc-300">{value}</span>
    </span>
  )
}

function ImageGallery({ label, images, onCopyPath }) {
  if (!Array.isArray(images) || images.length === 0) return null
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-center gap-2 mb-3">
        <ImageIcon size={14} className="text-zinc-500" />
        <div className="text-zinc-500 text-xs">
          {label} <span className="text-zinc-600">· {images.length}</span>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {images.map((img, i) => (
          <ImageTile key={`${img.filePath || img.assetUrl || img.name}-${i}`} image={img} onCopyPath={onCopyPath} />
        ))}
      </div>
    </div>
  )
}

function ImageTile({ image, onCopyPath }) {
  const src = image.assetUrl || ''
  return (
    <figure className="min-w-0 rounded border border-zinc-800 bg-zinc-900 overflow-hidden">
      <div className="aspect-[4/3] bg-zinc-950 flex items-center justify-center overflow-hidden">
        {src ? (
          <img
            src={src}
            alt=""
            className="w-full h-full object-contain"
            draggable={false}
          />
        ) : (
          <ImageIcon size={28} className="text-zinc-700" />
        )}
      </div>
      <figcaption className="px-2 py-2 min-w-0">
        <div className="text-xs text-zinc-400 truncate" title={image.name || image.filePath || ''}>
          {image.name || 'image'}
        </div>
        <div className="mt-1 flex items-center gap-1">
          <span className="text-[11px] text-zinc-600 truncate flex-1 min-w-0">
            {formatBytes(image.bytes)}
          </span>
          {image.filePath && (
            <>
              <button
                type="button"
                onClick={() => onCopyPath?.(image.filePath)}
                className="inline-flex items-center justify-center w-7 h-7 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"
                title="Скопировать путь"
              >
                <Copy size={14} />
              </button>
              <button
                type="button"
                onClick={() => window.api?.revealInFinder?.(image.filePath)}
                className="inline-flex items-center justify-center w-7 h-7 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"
                title="Показать в Finder"
              >
                <FolderOpen size={14} />
              </button>
            </>
          )}
        </div>
      </figcaption>
    </figure>
  )
}

function ChatHistoryBlock({ turns, currentJobId, onCopyPath }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="text-zinc-500 text-xs mb-3">
        История чата <span className="text-zinc-600">· {turns.length} {pluralRu(turns.length, 'запрос', 'запроса', 'запросов')}</span>
      </div>
      <div className="space-y-3">
        {turns.map((turn, idx) => {
          const legacyParts = splitLegacyResearchResponse(turn.responseText)
          const answerText = displayAnswerText(turn, legacyParts)
          const inputImages = normalizeJobImages(turn.inputImages)
          const inputFiles = normalizeJobFiles(turn.inputFiles)
          const outputImages = normalizeJobImages(turn.images)
          return (
            <div
              key={turn.jobId || idx}
              className={`rounded border px-3 py-2 ${turn.jobId === currentJobId ? 'border-emerald-900/70 bg-emerald-950/10' : 'border-zinc-900 bg-zinc-950'}`}
            >
              <div className="flex items-center gap-2 text-xs mb-2">
                <span className="text-zinc-500">#{idx + 1}</span>
                <span className="text-zinc-600">{formatDate(turn.createdAt)}</span>
                {turn.jobId === currentJobId && <span className="text-emerald-500">текущий</span>}
                <span className="ml-auto text-zinc-700 truncate">{turn.jobId}</span>
              </div>
              {(turn.fullPrompt || turn.promptHead) && (
                <div className="mb-2">
                  <div className="text-[11px] text-zinc-600 mb-1">Промпт</div>
                  <pre className="text-xs text-zinc-300 whitespace-pre-wrap" style={{ fontFamily: 'inherit' }}>
                    {turn.fullPrompt || turn.promptHead}
                  </pre>
                </div>
              )}
              {inputImages.length > 0 && <InlineImageStrip label="Вход" images={inputImages} onCopyPath={onCopyPath} />}
              {inputFiles.length > 0 && <InputFileList files={inputFiles} onCopyPath={onCopyPath} compact />}
              {answerText && (
                <div className="mt-2">
                  <div className="text-[11px] text-zinc-600 mb-1">Ответ</div>
                  <pre className="text-xs text-zinc-300 whitespace-pre-wrap" style={{ fontFamily: 'inherit' }}>
                    {answerText}
                  </pre>
                </div>
              )}
              {outputImages.length > 0 && <InlineImageStrip label="Картинки ответа" images={outputImages} onCopyPath={onCopyPath} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function InlineImageStrip({ label, images, onCopyPath }) {
  return (
    <div className="mt-2">
      <div className="text-[11px] text-zinc-600 mb-1">{label}</div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {images.map((img, i) => (
          <div key={`${img.filePath || img.assetUrl || img.name}-${i}`} className="w-32 shrink-0">
            <ImageTile image={img} onCopyPath={onCopyPath} />
          </div>
        ))}
      </div>
    </div>
  )
}

function normalizeJobImages(images) {
  const arr = Array.isArray(images) ? images : []
  return arr
    .map((img, i) => {
      const filePath = typeof img?.filePath === 'string' ? img.filePath
        : typeof img?.file_path === 'string' ? img.file_path
          : typeof img?.path === 'string' ? img.path
            : ''
      const assetUrl = typeof img?.assetUrl === 'string' ? img.assetUrl
        : typeof img?.asset_url === 'string' ? img.asset_url
          : ''
      const name = typeof img?.name === 'string' && img.name
        ? img.name
        : (filePath ? filePath.split('/').pop() : `image-${i + 1}`)
      return {
        ...img,
        index: Number.isFinite(img?.index) ? img.index : i,
        name,
        filePath: filePath || null,
        assetUrl,
        bytes: Number.isFinite(img?.bytes) ? img.bytes : (Number.isFinite(img?.size) ? img.size : null),
      }
    })
    .filter((img) => img.assetUrl || img.filePath)
}

function normalizeJobFiles(files) {
  const arr = Array.isArray(files) ? files : []
  return arr
    .map((file, i) => {
      const filePath = typeof file?.filePath === 'string' ? file.filePath
        : typeof file?.file_path === 'string' ? file.file_path
          : typeof file?.path === 'string' ? file.path
            : ''
      return {
        ...file,
        index: Number.isFinite(file?.index) ? file.index : i,
        name: typeof file?.name === 'string' && file.name
          ? file.name
          : (filePath ? filePath.split('/').pop() : `file-${i + 1}`),
        filePath: filePath || null,
        bytes: Number.isFinite(file?.bytes) ? file.bytes : (Number.isFinite(file?.size) ? file.size : null),
        lineStart: Number.isFinite(file?.lineStart) ? file.lineStart : (Number.isFinite(file?.line_start) ? file.line_start : null),
        lineEnd: Number.isFinite(file?.lineEnd) ? file.lineEnd : (Number.isFinite(file?.line_end) ? file.line_end : null),
        bundledCount: Number.isFinite(file?.bundledCount) ? file.bundledCount : (Number.isFinite(file?.bundled_count) ? file.bundled_count : null),
        bundleIndex: Number.isFinite(file?.bundleIndex) ? file.bundleIndex : (Number.isFinite(file?.bundle_index) ? file.bundle_index : null),
        bundleCount: Number.isFinite(file?.bundleCount) ? file.bundleCount : (Number.isFinite(file?.bundle_count) ? file.bundle_count : null),
        sourceTotalCount: Number.isFinite(file?.sourceTotalCount) ? file.sourceTotalCount : (Number.isFinite(file?.source_total_count) ? file.source_total_count : null),
      }
    })
    .filter((file) => file.filePath)
}

function InputFileList({ files, onCopyPath, compact = false }) {
  if (!files.length) return null
  return (
    <div className={compact ? 'mt-2' : 'rounded border border-zinc-800 bg-zinc-950 p-3'}>
      <div className="text-[11px] text-zinc-600 mb-1">
        Входные файлы <span className="text-zinc-700">· {files.length}</span>
      </div>
      <div className="space-y-1">
        {files.map((file, i) => {
          const range = file.lineStart
            ? `строки ${file.lineStart}–${file.lineEnd || 'конец'}`
            : ''
          const bundle = file.bundledCount
            ? [
                file.bundleIndex && file.bundleCount ? `пакет ${file.bundleIndex}/${file.bundleCount}` : 'пакет',
                `${file.bundledCount}${file.sourceTotalCount ? `/${file.sourceTotalCount}` : ''} исходников`,
              ].join(' · ')
            : ''
          return (
            <div key={`${file.filePath}-${i}`} className="flex min-w-0 items-center gap-2 text-xs text-zinc-300">
              <FileText size={14} className="shrink-0 text-zinc-500" />
              <span className="truncate" title={file.filePath}>{file.name}</span>
              {(range || bundle || file.bytes != null) && (
                <span className="shrink-0 text-zinc-600">
                  {[range, bundle, formatBytes(file.bytes)].filter(Boolean).join(' · ')}
                </span>
              )}
              <button
                type="button"
                onClick={() => onCopyPath(file.filePath)}
                className="ml-auto shrink-0 rounded p-1 text-zinc-500 hover:text-zinc-200"
                title="Скопировать локальный путь"
              ><Copy size={13} /></button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function buildChatTurns(jobs, current) {
  const key = conversationKey(current)
  if (!key || !Array.isArray(jobs)) return []
  return jobs
    .filter((j) => j?.kind === 'research' && j.provider === current.provider && conversationKey(j) === key)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

function conversationKey(job) {
  if (!job?.url) return ''
  try {
    const u = new URL(job.url)
    if (job.provider === 'chatgpt' && u.origin === 'https://chatgpt.com') {
      const m = u.pathname.match(/^\/c\/([\w-]+)\/?$/)
      if (m) return `chatgpt:${m[1]}`
    }
    u.hash = ''
    u.searchParams.delete('sc-research')
    return `${job.provider || 'research'}:${u.origin}${u.pathname}${u.search}`
  } catch {
    return ''
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

function pluralRu(n, one, few, many) {
  const value = Math.abs(Number(n) || 0)
  const mod10 = value % 10
  const mod100 = value % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

function displayAnswerText(job, legacyParts = null) {
  if (typeof job?.answerText === 'string' && job.answerText.trim()) return job.answerText
  if (legacyParts?.answerText) return legacyParts.answerText
  if (typeof job?.responseText === 'string' && job.responseText.trim()) {
    return job.provider === 'chatgpt' ? stripEmbeddedSources(job.responseText) : job.responseText
  }
  return ''
}

function stripEmbeddedSources(text) {
  if (!text) return ''
  return String(text).split(/\n{2,}---\n(?:Источники|Sources)\s*\(\d+\):\n/i)[0].trim()
}

function splitLegacyResearchResponse(text) {
  const raw = typeof text === 'string' ? text : ''
  const match = raw.match(/\n{2,}---\n(?:Источники|Sources)\s*\(\d+\):\n/i)
  if (!match || match.index == null) return { answerText: '', sources: [], sourcesMeta: null }

  const answerText = raw.slice(0, match.index).trim()
  const tail = raw.slice(match.index + match[0].length)
  const sources = []
  let activity = null

  for (const line of tail.split(/\n+/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const activityMatch = trimmed.match(/^(?:Активность|Activity):\s*(.{1,60})/i)
    if (activityMatch) {
      activity = cleanActivity(activityMatch[1])
      continue
    }
    const sourceMatch = trimmed.match(/^\d+\.\s+(.+?)\s+[—-]\s+(https?:\/\/\S+)/i)
    if (!sourceMatch) continue
    sources.push({
      title: sourceMatch[1].trim(),
      url: sourceMatch[2].replace(/[),.;]+$/g, ''),
    })
  }

  return {
    answerText,
    sources,
    sourcesMeta: activity ? { activity } : null,
  }
}

function mergeSourcesMeta(primary, fallback) {
  const a = primary && typeof primary === 'object' ? primary : null
  const b = fallback && typeof fallback === 'object' ? fallback : null
  if (!a) return b
  if (!b) return a
  return { ...b, ...a }
}

function formatSourcesText(sources, meta, job) {
  const safeSources = Array.isArray(sources) ? sources : []
  const activityItems = sourceActivityItems(meta, job)
  if (safeSources.length === 0 && activityItems.length === 0 && !meta?.activity) return ''
  const lines = []
  if (safeSources.length) {
    lines.push('Ссылки:')
    safeSources.forEach((source, i) => {
      const title = source?.title || source?.url || ''
      const url = source?.url || ''
      lines.push(`${i + 1}. ${title}${title && url ? ' - ' : ''}${url}`)
    })
  }
  const activity = cleanActivity(meta?.activity)
  if (activity) lines.push(`Активность: ${activity}`)
  if (activityItems.length) {
    if (lines.length) lines.push('')
    lines.push('Шаги активности:')
    activityItems.forEach((item, i) => {
      const title = item.title || item.text || item.command || `Шаг ${i + 1}`
      const detail = activityDetail(item, title)
      lines.push(`${i + 1}. ${title}`)
      if (item.links?.length) {
        item.links.forEach((link) => {
          lines.push(`   source: ${(link.title || link.url)}${link.title && link.url ? ' - ' : ''}${link.url}`)
        })
      }
      if (item.command) lines.push(`   command: ${item.command}`)
      if (detail) lines.push(`   detail: ${detail}`)
    })
  }
  return lines.join('\n')
}

function activityDetail(item, title) {
  let detail = typeof item?.text === 'string' ? item.text.trim() : ''
  if (!detail || detail === title) return ''
  if (title && detail.startsWith(title)) detail = detail.slice(title.length).trim()
  if (item?.command) detail = detail.replace(item.command, '').trim()
  detail = detail.replace(/^(?:Python|JavaScript|TypeScript|Bash|Shell|JSON|Text|Markdown)\s*/i, '').trim()
  return detail && detail !== title ? detail : ''
}

function sourceActivityItems(meta, job) {
  const arr = Array.isArray(meta?.activity_items)
    ? meta.activity_items
    : Array.isArray(meta?.activityItems)
      ? meta.activityItems
      : Array.isArray(job?.sourceActivity)
        ? job.sourceActivity
        : []
  return arr
    .map((item) => ({
      title: typeof item?.title === 'string' ? item.title.trim() : '',
      text: typeof item?.text === 'string' ? item.text.trim() : '',
      command: typeof item?.command === 'string' ? item.command.trim() : '',
      links: Array.isArray(item?.links)
        ? item.links
          .map((link) => ({
            url: typeof link?.url === 'string' ? link.url : '',
            title: typeof link?.title === 'string' ? link.title : '',
          }))
          .filter((link) => link.url)
        : [],
    }))
    .filter((item) => item.title || item.text || item.command || item.links.length)
}

function cleanActivity(value) {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) return ''
  const time = s.match(/^((?:\d+\s*(?:h|hr|hrs|m|min|mins|s|sec|secs|ч|час|часа|часов|м|мин|сек|с)\s*){1,4})/i)
  return (time ? time[1] : s).trim()
}

function statusLabel(job) {
  return ({ done: 'готово', running: 'идёт', pending: 'ожидание', queued: 'в очереди', error: 'ошибка' })[job.status] || job.status
}

function modeField(mode) {
  return ({
    chat: 'Chat',
    work: 'Work',
    search: 'Поиск',
    deep: 'Глубокое исследование',
  })[mode] || mode
}

// Открыть вкладку research/aistudio в браузере. Через IPC (window.api), не
// прямым fetch'ем на bridge — origin renderer'а не в CORS-allowlist'е, fetch
// отсюда умирал «Failed to fetch» до сети (см. fact-research-ui.md).
// У research-джобы tabId не всегда жив (меняется после reload) — надёжнее
// открыть URL: расширение сфокусирует существующую вкладку или откроет новую.
function openInBrowser(url) {
  if (!url) return
  try { window.api.bridgeTabCommand({ path: 'open-url', url }).catch(() => {}) } catch {}
}

// Заголовок: research → провайдер, для Claude сразу provider · model; aistudio → модель.
function providerTitle(job) {
  if (job.kind === 'research') {
    if (job.provider === 'claude') {
      const m = job.modelId && job.modelId !== 'Research' ? job.modelId : 'Research'
      return `Claude · ${m}`
    }
    if (job.provider === 'perplexity') return 'Perplexity'
    if (job.provider === 'chatgpt') return 'ChatGPT'
    return 'Deep Research'
  }
  return modelTitle(job.modelId)
}
// Поле Model: research-perplexity показывает выбранную модель, chatgpt —
// ChatGPT-модель + уровень интеллекта (effort), claude — модель/effort из options
// («opus-4.8 · max · Research») либо «Claude · Research» если авто.
function modelField(job) {
  if (job.kind === 'research') {
    if (job.provider === 'perplexity') return job.modelId === 'default' ? 'Gemini 3.1 Pro' : job.modelId
    if (job.provider === 'chatgpt') {
      const model = job.modelId || 'GPT-5.6 Sol · xhigh'
      return /^(?:GPT(?:-|\s)|o3\b)/i.test(model) ? model : `GPT ${model}`
    }
    if (job.provider === 'claude') return job.modelId && job.modelId !== 'Research' ? job.modelId : 'Claude · Research'
    return 'Claude'
  }
  return job.modelId || '—'
}

function Dot({ status }) {
  const color = ({
    pending: '#a1a1aa',
    running: '#10b981',
    done:    '#71717a',
    error:   '#ef4444',
    tab_closed: '#f59e0b',
  })[status] || '#71717a'
  const pulse = status === 'running' || status === 'pending'
  return (
    <span
      className={`inline-block w-3 h-3 rounded-full shrink-0 ${pulse ? 'animate-pulse' : ''}`}
      style={{ background: color }}
    />
  )
}

function modelTitle(id) {
  if (!id) return 'AI Studio'
  if (id.startsWith('deep-research-max')) return 'Deep Research Max'
  if (id.startsWith('deep-research')) return 'Deep Research'
  if (id === 'gemini-3.5-flash') return 'Gemini 3.5 Flash'
  if (id === 'gemini-3.1-pro-preview') return 'Gemini 3.1 Pro Preview'
  if (id === 'gemini-3-flash-preview') return 'Gemini 3 Flash Preview'
  if (id === 'gemini-3.1-flash-lite') return 'Gemini 3.1 Flash Lite'
  if (id.startsWith('antigravity')) return 'Antigravity Agent'
  return id
}
