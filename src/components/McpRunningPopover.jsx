import React, { useEffect, useRef } from 'react'
import { ExternalLink, Square, Pin, PinOff, ChevronRight } from 'lucide-react'
import { useAistudioJobs, clearAistudioJob, setAistudioJobKeepTab, refreshAistudioJobs } from '../lib/aistudioJobs'
import { pushScreen } from '../lib/store'
import McpJobTimer from './McpJobTimer'

// Popover открывается по клику на основную часть кнопки "Запущенные MCP".
// Показывает ТЕКУЩИЕ active jobs (running/pending) с действиями:
//   - Открыть вкладку браузера (focusTab по tabId)
//   - Остановить job (kill tab → CS shutdown)
//   - Открыть страницу деталей
export default function McpRunningPopover({ open, onClose, anchorRef, onOpenHistory }) {
  const jobs = useAistudioJobs()
  // active = всё что реально крутится: aistudio (running/pending) + research
  // (queued/running). Источник — unified /external-jobs (claude+perplexity+aistudio).
  const active = jobs.filter(j => j.status === 'running' || j.status === 'pending' || j.status === 'queued')
  // Последний завершённый (для footer-Select'а «последний MCP»). Сортировка
  // в /external-jobs: активные первыми, потом по updatedAt desc — значит первый
  // НЕ активный = самый свежий завершённый.
  const lastDone = jobs.find(j => j.status !== 'running' && j.status !== 'pending' && j.status !== 'queued')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e) {
      const t = e.target
      if (ref.current && ref.current.contains(t)) return
      if (anchorRef?.current && anchorRef.current.contains(t)) return
      onClose()
    }
    // Через setTimeout(0) чтобы тот же mousedown который открыл popover
    // не закрыл его на следующем event-cycle (см. fix-popover-outside-click.md).
    const id = setTimeout(() => {
      document.addEventListener('mousedown', onDocMouseDown)
    }, 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', onDocMouseDown)
    }
  }, [open, onClose, anchorRef])

  if (!open) return null

  return (
    // Без header/крестика — оверлей закрывается кликом снаружи (onDocMouseDown).
    // `no-drag` обязателен: popover живёт внутри .titlebar, где всё по
    // умолчанию -webkit-app-region: drag. Кнопки спасает правило
    // `.titlebar button { no-drag }`, а вот клик по div-карточке без
    // no-drag ТАСКАЕТ ОКНО вместо onClick — «блок не кликабелен».
    <div
      ref={ref}
      className="no-drag absolute top-10 right-2 w-[380px] max-h-[60vh] overflow-auto z-50 bg-zinc-950 border border-zinc-700 rounded-lg shadow-2xl py-2"
    >
      {active.length === 0 ? (
        <div className="px-4 py-5 text-zinc-500 text-sm text-center">
          Нет активных research.
        </div>
      ) : (
        <div className="px-2 space-y-2">
          {active.map(j => <RunningRow key={j.jobId} job={j} onClose={onClose} />)}
        </div>
      )}

      {/* Последний завершённый — одна строка, клик открывает Историю MCP. */}
      {lastDone && (
        <button
          onClick={() => { onOpenHistory?.(); onClose() }}
          className={`w-full px-4 py-2 flex items-center gap-2 text-left hover:bg-zinc-900/60 transition-colors group ${active.length ? 'border-t border-zinc-800 mt-2' : ''}`}
          title="Открыть Историю MCP"
        >
          <span className="text-zinc-500 text-sm shrink-0">последний:</span>
          <span className="flex-1 min-w-0 text-zinc-300 text-sm truncate">
            {lastDoneTitle(lastDone)}
            {lastDone.status === 'error' && <span className="text-red-400"> · ошибка</span>}
          </span>
          <span className="text-zinc-600 text-xs tabular-nums shrink-0">
            {lastDone.updatedAt ? new Date(lastDone.updatedAt).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : ''}
          </span>
          <ChevronRight size={15} className="text-zinc-600 group-hover:text-zinc-300 shrink-0" />
        </button>
      )}
    </div>
  )
}

// Короткий заголовок: Perplexity · model / Claude (· модель) / Gemini-модель.
function lastDoneTitle(job) {
  if (job.kind === 'research') {
    if (job.provider === 'perplexity') {
      const m = job.modelId && job.modelId !== 'default' ? ` · ${job.modelId}` : ''
      return `Perplexity${m}`
    }
    if (job.provider === 'claude') {
      // Provider · model is explicit even for default Research; Claude can add more models.
      const m = job.modelId && job.modelId !== 'Research' ? job.modelId : 'Research'
      return `Claude · ${m}`
    }
    if (job.provider === 'chatgpt') {
      // modelId = «5.5 · xhigh» (модель + уровень); дефолт не показываем.
      const m = job.modelId && job.modelId !== '5.5 · xhigh' ? ` · ${job.modelId}` : ''
      return `ChatGPT${m}`
    }
    return 'Deep Research'
  }
  return modelTitle(job.modelId)
}

