import React, { useEffect, useRef, useState } from 'react'
import { RotateCw, Trash2, X } from 'lucide-react'
import { useAistudioJobs, clearAistudioJob, refreshAistudioJobs } from '../lib/aistudioJobs'
import { pushScreen } from '../lib/store'

// Видимая страница истории — сентинел внизу догружает по мере скролла,
// вместо жёсткого slice(0, 30), который прятал хвост истории насовсем.
const HISTORY_PAGE = 15

// Sidepanel справа — история всех MCP jobs (active + completed).
// Аналог ActivityPanel, но привязан к bridge mirror'у (не SQLite jobs).
// Открывается из стикера "История" внутри кнопки "Запущенные MCP".
export default function McpHistoryPanel({ onClose }) {
  const jobs = useAistudioJobs()
  const active = jobs.filter(j => j.status === 'running' || j.status === 'pending')
  const history = jobs.filter(j => j.status !== 'running' && j.status !== 'pending')
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
        <div className="text-sm font-medium text-zinc-300">История research</div>
        <div className="flex items-center gap-2">
          {active.length > 0 && (
            <span className="text-xs text-emerald-400">{active.length} активн.</span>
          )}
          <button
            onClick={() => refreshAistudioJobs()}
            className="text-zinc-500 hover:text-zinc-200"
            title="Обновить"
          ><RotateCw size={14} /></button>
          <button
            onClick={() => clearAistudioJob({ terminal: true })}
            className="text-zinc-500 hover:text-zinc-200"
            title="Очистить завершённые"
          ><Trash2 size={14} /></button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-3 pb-3 space-y-2">
        {active.length === 0 && recent.length === 0 && (
          <div className="text-zinc-600 text-sm italic px-1 py-2">
            Нет research-запросов. Запустите AI Studio (aistudio_run) или Claude/Perplexity (external research).
          </div>
        )}

        {active.length > 0 && (
          <div className="text-xs text-zinc-600 mb-1 px-1">Активные</div>
        )}
        {active.map(j => <Row key={j.jobId} job={j} active onClose={onClose} />)}

        {recent.length > 0 && (
          <div className="text-xs text-zinc-600 mt-4 mb-1 px-1">Завершённые</div>
        )}
        {recent.map(j => <Row key={j.jobId} job={j} onClose={onClose} />)}
        {shown < history.length && (
          <div ref={sentinelRef} className="px-1 py-2 text-center text-xs text-zinc-600">
            Прокрутите вниз — ещё {history.length - shown}
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ job, active, onClose }) {
  const cls = active
    ? 'border-zinc-700 hover:border-emerald-600'
    : 'border-zinc-800 hover:border-zinc-600'
  const inputImages = Array.isArray(job.inputImages) ? job.inputImages : []
  const outputImages = Array.isArray(job.images) ? job.images : []
  const thumbnails = [...outputImages, ...inputImages].filter(img => img?.assetUrl).slice(0, 3)
  return (
    <div
      // Клик → страница джобы + закрыть sidepanel (как Activity-панель).
      onClick={() => { pushScreen('aistudio-job', { jobId: job.jobId }); onClose?.() }}
      className={`rounded-md bg-zinc-900 border ${cls} px-3 py-2 cursor-pointer transition-colors`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Dot status={job.status} />
        <span className="text-zinc-300 truncate flex-1 min-w-0">{rowTitle(job)}</span>
        <span className="text-zinc-600 shrink-0 whitespace-nowrap" style={{ fontSize: '12px' }}>{ago(job.updatedAt)}</span>
        <button
          onClick={e => {
            e.stopPropagation()
            clearAistudioJob({ id: job.jobId })
          }}
          className="text-zinc-600 hover:text-red-400 inline-flex items-center"
          title="Снять с трекинга"
        ><X size={14} /></button>
      </div>
      {job.stage && (
        <div className="text-zinc-500 mt-1" style={{ fontSize: '12px' }}>
          {humanStage(job.stage)}
          {job.elapsedSec ? ` · ${formatElapsed(job.elapsedSec)}` : ''}
          {job.responseTextLen ? ` · ${job.responseTextLen} симв.` : ''}
          {inputImages.length ? ` · вход ${inputImages.length} карт.` : ''}
          {outputImages.length ? ` · ответ ${outputImages.length} карт.` : ''}
          {job.linkCount ? ` · ${job.linkCount} ссылок` : ''}
        </div>
      )}
      {thumbnails.length > 0 && (
        <div className="mt-2 flex gap-1 overflow-hidden">
          {thumbnails.map((img, i) => (
            <img
              key={`${img.assetUrl}-${i}`}
              src={img.assetUrl}
              alt=""
              className="h-12 w-16 rounded border border-zinc-800 bg-zinc-950 object-cover"
              draggable={false}
            />
          ))}
        </div>
      )}
      {job.promptHead && (
        <div className="text-zinc-600 mt-1 truncate" style={{ fontSize: '11px' }}>
          {job.promptHead}
        </div>
      )}
      {job.error && (
        <div className="text-red-400 mt-1 truncate" title={job.error} style={{ fontSize: '12px' }}>
          {job.error}
        </div>
      )}
    </div>
  )
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
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${pulse ? 'animate-pulse' : ''}`}
      style={{ background: color }}
    />
  )
}

// Заголовок строки: research → провайдер (+модель для perplexity), aistudio → модель.
function rowTitle(job) {
  if (job.kind === 'research') {
    if (job.provider === 'perplexity') {
      const m = job.modelId && job.modelId !== 'default' ? ` · ${job.modelId}` : ''
      return `Perplexity${m}`
    }
    if (job.provider === 'claude') {
      // modelId: «Research» (авто) | «opus-4.8 · max · Research». Дефолт-«Research»
      // тоже пишем как provider · model; новые Claude-модели остаются в той же форме.
      return job.modelId && job.modelId !== 'Research' ? `Claude · ${job.modelId}` : 'Claude · Research'
    }
    if (job.provider === 'chatgpt') {
      const m = job.modelId && job.modelId !== '5.5 · xhigh' ? ` · ${job.modelId}` : ''
      return `ChatGPT${m}`
    }
    return 'Deep Research'
  }
  return shortModel(job.modelId)
}

function shortModel(id) {
  if (!id) return 'AI Studio'
  if (id.startsWith('deep-research-max')) return 'Deep Research Max'
  if (id.startsWith('deep-research')) return 'Deep Research'
  if (id === 'gemini-3.5-flash') return 'Gemini 3.5 Flash'
  if (id === 'gemini-3.1-pro-preview') return 'Gemini 3.1 Pro'
  if (id === 'gemini-3-flash-preview') return 'Gemini 3 Flash'
  if (id === 'gemini-3.1-flash-lite') return 'Gemini 3.1 Flash Lite'
  if (id.startsWith('antigravity')) return 'Antigravity Agent'
  return id
}

function humanStage(stage) {
  return ({
    boot:                'старт',
    started:             'инициализация',
    observer_started:    'наблюдение',
    model_switch:        'выбор модели',
    paste_start:         'вставка промпта',
    paste_done:          'промпт вставлен',
    run_found:           'кнопка Run найдена',
    running_model:       'модель отвечает',
    waiting_response:    'ждём ответ',
    completion_detected: 'парсинг ответа',
    parsing:             'парсинг ответа',
    parsed_from_cache:   'ответ из кэша',
    done:                'готово',
    parse_failed:        'парсинг не удался',
    failed:              'ошибка',
    timeout:             'таймаут',
    tab_closed:          'вкладка закрыта',
    run_click_failed:    'Run не сработал',
  })[stage] || stage
}

function formatElapsed(secs) {
  if (!Number.isFinite(secs) || secs < 0) return ''
  if (secs < 60) return `${secs}с`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  if (m < 60) return `${m}м ${s}с`
  return `${m}м`
}

function ago(ts) {
  if (!ts) return ''
  const dt = Math.floor((Date.now() - ts) / 1000)
  if (dt < 5) return 'только что'
  if (dt < 60) return `${dt}с назад`
  if (dt < 3600) return `${Math.round(dt/60)}м назад`
  if (dt < 86400) return `${Math.round(dt/3600)}ч назад`
  return `${Math.round(dt/86400)}д назад`
}
