import React, { useState, useEffect, useRef } from 'react'
import { Send, Check } from 'lucide-react'
import Select from '../components/Select'
import { pushScreen } from '../lib/store'
import { refreshAistudioJobs } from '../lib/aistudioJobs'

// Старт нового external-research job'а прямо из приложения (без нейронки).
// Provider-табы сверху, под ними — поля, зависящие от провайдера:
//   - Claude:     только prompt (модель/режим не выбираются)
//   - Perplexity: mode (Поиск/Глубокое) + model (из живого /pplx-models)
//   - AI Studio:  model (фиксированный список Gemini/DR)
// Запуск — POST /research-start на bridge (тот же канал что у нейронки).
// После отправки — toast «Отправлено» + очистка prompt; отслеживание идёт
// в попапе «Запущенные MCP» / Истории.

// Bridge-вызовы идут через main-process IPC (window.api.research*), а НЕ прямым
// fetch'ем на 127.0.0.1:53127 — origin renderer'а (localhost:5156 в dev, file://
// в prod) не в CORS-allowlist'е bridge'а, прямой fetch падает «Failed to fetch».

const PROVIDERS = [
  { id: 'perplexity', label: 'Perplexity' },
  { id: 'claude',     label: 'Claude' },
  { id: 'aistudio',   label: 'AI Studio' },
  { id: 'chatgpt',    label: 'ChatGPT' },
]

// ChatGPT — модели (зеркало chatgpt-research.js::MODELS). Default GPT-5.5.
const CHATGPT_MODES = [
  { id: 'chat', label: 'Chat' },
  { id: 'work', label: 'Work' },
]

const CHATGPT_MODELS = [
  { id: '5.5',       label: 'GPT-5.5 Instant', modes: ['chat'] },
  { id: '5.6-sol',   label: 'GPT-5.6 Sol',     modes: ['chat', 'work'] },
  { id: '5.6-terra', label: 'GPT-5.6 Terra',   modes: ['work'] },
  { id: '5.6-luna',  label: 'GPT-5.6 Luna',    modes: ['work'] },
]

// ChatGPT — уровни интеллекта (зеркало chatgpt-research.js::EFFORTS).
// «Очень высокий» = xhigh. В обычном Chat уровни выше Instant используют Sol;
// Work предлагает Low..Ultra отдельно для Sol, Terra и Luna.
const CHATGPT_EFFORTS = [
  { id: 'low',          label: 'Low' },
  { id: 'xhigh',        label: 'Очень высокий',    hint: 'xhigh, default' },
  { id: 'high',         label: 'High' },
  { id: 'medium',       label: 'Medium' },
  { id: 'instant',      label: 'Instant',          hint: 'без thinking' },
  { id: 'pro',          label: 'Pro',               hint: 'самый глубокий' },
  { id: 'max',          label: 'Max' },
  { id: 'ultra',        label: 'Ultra',             hint: 'быстрее расходует квоту' },
]

function chatgptEffortOptions(mode, model) {
  const byId = Object.fromEntries(CHATGPT_EFFORTS.map(x => [x.id, x]))
  if (mode === 'work') {
    return ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => byId[id])
  }
  if (model === '5.5') return [byId.instant]
  return ['medium', 'high', 'xhigh', 'pro'].map(id => byId[id])
}

function defaultChatgptEffort(mode, model) {
  return mode === 'chat' && model === '5.5' ? 'instant' : 'xhigh'
}

// Claude — модели + их effort/thinking вариации (зеркало claude-research.js::
// CLAUDE_MODELS, снято с живого DOM). efforts:null → у модели нет Effort-подменю;
// toggle — подпись тумблера (Thinking / Extended), null → тумблера нет.
// «Авто» = не трогать селектор на странице (модель аккаунта sticky).
const CLAUDE_MODELS_UI = [
  { id: 'auto',       label: 'Авто (как в аккаунте)', efforts: null, toggle: null },
  { id: 'fable-5',    label: 'Fable 5',    efforts: ['low', 'medium', 'high', 'extra', 'max'], toggle: null },
  { id: 'opus-4.8',   label: 'Opus 4.8',   efforts: ['low', 'medium', 'high', 'extra', 'max'], toggle: 'Thinking' },
  { id: 'sonnet-4.6', label: 'Sonnet 4.6', efforts: ['low', 'medium', 'high', 'max'],          toggle: 'Thinking' },
  { id: 'haiku-4.5',  label: 'Haiku 4.5',  efforts: [],                                        toggle: 'Extended' },
  { id: 'opus-4.7',   label: 'Opus 4.7',   efforts: ['low', 'medium', 'high', 'extra', 'max'], toggle: 'Thinking' },
  { id: 'opus-4.6',   label: 'Opus 4.6',   efforts: ['low', 'medium', 'high', 'max'],          toggle: 'Extended' },
  { id: 'opus-3',     label: 'Opus 3',     efforts: [],                                        toggle: null },
]