function RunningRow({ job, onClose }) {
  const isResearch = job.kind === 'research'
  // Все bridge-вызовы — через IPC (window.api.*). Прямой fetch на
  // 127.0.0.1:53127 отсюда РЕЗАЛСЯ CORS'ом («Failed to fetch» до сети) —
  // юзер видел «кнопка Стоп тупо не работает». См. fact-research-ui.md.
  async function focusTab() {
    if (job.tabId == null) return
    try { await window.api.bridgeTabCommand({ path: 'focus-tab', tabId: job.tabId }) } catch {}
  }
  async function stopJob() {
    if (isResearch) {
      // Детерминированный стоп: bridge переводит job в error СРАЗУ (даже у
      // зомби без tabId — кейс «CS не стартовал, вкладка закрыта руками»),
      // потом сам закрывает вкладку.
      try { await window.api.researchStop({ id: job.jobId }) } catch {}
      refreshAistudioJobs()
      return
    }
    if (job.tabId != null) {
      try { await window.api.bridgeTabCommand({ path: 'close-tab', tabId: job.tabId }) } catch {}
    }
    clearAistudioJob({ id: job.jobId })
  }
  function openDetails() {
    // Страница джобы (AistudioJobScreen) умеет и research, и aistudio (см. #124).
    // Открываем для всех — единый «постмортем одной операции».
    pushScreen('aistudio-job', { jobId: job.jobId })
    onClose()
  }

  const heading = rowHeading(job)
  // stopPropagation-обёртка для кнопок внутри кликабельной карточки.
  const stop = (fn) => (e) => { e.stopPropagation(); fn() }
  return (
    // Вся карточка кликабельна → детали. Кнопки внутри — stopPropagation.
    <div
      onClick={openDetails}
      className="rounded-md bg-zinc-900 border border-zinc-800 p-2.5 cursor-pointer hover:border-zinc-600 transition-colors"
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0 animate-pulse"
          style={{ background: (job.status === 'pending' || job.status === 'queued') ? '#a1a1aa' : '#10b981' }}
        />
        <span className="text-zinc-200 text-sm font-medium truncate flex-1">
          {heading}
        </span>
        {job.stage && <span className="text-zinc-500 text-xs truncate max-w-[35%]">{humanStage(job.stage)}</span>}
        <McpJobTimer job={job} className="text-zinc-500 text-xs tabular-nums shrink-0" />
      </div>
      {job.promptHead && (
        <div className="text-zinc-600 text-xs mb-2 truncate" title={job.promptHead}>
          {job.promptHead}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <button
          onClick={stop(focusTab)}
          disabled={job.tabId == null}
          className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 disabled:opacity-30 flex items-center gap-1"
          title="Показать эту вкладку в браузере"
        >
          <ExternalLink size={12} /> Браузер
        </button>
        {!isResearch && (
          <button
            onClick={stop(() => setAistudioJobKeepTab(job.jobId, !job.keepTab))}
            disabled={job.tabId == null}
            className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
              job.keepTab
                ? 'bg-amber-900/40 text-amber-300 hover:bg-amber-900/60'
                : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
            } disabled:opacity-30`}
            title={job.keepTab
              ? 'Вкладка останется открытой после завершения. Клик: разрешить авто-закрытие.'
              : 'После завершения вкладка закроется автоматически. Клик: оставить открытой.'}
          >
            {job.keepTab ? <Pin size={12} /> : <PinOff size={12} />}
            {job.keepTab ? 'Оставлять' : 'Авто-закрытие'}
          </button>
        )}
        <button
          onClick={stop(stopJob)}
          className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-red-950 text-zinc-300 hover:text-red-300 ml-auto flex items-center gap-1"
          title="Остановить и закрыть вкладку браузера"
        >
          <Square size={12} /> Стоп
        </button>
      </div>
    </div>
  )
}

// Заголовок строки: research → провайдер (+модель для perplexity-search),
// aistudio → модель. Бейдж research/studio убран — провайдер и так в заголовке.
function rowHeading(job) {
  if (job.kind === 'research') {
    if (job.provider === 'perplexity') {
      const m = job.modelId && job.modelId !== 'default' ? ` · ${job.modelId}` : ''
      return `Perplexity${m}`
    }
    if (job.provider === 'claude') {
      // Provider · model is explicit even for default Research; Claude can add more models.
      const m = job.modelId && job.modelId !== 'Research' ? job.modelId : 'Research'
      return `Claude · ${m}`
    }
    if (job.provider === 'chatgpt') {
      const m = job.modelId && job.modelId !== '5.5 · xhigh' ? ` · ${job.modelId}` : ''
      return `ChatGPT${m}`
    }
    return 'Deep Research'
  }
  return modelTitle(job.modelId)
}

function modelTitle(id) {
  if (!id) return 'AI Studio'
  if (id.startsWith('deep-research-max')) return 'Deep Research Max'
  if (id.startsWith('deep-research')) return 'Deep Research'
  if (id === 'gemini-3.5-flash') return 'Gemini 3.5 Flash'
  if (id === 'gemini-3.1-pro-preview') return 'Gemini 3.1 Pro'
  if (id === 'gemini-3-flash-preview') return 'Gemini 3 Flash'
  if (id === 'gemini-3.1-flash-lite') return 'Gemini 3.1 Flash Lite'
  if (id.startsWith('antigravity')) return 'Antigravity'
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
    // research-стадии (claude/perplexity)
    queued:              'в очереди',
    opening:             'открываем вкладку',
    configuring:         'настройка',
    submitting:          'отправка промпта',
    running:             'research идёт',
    extracting:          'извлечение результата',
    recovered:           'восстановлен',
    stopped:             'остановлен',
    confirm_failed:      'connectors-диалог завис',
  })[stage] || (typeof stage === 'string' && stage.startsWith('reloading') ? 'обновление страницы' : stage)
}