// AI Studio модели — фиксированный список (зеркало aistudio-core KNOWN_MODELS).
const AISTUDIO_MODELS = [
  { id: 'pro',     label: 'Gemini 3.1 Pro',       hint: 'SOTA reasoning' },
  { id: 'flash',   label: 'Gemini 3.5 Flash',     hint: 'быстрый' },
  { id: 'dr',      label: 'Deep Research',        hint: '5–15 мин, web' },
  { id: 'dr-max',  label: 'Deep Research Max',    hint: '10–15 мин' },
  { id: 'ag',      label: 'Antigravity',          hint: 'agent' },
]

const PPLX_MODES = [
  { id: 'deep',   label: 'Глубокое исследование', hint: '5–25 мин, десятки источников' },
  { id: 'search', label: 'Поиск',                 hint: 'быстрый ответ, free' },
]

export default function NewResearchScreen() {
  const [provider, setProvider] = useState('perplexity')
  const [prompt, setPrompt] = useState('')
  const [pplxMode, setPplxMode] = useState('deep')
  const [pplxModel, setPplxModel] = useState('gemini')
  const [aiModel, setAiModel] = useState('pro')
  const [gptMode, setGptMode] = useState('chat')
  const [gptModel, setGptModel] = useState('5.6-sol')
  const [gptEffort, setGptEffort] = useState('xhigh')
  const [gptSources, setGptSources] = useState(false)
  const [clModel, setClModel] = useState('auto')
  const [clEffort, setClEffort] = useState('max')
  const [clThinking, setClThinking] = useState(true)
  const [clResearch, setClResearch] = useState(true)
  const [pplxModels, setPplxModels] = useState(null)   // живой реестр или null
  const [stage, setStage] = useState('idle')           // idle | sending | sent | error
  const [err, setErr] = useState(null)
  const [lastId, setLastId] = useState(null)
  const taRef = useRef(null)

  // Живой реестр Perplexity-моделей (источник правды — расширение).
  useEffect(() => {
    let alive = true
    window.api.researchPplxModels()
      .then(d => {
        if (!alive || !Array.isArray(d.models) || !d.models.length) return
        setPplxModels(d.models.map(m => ({
          id: m.aliases?.[0] || m.name,
          label: m.name + (m.locked ? '  🔒' : ''),
          hint: m.locked ? 'недоступна (Max)' : undefined,
          _locked: m.locked,
        })))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const pplxModelOptions = pplxModels || [
    { id: 'gemini', label: 'Gemini 3.1 Pro' },
    { id: 'sonar',  label: 'Sonar 2' },
    { id: 'gpt',    label: 'GPT-5.4' },
    { id: 'sonnet', label: 'Claude Sonnet 4.6' },
    { id: 'kimi',   label: 'Kimi K2.6' },
  ]
  // В обычном Chat доступны 5.5 Instant и 5.6 Sol. Work предлагает три
  // независимых tier'а 5.6: Sol, Terra и Luna. Скрытый старый state никогда
  // не отправляем.
  const gptModelOptions = CHATGPT_MODELS.filter(x => x.modes.includes(gptMode))
  const gptModelValue = gptModelOptions.some(x => x.id === gptModel)
    ? gptModel
    : '5.6-sol'
  const gptEffortOptions = chatgptEffortOptions(gptMode, gptModelValue)
  const gptEffortValue = gptEffortOptions.some(x => x.id === gptEffort)
    ? gptEffort
    : defaultChatgptEffort(gptMode, gptModelValue)

  async function submit() {
    if (stage === 'sending' || !prompt.trim()) return
    setStage('sending'); setErr(null)
    const body = { provider, prompt: prompt.trim() }
    if (provider === 'perplexity') {
      // Модель шлём ТОЛЬКО в режиме «Поиск» — как и показывает форма (в
      // «Глубоком» селектор скрыт, Perplexity сам управляет моделью, на
      // странице триггера нет). Слать pplxModel в deep = CS 8с впустую ищет
      // несуществующий триггер (model.trigger_not_found). «Видно одно —
      // шлётся другое»: прячем в UI → не отправляем.
      body.options = pplxMode === 'search'
        ? { mode: pplxMode, model: pplxModel }
        : { mode: pplxMode }
    }
    if (provider === 'aistudio')   body.options = { model: aiModel }
    if (provider === 'chatgpt')    body.options = { mode: gptMode, model: gptModelValue, effort: gptEffortValue, sources: gptSources }
    if (provider === 'claude') {
      // «Авто» — model/effort/thinking не шлём вовсе: CS трактует отсутствие
      // как «не трогать селектор» (модель/уровень аккаунта sticky).
      const m = CLAUDE_MODELS_UI.find(x => x.id === clModel)
      // research = то, что ПОКАЗЫВАЕТ чекбокс. На Opus 3 он нарисован снятым
      // и disabled — но state clResearch при этом остаётся true с прошлой
      // модели, и отправка сырого state давала «opus-3 не поддерживает
      // Research mode» при визуально выключенной галке. Disabled-контрол
      // не отправляет скрытое значение (см. переносимый-дизайн.md).
      body.options = { research: clModel === 'opus-3' ? false : clResearch }
      if (clModel !== 'auto' && m) {
        body.options.model = clModel
        // Effort — это глубина thinking'а: при выключенном тумблере не
        // применяется (Effort select в форме disabled) → не отправляем.
        const effortApplies = m.efforts?.length && (!m.toggle || clThinking)
        // Шлём то, что РЕАЛЬНО показывает Select (склампленное), а не сырой
        // clEffort: при смене модели текущий уровень может стать
        // несуществующим (extra есть у Fable/4.8/4.7, нет у Sonnet/4.6) —
        // Select рисует max, а сырой clEffort='extra' ушёл бы в options и
        // CS не нашёл бы радио. Тот же разрыв «видно одно — шлётся другое»,
        // что был с research-галкой на Opus 3.
        const effortToSend = (m.efforts || []).includes(clEffort)
          ? clEffort
          : (m.efforts?.[m.efforts.length - 1] || clEffort)
        if (effortApplies) body.options.effort = effortToSend
        if (m.toggle) body.options.thinking = clThinking
      }
    }
    try {
      const j = await window.api.researchStart(body)
      // aistudio возвращает ошибку синхронно; claude/perplexity — 200 с id,
      // ошибка (pplx_daily_limit и пр.) прилетает позже через /research-state.
      if (j.error) { setStage('error'); setErr(humanError(j.error)); return }
      setLastId(j.id)
      setStage('sent')
      setPrompt('')                 // очистить input после отправки
      refreshAistudioJobs()          // подтянуть в попап/историю
      taRef.current?.focus()
      setTimeout(() => setStage(s => s === 'sent' ? 'idle' : s), 2500)
      // Реактивно: последить за ранней ошибкой джоба (deep-лимит ловится на
      // configuring, ~5-10с после старта). Не блокируем — фоновый short-poll.
      if (j.id) watchEarlyError(j.id)
    } catch (e) {
      setStage('error'); setErr(String(e?.message || e))
    }
  }

  // Следим за конфигурацией до 35с: ChatGPT делает до двух проверяемых попыток
  // выбора режима/модели/интеллекта, поэтому ошибка может прийти позже 12с.
  // status=running означает и «ещё настраиваем страницу» — это не повод
  // прекращать наблюдение; терминальные состояния только done/error.
  async function watchEarlyError(id) {
    const t0 = Date.now()
    while (Date.now() - t0 < 35000) {
      try {
        const j = await window.api.researchStatus({ id, wait: 4000 })
        if (j.status === 'error') {
          setStage('error'); setErr(humanError(j.error || 'ошибка запуска')); return
        }
        if (j.status === 'done') return
      } catch { return }
    }
  }

  // Технические ошибки bridge → человечный текст + совет.
  function humanError(raw) {
    const s = String(raw || '')
    if (/pplx_daily_limit/.test(s)) return 'Лимит «Глубокого исследования» исчерпан (месячный/дневной). Переключись на режим «Поиск» — он без лимита.'
    if (/pplx_model_locked/.test(s)) return 'Эта модель недоступна на текущем тарифе (Max). Выбери другую.'
    if (/pplx_mode_switch_failed/.test(s)) return 'Не удалось переключить режим Perplexity — UI мог измениться.'
    if (/chatgpt_mode_select_failed/.test(s)) return 'Не удалось переключить ChatGPT между Chat и Work. Запрос не отправлен.'
    if (/chatgpt_effort_select_failed/.test(s)) return 'Не удалось выбрать запрошенный уровень интеллекта ChatGPT. Запрос не отправлен с другим уровнем.'
    // Модель не выбралась — общий контракт fatal-if-explicit (claude/chatgpt/pplx).
    if (/_model_select_failed/.test(s)) return 'Не удалось выбрать запрошенную модель на странице (UI мог измениться). Повтори или открой вкладку и проверь.'
    if (/claude_model_select_failed|chatgpt_model_select_failed|pplx_model_select_failed/.test(s)) return 'Модель не переключилась — повтори запуск.'
    if (/Extension not connected/.test(s)) return 'Расширение не подключено. Открой вкладку браузера или переоткрой SC Desktop.'
    return s.slice(0, 160)
  }

  function onKeyDown(e) {
    // Enter — запуск. Shift+Enter — перенос строки (многострочный промпт).
    // Cmd/Ctrl+Enter тоже запускает (сохранили старое поведение).
    // Распознаём Enter тремя способами: e.key (обычно "Enter"), e.code
    // ("Enter"/"NumpadEnter") и keyCode 13. На Mac при не-латинской раскладке
    // e.key иногда приходит не "Enter", а e.code/keyCode стабильны независимо
    // от раскладки — поэтому Enter срабатывает хоть на русской, хоть на любой.
    const isEnter = e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.keyCode === 13
    if (!isEnter) return
    if (e.shiftKey) return        // Shift+Enter — перенос строки, не запуск
    e.preventDefault()
    submit()
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-xl mx-auto p-6">
        <h1 className="text-xl text-zinc-200 mb-1">Новый research</h1>
        <p className="text-zinc-500 text-sm mb-5">
          Запуск внешнего research'а в браузере. Отслеживание — в «Запущенные MCP».
        </p>

        {/* Provider-табы */}
        <div className="flex gap-1 p-1 rounded-lg bg-zinc-900 border border-zinc-800 mb-5">
          {PROVIDERS.map(p => (
            <button
              key={p.id}
              onClick={() => setProvider(p.id)}
              className={`flex-1 h-8 rounded-md text-sm font-medium transition-colors ${
                provider === p.id
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >{p.label}</button>
          ))}
        </div>

        {/* Поля под провайдер. Все Select — compact (одна строка, единый
            шрифт/паддинг как в Telegram scope-picker). hideHint — чтобы
            триггер не тянул вторую строку с описанием. */}
        <div className="mb-4">
          {provider === 'perplexity' && (
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <label className="block text-xs text-zinc-500 mb-1">Режим</label>
                <Select value={pplxMode} onChange={setPplxMode} options={PPLX_MODES} compact hideHint />
              </div>
              {/* Выбор модели — только в режиме «Поиск». В «Глубоком
                  исследовании» Perplexity сам управляет моделью, селектора на
                  странице нет → не показываем (design.md: детерминированность,
                  селектор только когда есть реальный выбор). */}
              {pplxMode === 'search' && (
                <div className="flex-1 min-w-0">
                  <label className="block text-xs text-zinc-500 mb-1">Модель</label>
                  <Select value={pplxModel} onChange={setPplxModel} options={pplxModelOptions} compact hideHint />
                </div>
              )}
            </div>
          )}
          {provider === 'aistudio' && (
            <div className="w-1/2">
              <label className="block text-xs text-zinc-500 mb-1">Модель</label>
              <Select value={aiModel} onChange={setAiModel} options={AISTUDIO_MODELS} compact hideHint />
            </div>
          )}
          {provider === 'claude' && (() => {
            const m = CLAUDE_MODELS_UI.find(x => x.id === clModel) || CLAUDE_MODELS_UI[0]
            const effortOpts = (m.efforts || []).map(e => ({
              id: e,
              label: { low: 'Low', medium: 'Medium', high: 'High', extra: 'Extra', max: 'Max' }[e] || e,
            }))
            // Смена модели может сделать текущий уровень несуществующим
            // (extra есть у Fable/Opus 4.8/4.7, нет у Sonnet/Opus 4.6) — клампим.
            const effortValue = effortOpts.some(o => o.id === clEffort) ? clEffort : (effortOpts[effortOpts.length - 1]?.id || 'max')
            const isOpus3 = clModel === 'opus-3'
            return (
              <div className="space-y-2">
                <div className="flex items-end gap-3">
                  <div className="flex-1 min-w-0">
                    <label className="block text-xs text-zinc-500 mb-1">Модель</label>
                    <Select value={clModel} onChange={setClModel} options={CLAUDE_MODELS_UI} compact hideHint />
                  </div>
                  {effortOpts.length > 0 && (
                    <div className="flex-1 min-w-0">
                      <label className="block text-xs text-zinc-500 mb-1">Effort</label>
                      {/* Effort = глубина thinking'а. Тумблер Thinking выключен →
                          уровень не применяется, селект disabled (юзер: «логично,
                          что disabled будет селект»). При выключенном тумблере
                          effort и не отправляется в options. */}
                      <Select
                        value={effortValue}
                        onChange={setClEffort}
                        options={effortOpts}
                        compact hideHint
                        disabled={!!m.toggle && !clThinking}
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  {/* Research недоступен только на Opus 3 (проверено в живом UI). */}
                  <label className={`flex items-center gap-2 text-xs select-none ${isOpus3 ? 'text-zinc-600 cursor-not-allowed' : 'text-zinc-400 cursor-pointer'}`}>
                    <input
                      type="checkbox"
                      checked={isOpus3 ? false : clResearch}
                      disabled={isOpus3}
                      onChange={e => setClResearch(e.target.checked)}
                      className="accent-emerald-600"
                    />
                    Research{isOpus3 ? ' (нет на Opus 3)' : ''}
                  </label>
                  {/* Тумблер независим от Effort: Max + Thinking off — валидная
                      комбинация (так устроено само меню claude.ai). */}
                  {m.toggle && (
                    <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={clThinking}
                        onChange={e => setClThinking(e.target.checked)}
                        className="accent-emerald-600"
                      />
                      {m.toggle}
                    </label>
                  )}
                  <span className="text-xs text-zinc-600">Web search всегда включён</span>
                </div>
              </div>
            )
          })()}
          {provider === 'chatgpt' && (
            <div className="space-y-2">
              <div className="flex items-end gap-3">
                <div className="flex-1 min-w-0">
                  <label className="block text-xs text-zinc-500 mb-1">Режим</label>
                  <Select value={gptMode} onChange={setGptMode} options={CHATGPT_MODES} compact hideHint />
                </div>
                <div className="flex-1 min-w-0">
                  <label className="block text-xs text-zinc-500 mb-1">Модель</label>
                  <Select value={gptModelValue} onChange={setGptModel} options={gptModelOptions} compact hideHint />
                </div>
                <div className="flex-1 min-w-0">
                  <label className="block text-xs text-zinc-500 mb-1">Интеллект</label>
                  <Select value={gptEffortValue} onChange={setGptEffort} options={gptEffortOptions} compact hideHint />
                </div>
              </div>
              {/* Источники парсятся всегда; чекбокс решает, включать ли их
                  блоком в текст ответа (default: чистый текст). */}
              <label className="flex items-center gap-2 h-6 text-xs text-zinc-400 cursor-pointer select-none w-fit">
                <input
                  type="checkbox"
                  checked={gptSources}
                  onChange={e => setGptSources(e.target.checked)}
                  className="accent-emerald-600"
                />
                Источники в ответе
              </label>
            </div>
          )}
        </div>

        {/* Prompt */}
        <textarea
          ref={taRef}
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Опишите тему исследования… (Enter — запуск, Shift+Enter — перенос строки)"
          rows={6}
          className="w-full px-3 py-2 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm resize-y focus:border-zinc-600 focus:outline-none"
          disabled={stage === 'sending'}
        />

        {/* Action-row. Feedback живёт В САМОЙ кнопке (design.md «Toast в
            кнопке, не рядом» + «прогресс на источнике клика»): idle → sending
            → sent (зелёный фон, ✓). Фикс-ширина чтобы не дёргалась. Ссылка
            «открыть» — отдельно справа, это навигация, не feedback. */}
        <div className="flex items-center gap-3 mt-4">
          <button
            onClick={submit}
            disabled={stage === 'sending' || stage === 'sent' || !prompt.trim()}
            style={{ minWidth: 150 }}
            className={`h-9 px-4 rounded-md font-medium flex items-center justify-center gap-2 transition-colors ${
              stage === 'sent'
                ? 'bg-emerald-600 text-white cursor-default'
                : stage === 'error'
                ? 'bg-red-900/60 text-red-200 border border-red-700'
                : 'bg-emerald-700 hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white'
            }`}
          >
            {stage === 'sending' ? 'Отправляем…'
              : stage === 'sent' ? <><Check size={15} /> Отправлено</>
              : stage === 'error' ? 'Ошибка — повторить'
              : <><Send size={14} /> Запустить</>}
          </button>

          {stage === 'sent' && lastId && (
            <button
              onClick={() => { refreshAistudioJobs(); pushScreen('aistudio-job', { jobId: lastId }) }}
              className="text-sm text-zinc-400 hover:text-zinc-200 underline"
            >открыть в Истории</button>
          )}
          {stage === 'error' && (
            <span className="text-red-400 text-sm truncate" title={err}>{err}</span>
          )}
        </div>
      </div>
    </div>
  )
}
