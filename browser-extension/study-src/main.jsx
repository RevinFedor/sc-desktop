import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  BookOpen,
  ArrowLeftRight,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Clock3,
  CloudOff,
  Copy,
  Download,
  Eye,
  FileText,
  Languages,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  Wifi,
  X,
} from 'lucide-react'
import '../english-lexeme.js'
import '../learning-store.js'
import '../study-model.js'
import '../youtube-learning-utils.js'
import './study.css'

const extensionStore = window.__scLearningStore
const StudyModel = window.__scStudyModel
const LearningUtils = window.__scYtLearningUtils
const Lexeme = window.__scEnglishLexeme
const BRIDGE = 'http://127.0.0.1:53127'
const REMOTE_STUDY = /^https?:$/.test(window.location.protocol)
const EMBEDDED_STUDY = new URLSearchParams(window.location.search).get('embed') === '1'
const REMOTE_TOKEN_KEY = 'voice-study-token-v1'
const REMOTE_PREFERENCES_KEY = 'voice-study-preferences-v1'
const SWIPE_THRESHOLD = Number(StudyModel?.SWIPE_THRESHOLD || 56)
let learningOverlayScriptPromise = null

function loadExtensionScript(id, file) {
  const existing = document.getElementById(id)
  if (existing?.dataset.loaded === '1') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = existing || document.createElement('script')
    script.id = id
    script.src = chrome.runtime.getURL(file)
    script.onload = () => { script.dataset.loaded = '1'; resolve() }
    script.onerror = () => reject(new Error(`Не удалось загрузить ${file}`))
    if (!existing) document.head.appendChild(script)
  })
}

function ensureLearningOverlayLoaded() {
  if (window.__scLearningOverlay?.openMedia) return Promise.resolve(window.__scLearningOverlay)
  if (learningOverlayScriptPromise) return learningOverlayScriptPromise
  learningOverlayScriptPromise = loadExtensionScript('sc-learning-settings-script', 'settings.js')
    .then(() => loadExtensionScript('sc-learning-overlay-script', 'youtube-learning.js'))
    .then(() => window.__scLearningOverlay?.openMedia
      ? window.__scLearningOverlay
      : Promise.reject(new Error('Интерактивный слой загрузился без media API')))
    .catch((error) => {
    learningOverlayScriptPromise = null
    document.getElementById('sc-learning-overlay-script')?.remove()
    throw error
  })
  return learningOverlayScriptPromise
}

function bootstrapRemoteToken() {
  if (!REMOTE_STUDY) return ''
  const url = new URL(window.location.href)
  const incoming = String(url.searchParams.get('token') || '').trim()
  if (incoming) {
    window.localStorage.setItem(REMOTE_TOKEN_KEY, incoming)
    url.searchParams.delete('token')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }
  return incoming || String(window.localStorage.getItem(REMOTE_TOKEN_KEY) || '').trim()
}

let remoteToken = bootstrapRemoteToken()

async function remoteApi(path, { method = 'GET', body } = {}, timeoutMs = 30_000) {
  remoteToken = remoteToken || String(window.localStorage.getItem(REMOTE_TOKEN_KEY) || '').trim()
  if (!remoteToken) throw new Error('Авторизация словаря отсутствует. Откройте страницу заново из приложения.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${remoteToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok === false) {
      if (response.status === 401) window.localStorage.removeItem(REMOTE_TOKEN_KEY)
      throw new Error(payload?.error || (response.status >= 500 ? 'Voice Record на Mac недоступен' : `Voice Record HTTP ${response.status}`))
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Voice Record не ответил вовремя')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function normalizeRemoteTerm(value) {
  return Lexeme?.normalizeWord?.(value)
    || String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US')
}

function remoteEntry(item) {
  if (!item) return null
  return {
    key: item.id,
    remoteId: item.id,
    kind: item.kind === 'phrase' ? 'phrase' : 'word',
    expressionType: item.expressionType || '',
    state: item.state || 'none',
    sourceLang: item.sourceLang || 'en',
    targetLang: item.targetLang || 'ru',
    sourceText: item.term || item.lemma || '',
    normalizedText: normalizeRemoteTerm(item.lemma || item.term),
    lemma: item.lemma || item.term || '',
    partOfSpeech: item.partOfSpeech || 'unknown',
    partsOfSpeech: Array.isArray(item.partsOfSpeech) ? item.partsOfSpeech : [],
    analysisConfidence: item.analysisConfidence || 'low',
    provisional: item.provisional === true,
    observedForms: Array.isArray(item.observedForms) ? item.observedForms : [],
    translation: item.translation || '',
    translationSource: item.translationSource || '',
    contexts: Array.isArray(item.contexts) ? item.contexts : [],
    createdAt: Number(item.createdAt || 0),
    updatedAt: Number(item.updatedAt || 0),
    stateUpdatedAt: Number(item.stateUpdatedAt || item.updatedAt || 0),
    translationUpdatedAt: Number(item.translationUpdatedAt || item.updatedAt || 0),
    dueAt: item.dueAt || new Date().toISOString(),
    lastReviewedAt: item.lastReviewedAt || null,
    lastPracticedAt: item.lastPracticedAt || null,
    reviewCount: Number(item.reviewCount || 0),
    rememberedCount: Number(item.rememberedCount || 0),
    forgottenCount: Number(item.forgottenCount || 0),
    practiceCount: Number(item.practiceCount || 0),
    practiceRememberedCount: Number(item.practiceRememberedCount || 0),
    practiceForgottenCount: Number(item.practiceForgottenCount || 0),
    dirty: false,
    translationDirty: false,
    conflict: null,
  }
}

function createRemoteStore() {
  const listeners = new Set()
  let entries = []
  let fetchedAt = 0
  let inflight = null
  const notify = () => { for (const listener of listeners) { try { listener({ type: 'remote-changed' }) } catch {} } }
  const replace = (entry) => {
    entries = [entry, ...entries.filter(item => item.key !== entry.key)]
    fetchedAt = Date.now()
    notify()
    return entry
  }
  const load = async (force = false) => {
    if (!force && entries.length && Date.now() - fetchedAt < 1_000) return entries
    if (inflight) return inflight
    inflight = remoteApi('/api/vocabulary?limit=5000&includeInactive=1')
      .then(payload => {
        entries = (payload?.items || []).map(remoteEntry).filter(Boolean)
        fetchedAt = Date.now()
        return entries
      })
      .finally(() => { inflight = null })
    return inflight
  }
  const itemId = payload => payload?.remoteId || (String(payload?.key || '').startsWith('v_') ? payload.key : '')
  const mutationBody = payload => ({
    term: payload?.sourceText || payload?.term || '',
    translation: payload?.translation || '',
    translationSource: payload?.translationSource || (payload?.translation ? 'machine' : ''),
    state: payload?.state || 'none',
    kind: payload?.kind || 'word',
    expressionType: payload?.expressionType || '',
    sourceLang: payload?.sourceLang || 'en',
    targetLang: payload?.targetLang || 'ru',
    lemma: payload?.lemma || payload?.sourceText || payload?.term || '',
    partOfSpeech: payload?.partOfSpeech || 'unknown',
    partsOfSpeech: Array.isArray(payload?.partsOfSpeech) ? payload.partsOfSpeech : [],
    analysisConfidence: payload?.analysisConfidence || 'low',
    observedForms: payload?.observedForms || [],
    contexts: payload?.contexts || [],
  })
  return {
    normalizeTerm: normalizeRemoteTerm,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async migrateLegacy() { return { migrated: 0, already: true } },
    async sync() { await load(true); return { online: true, items: entries } },
    async listEntries() { return [...await load()] },
    async stats() {
      const items = await load()
      const now = Date.now()
      const active = items.filter(item => item.state !== 'none')
      return {
        total: active.length,
        saved: active.filter(item => item.state === 'saved').length,
        known: active.filter(item => item.state === 'known').length,
        due: active.filter(item => item.state === 'saved' && (!Date.parse(item.dueAt) || Date.parse(item.dueAt) <= now)).length,
        pending: 0,
        sync: { online: true },
      }
    },
    async getEntry(query = {}) {
      const items = await load()
      const id = itemId(query)
      if (id) return items.find(item => item.key === id) || null
      const normalized = normalizeRemoteTerm(query.lemma || query.sourceText || query.term)
      return items.find(item => item.lemma === normalized
        || item.normalizedText === normalized
        || item.observedForms.some(form => normalizeRemoteTerm(form) === normalized)) || null
    },
    async setState(payload = {}) {
      const existing = await this.getEntry(payload)
      const requested = payload.state || 'none'
      const nextState = payload.toggle !== false && existing?.state === requested ? 'none' : requested
      const body = { ...mutationBody({ ...(existing || {}), ...payload }), state: nextState }
      const id = itemId(existing || payload)
      const result = id
        ? await remoteApi(`/api/vocabulary/${encodeURIComponent(id)}`, { method: 'PATCH', body })
        : await remoteApi('/api/vocabulary', { method: 'POST', body })
      return replace(remoteEntry(result.item))
    },
    async editTranslation({ key, translation }) {
      const result = await remoteApi(`/api/vocabulary/${encodeURIComponent(key)}`, {
        method: 'PATCH', body: { translation, translationSource: 'manual' },
      })
      return replace(remoteEntry(result.item))
    },
    async resolveConflict({ key }) { return entries.find(item => item.key === key) || null },
    async queueReview({ key, result, mode }) {
      const before = entries.find(item => item.key === key) || await this.getEntry({ key })
      const operationId = `web-review-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      const payload = await remoteApi(`/api/vocabulary/${encodeURIComponent(key)}/review`, {
        method: 'POST', body: { result, mode, operationId, reviewedAt: Date.now() },
      })
      const entry = replace(remoteEntry(payload.item))
      return { entry, operation: { id: operationId }, entryBefore: before }
    },
    async undoReview({ key, operation }) {
      const operationId = operation?.id || operation
      const payload = await remoteApi(`/api/vocabulary/${encodeURIComponent(key)}/review/undo`, {
        method: 'POST', body: { operationId },
      })
      return replace(remoteEntry(payload.item))
    },
    async getPracticeSession() {
      try { return JSON.parse(window.localStorage.getItem('voice-study-practice-v1') || 'null') } catch { return null }
    },
    async savePracticeSession(session) {
      const next = { ...session, updatedAt: Date.now() }
      window.localStorage.setItem('voice-study-practice-v1', JSON.stringify(next))
      return next
    },
    async clearPracticeSession() { window.localStorage.removeItem('voice-study-practice-v1'); return true },
  }
}

const store = REMOTE_STUDY ? createRemoteStore() : extensionStore

async function learningBridgeJson(path, body, timeoutMs = 45_000) {
  if (REMOTE_STUDY) {
    if (path === '/learning/practice') {
      return remoteApi('/api/desktop/vocabulary-practice', { method: 'POST', body }, timeoutMs)
    }
    throw new Error('Эта функция пока доступна только в расширении на Mac')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${BRIDGE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SC-Extension-Id': typeof chrome !== 'undefined' ? (chrome.runtime?.id || '') : '',
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `SC Desktop HTTP ${response.status}`)
    if (payload?.online === false) throw new Error(payload.error || 'Voice Record недоступен')
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Запрос занял слишком много времени')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function learningBridgeGet(path, timeoutMs = 30_000) {
  if (REMOTE_STUDY) throw new Error('Локальная медиатека доступна только в расширении на Mac')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${BRIDGE}${path}`, {
      headers: { 'X-SC-Extension-Id': typeof chrome !== 'undefined' ? (chrome.runtime?.id || '') : '' },
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `SC Desktop HTTP ${response.status}`)
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('SC Desktop не ответил вовремя')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function translatePracticeText(text, from, to) {
  const value = String(text || '').trim()
  if (!value) return ''
  const payload = await learningBridgeJson('/translator/translate', { texts: [value], from, to }, 20_000)
  return payload?.translations?.[0]?.translated_text || ''
}

function practiceMessageId(prefix = 'practice') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function readYoutubePreferences() {
  if (REMOTE_STUDY) {
    try {
      const stored = JSON.parse(window.localStorage.getItem(REMOTE_PREFERENCES_KEY) || '{}')
      return Promise.resolve({
        learning_ai_explanation: stored.learning_ai_explanation !== false,
        learning_card_autoplay: stored.learning_card_autoplay === true,
      })
    } catch {
      return Promise.resolve({ learning_ai_explanation: true, learning_card_autoplay: false })
    }
  }
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) {
    return Promise.resolve({ learning_ai_explanation: true, learning_card_autoplay: false })
  }
  return new Promise((resolve) => {
    chrome.storage.sync.get({ __yt: { learning_ai_explanation: true, learning_card_autoplay: false } }, (raw) => {
      const settings = raw?.__yt && typeof raw.__yt === 'object' ? raw.__yt : {}
      resolve({
        learning_ai_explanation: settings.learning_ai_explanation !== false,
        learning_card_autoplay: settings.learning_card_autoplay === true,
      })
    })
  })
}

function patchYoutubePreferences(patch) {
  if (REMOTE_STUDY) {
    return readYoutubePreferences().then((current) => {
      const settings = { ...current, ...patch }
      window.localStorage.setItem(REMOTE_PREFERENCES_KEY, JSON.stringify(settings))
      return { online: true, scope: 'device', settings }
    })
  }
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return Promise.resolve({ online: false, settings: patch })
  }
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'sc-youtube-settings-patch', patch }, (response) => {
      const error = chrome.runtime.lastError
      if (error) { reject(new Error(error.message)); return }
      if (!response?.ok) { reject(new Error(response?.error || 'Не удалось сохранить настройку')); return }
      resolve(response)
    })
  })
}

function preferenceSavedMessage(result) {
  if (result?.scope === 'device') return 'Сохранено на этом устройстве.'
  return result?.online === false
    ? 'Сохранено локально; SC Desktop применит настройку при запуске.'
    : 'Сохранено'
}

function speakLearningText(text) {
  const value = String(text || '').trim()
  if (!value || typeof speechSynthesis === 'undefined') return false
  try {
    speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(value)
    utterance.lang = 'en-US'
    if (LearningUtils?.isDesktopChromiumSpeech?.(navigator.userAgent)) {
      const voice = LearningUtils?.preferredEnglishSpeechVoice?.(speechSynthesis.getVoices(), 'en-US')
      if (voice) utterance.voice = voice
      utterance.rate = 0.85
    }
    speechSynthesis.speak(utterance)
    return true
  } catch {
    return false
  }
}

function notifyNativeStudyCardGesture(active) {
  if (!REMOTE_STUDY || !EMBEDDED_STUDY) return
  try {
    window.webkit?.messageHandlers?.studyCardGesture?.postMessage({ active: Boolean(active) })
  } catch {}
}

function notifyNativeStudyRoute(route) {
  if (!REMOTE_STUDY || !EMBEDDED_STUDY) return
  try {
    window.webkit?.messageHandlers?.studyRouteChanged?.postMessage({ route: String(route || 'cards') })
  } catch {}
}

function stateLabel(state) {
  if (state === 'known') return 'Знаю'
  if (state === 'saved') return 'В словаре'
  return 'Без отметки'
}

const PART_OF_SPEECH_LABELS = {
  noun: 'сущ.',
  verb: 'глаг.',
  adjective: 'прил.',
  adj: 'прил.',
  adverb: 'нареч.',
  adv: 'нареч.',
  pronoun: 'мест.',
  pron: 'мест.',
  preposition: 'предл.',
  prep: 'предл.',
  conjunction: 'союз',
  conj: 'союз',
  determiner: 'опред.',
  det: 'опред.',
}
const EXPRESSION_TYPE_LABELS = {
  phrasal_verb: 'Фразовый глагол',
  function_phrase: 'Служебная связка',
  idiom: 'Идиома',
}

function partOfSpeechLabel(value) {
  return PART_OF_SPEECH_LABELS[value] || ''
}

function expressionTypeLabel(value) {
  return EXPRESSION_TYPE_LABELS[value] || ''
}

function formatDue(value) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'новая'
  if (timestamp <= Date.now()) return 'сейчас'
  const minutes = Math.ceil((timestamp - Date.now()) / 60_000)
  if (minutes < 60) return `через ${minutes} мин`
  const hours = Math.ceil(minutes / 60)
  if (hours < 24) return `через ${hours} ч`
  return `через ${Math.ceil(hours / 24)} дн`
}

function StateButton({ active, tone, icon: Icon, children, onClick, disabled }) {
  return (
    <button
      type="button"
      className={`state-button ${tone} ${active ? 'active' : ''}`}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={17} />
      {children}
    </button>
  )
}

function entrySourceTerms(entry) {
  return Array.from(new Set([
    entry?.sourceText,
    entry?.lemma,
    ...(entry?.observedForms || []),
    ...(Lexeme?.formsForLexeme?.(entry) || []),
  ].filter(Boolean)))
}

function selectedLearningContexts(entry, limit = 3, offset = 0) {
  const contexts = Array.isArray(entry?.contexts) ? entry.contexts : []
  const ordered = [
    ...contexts.filter((context) => context.origin === 'dictionary'),
    ...contexts.filter((context) => context.origin !== 'dictionary'),
  ]
  const unique = []
  const seenMeanings = new Set()
  const seenSentences = new Set()
  for (const context of ordered) {
    const sentenceKey = String(context?.sourceText || '').trim().toLocaleLowerCase('en-US')
    const meaningKey = String(context?.meaning || '').trim().toLocaleLowerCase('ru-RU')
    if (!sentenceKey || seenSentences.has(sentenceKey)) continue
    if (meaningKey && seenMeanings.has(meaningKey)) continue
    seenSentences.add(sentenceKey)
    if (meaningKey) seenMeanings.add(meaningKey)
    unique.push(context)
  }
  if (!unique.length) return []
  const start = ((Number(offset) || 0) % unique.length + unique.length) % unique.length
  const rotated = [...unique.slice(start), ...unique.slice(0, start)]
  return rotated.slice(0, Math.max(1, Number(limit) || 3))
}

function meaningVariants(value) {
  return new Set(String(value || '')
    .split(/\s*\/\s*/)
    .map((item) => item.trim().toLocaleLowerCase('ru-RU'))
    .filter(Boolean))
}

function entrySenseSummaries(entry, limit = 8) {
  const senses = []
  const seen = new Set()
  for (const context of entry?.contexts || []) {
    const meaning = String(context?.meaning || '').trim()
    if (!meaning) continue
    const key = meaning.toLocaleLowerCase('ru-RU')
    if (seen.has(key)) continue
    seen.add(key)
    senses.push({ meaning, partOfSpeech: context.partOfSpeech || 'unknown' })
  }
  if (entry?.translation) {
    const translationVariants = meaningVariants(entry.translation)
    const represented = senses.some((sense) => {
      const variants = meaningVariants(sense.meaning)
      return [...translationVariants].some((variant) => variants.has(variant))
    })
    if (!represented) senses.unshift({ meaning: entry.translation, partOfSpeech: entry.partOfSpeech || 'unknown' })
  }
  return senses.slice(0, limit)
}

function HighlightedExampleText({ segments }) {
  return (segments || []).map((segment, index) => segment.active
    ? <mark key={`${segment.start}-${segment.end}-${index}`}>{segment.text}</mark>
    : <React.Fragment key={`${segment.start}-${segment.end}-${index}`}>{segment.text}</React.Fragment>)
}

function LearningExamples({
  entry,
  limit = 3,
  showLinks = false,
  showTarget = true,
  offset = 0,
  explicitContexts = null,
  collapsible = false,
  onSpeak = null,
  onReveal = null,
}) {
  const contexts = useMemo(
    () => Array.isArray(explicitContexts) ? explicitContexts : selectedLearningContexts(entry, limit, offset),
    [entry?.contexts, explicitContexts, limit, offset],
  )
  const [resolved, setResolved] = useState([])
  const [expandedRows, setExpandedRows] = useState({})
  const contextSignature = contexts.map((context) => context.id || context.sourceText || '').join('\u0000')

  useEffect(() => {
    let active = true
    setResolved([])
    const texts = contexts.map((context) => context.sourceText).filter(Boolean)
    if (!texts.length) return () => { active = false }
    learningBridgeJson('/translator/translate', {
      texts,
      from: entry?.sourceLang || 'en',
      to: entry?.targetLang || 'ru',
    }, 20_000).then((payload) => {
      if (active) setResolved(payload?.translations || [])
    }).catch(() => {})
    return () => { active = false }
  }, [entry?.key, contextSignature])

  useEffect(() => {
    const next = {}
    contexts.forEach((_, index) => { next[index] = showTarget })
    setExpandedRows(next)
  }, [entry?.key, contextSignature, showTarget])

  if (!contexts.length) return null
  const sourceTerms = entrySourceTerms(entry)
  const targetTerms = [entry?.translation].filter(Boolean)
  return (
    <div className="learning-examples">
      {contexts.map((context, index) => {
        const translated = resolved[index]
        const presentation = LearningUtils.learningExamplePresentation({
          sourceText: context.sourceText,
          targetText: translated?.translated_text || context.translation || '',
          sourceTerms,
          targetTerms: [context.meaning, ...targetTerms].filter(Boolean),
          sourceLanguage: entry?.sourceLang || 'en',
          targetLanguage: entry?.targetLang || 'ru',
          alignment: translated?.alignment || '',
        })
        const href = context.videoUrl
          ? `${context.videoUrl}${context.startMs >= 0 ? `&t=${Math.floor(context.startMs / 1000)}s` : ''}`
          : ''
        const expanded = showTarget && expandedRows[index] !== false
        if (collapsible) {
          return (
            <div className={`learning-example collapsible ${expanded ? 'expanded' : ''}`} key={context.id || `${context.sourceText}-${index}`}>
              <div className="learning-example-summary-row">
                <button
                  type="button"
                  className="learning-example-toggle"
                  aria-expanded={expanded}
                  onClick={() => {
                    if (!showTarget) { onReveal?.(); return }
                    setExpandedRows((previous) => ({ ...previous, [index]: !expanded }))
                  }}
                >
                  <ChevronDown size={17} className={expanded ? 'expanded' : ''} />
                  <span className="learning-example-source" data-selectable-text><HighlightedExampleText segments={presentation.sourceSegments} /></span>
                </button>
                <button
                  type="button"
                  className="learning-example-play"
                  onClick={() => onSpeak?.(context.sourceText)}
                  title="Произнести пример"
                  aria-label="Произнести пример"
                ><Play size={18} /></button>
              </div>
              {expanded && presentation.targetText && (
                <div className="learning-example-detail-row" data-selectable-text>
                  <HighlightedExampleText segments={presentation.targetSegments} />
                </div>
              )}
            </div>
          )
        }
        return (
          <div className="learning-example" key={context.id || `${context.sourceText}-${index}`}>
            {href ? (
              <a className="learning-example-play" href={href} target="_blank" rel="noreferrer" title="Открыть реплику"><Play size={18} /></a>
            ) : <span className="learning-example-play placeholder"><Play size={18} /></span>}
            <div className="learning-example-copy">
              {showTarget && context.meaning && (
                <div className="learning-example-meaning">
                  {context.meaning}
                  {partOfSpeechLabel(context.partOfSpeech) && <small>({partOfSpeechLabel(context.partOfSpeech)})</small>}
                </div>
              )}
              <div className="learning-example-source" data-selectable-text><HighlightedExampleText segments={presentation.sourceSegments} /></div>
              {presentation.targetText && (
                <div className={`learning-example-target ${showTarget ? '' : 'concealed'}`} data-selectable-text aria-hidden={!showTarget}>
                  <HighlightedExampleText segments={presentation.targetSegments} />
                </div>
              )}
              {showLinks && href && <a className="learning-example-link" href={href} target="_blank" rel="noreferrer">Открыть видео</a>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SyncBadge({ stats, syncing, onSync }) {
  const online = stats?.sync?.online === true
  return (
    <button type="button" className={`sync-badge ${online ? 'online' : 'offline'}`} onClick={onSync} disabled={syncing}>
      {syncing ? <RefreshCw size={16} className="spin" /> : online ? <Wifi size={16} /> : <CloudOff size={16} />}
      <span>{syncing ? 'Синхронизация…' : online ? 'Синхронизировано' : 'Офлайн — изменения сохранены'}</span>
      {stats?.pending > 0 && <strong>{stats.pending}</strong>}
    </button>
  )
}

function AddEntry({ onChanged }) {
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [translation, setTranslation] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    if (!term.trim() || busy) return
    setBusy(true)
    try {
      await store.setState({
        kind: term.trim().includes(' ') ? 'phrase' : 'word',
        state: 'saved',
        toggle: false,
        sourceLang: 'en',
        targetLang: 'ru',
        sourceText: term,
        normalizedText: store.normalizeTerm(term),
        translation,
        translationSource: translation ? 'manual' : '',
        contexts: [],
      })
      setTerm('')
      setTranslation('')
      setOpen(false)
      await onChanged({ sync: true })
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return <button type="button" className="primary-button" onClick={() => setOpen(true)}><Plus size={18} />Добавить</button>
  }
  return (
    <form className="add-form" onSubmit={submit}>
      <input autoFocus value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Слово или фраза" />
      <input value={translation} onChange={(event) => setTranslation(event.target.value)} placeholder="Перевод (можно позже)" />
      <button type="submit" className="primary-button" disabled={!term.trim() || busy}><Check size={18} />Сохранить</button>
      <button type="button" className="icon-button" aria-label="Отмена" onClick={() => setOpen(false)}><X size={18} /></button>
    </form>
  )
}

function ConflictBox({ entry, onResolve }) {
  if (!entry.conflict) return null
  return (
    <div className="conflict-box">
      <div><strong>Перевод изменён в двух местах</strong><span>Выберите, какой оставить.</span></div>
      <div className="conflict-values">
        <button type="button" onClick={() => onResolve(entry.key, 'local')}><small>Этот браузер</small>{entry.conflict.localValue || 'пусто'}</button>
        <button type="button" onClick={() => onResolve(entry.key, 'remote')}><small>Общая база</small>{entry.conflict.remoteValue || 'пусто'}</button>
      </div>
    </div>
  )
}

function EntryRow({ entry, onState, onTranslation, onResolve }) {
  const [editing, setEditing] = useState(false)
  const [translation, setTranslation] = useState(entry.translation || '')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const totalAttempts = Number(entry.reviewCount || 0) + Number(entry.practiceCount || 0)
  const observedForms = Array.from(new Set(entry.observedForms || []))
    .filter((form) => form && form !== entry.lemma)
  const senses = entrySenseSummaries(entry)

  useEffect(() => setTranslation(entry.translation || ''), [entry.translation])

  const saveTranslation = async () => {
    setBusy(true)
    try {
      await onTranslation(entry.key, translation)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className={`entry-row state-${entry.state}`} data-entry-key={entry.key}>
      <div className="entry-main">
        <div className="entry-copy">
          <div className="entry-term-line">
            <h3>{entry.sourceText}</h3>
            <span className={`state-dot ${entry.state}`}>{stateLabel(entry.state)}</span>
            {entry.kind === 'phrase' && <span className="kind-pill">{expressionTypeLabel(entry.expressionType) || 'фраза'}</span>}
          </div>
          {observedForms.length > 0 && <div className="entry-observed-forms">Формы: {observedForms.join(', ')}</div>}
          {editing ? (
            <div className="translation-editor">
              <input value={translation} onChange={(event) => setTranslation(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') saveTranslation()
                if (event.key === 'Escape') setEditing(false)
              }} />
              <button type="button" className="icon-button success" onClick={saveTranslation} disabled={busy}><Check size={17} /></button>
              <button type="button" className="icon-button" onClick={() => setEditing(false)}><X size={17} /></button>
            </div>
          ) : senses.length ? (
            <div className="entry-senses">
              {senses.map((sense) => (
                <div key={`${sense.partOfSpeech}-${sense.meaning}`}>
                  <span>{sense.meaning}</span>
                  {partOfSpeechLabel(sense.partOfSpeech) && <small>({partOfSpeechLabel(sense.partOfSpeech)})</small>}
                </div>
              ))}
              <button type="button" className="entry-senses-edit" onClick={() => setEditing(true)} aria-label="Изменить основной перевод"><Pencil size={13} /></button>
            </div>
          ) : (
            <button type="button" className={`translation-value ${entry.translation ? '' : 'empty'}`} onClick={() => setEditing(true)}>
              <span>{entry.translation || 'Добавить перевод'}</span><Pencil size={14} />
            </button>
          )}
          <div className="entry-meta">
            <span><Clock3 size={13} />{totalAttempts ? `${totalAttempts} повторений` : 'новая карточка'}</span>
            {entry.state === 'saved' && <span>следующая: {formatDue(entry.dueAt)}</span>}
            {entry.dirty && <span className="pending-label">ждёт синхронизации</span>}
          </div>
        </div>
        <div className="entry-actions">
          <StateButton active={entry.state === 'known'} tone="known" icon={CheckCircle2} onClick={() => onState(entry, 'known')}>Знаю</StateButton>
          <StateButton active={entry.state === 'saved'} tone="saved" icon={BookOpen} onClick={() => onState(entry, 'saved')}>В словарь</StateButton>
          {!!entry.contexts?.length && (
            <button type="button" className="icon-button" aria-label="Показать примеры" onClick={() => setExpanded((value) => !value)}>
              {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>
          )}
        </div>
      </div>
      <ConflictBox entry={entry} onResolve={onResolve} />
      {expanded && (
        <div className="contexts">
          <LearningExamples entry={entry} limit={3} showLinks />
        </div>
      )}
    </article>
  )
}

function DictionaryView({ entries, refresh }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en-US')
    return entries.filter((entry) => entry.state !== 'none')
      .filter((entry) => filter === 'all' || entry.state === filter)
      .filter((entry) => !needle
        || entry.sourceText.toLocaleLowerCase('en-US').includes(needle)
        || entry.translation.toLocaleLowerCase('en-US').includes(needle))
  }, [entries, filter, query])

  const setState = async (entry, state) => {
    await store.setState({ ...entry, state, toggle: true })
    await refresh({ sync: true })
  }
  const editTranslation = async (key, translation) => {
    await store.editTranslation({ key, translation })
    await refresh({ sync: true })
  }
  const resolve = async (key, choice) => {
    await store.resolveConflict({ key, choice })
    await refresh({ sync: choice === 'local' })
  }

  return (
    <section className="workspace" aria-label="Словарь">
      <div className="toolbar">
        <label className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти слово или перевод" /></label>
        <div className="filters" role="group" aria-label="Фильтр словаря">
          {[['all', 'Все'], ['saved', 'В словаре'], ['known', 'Знаю']].map(([value, label]) => (
            <button type="button" key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <AddEntry onChanged={refresh} />
      </div>
      <div className="entry-list">
        {visible.map((entry) => <EntryRow key={entry.key} entry={entry} onState={setState} onTranslation={editTranslation} onResolve={resolve} />)}
        {!visible.length && <div className="empty-state"><BookOpen size={38} /><h2>Здесь пока пусто</h2><p>Добавьте слово вручную или нажмите «В словарь» в субтитрах YouTube.</p></div>}
      </div>
    </section>
  )
}

function DeckOverview({ entries, stats, onStart }) {
  const savedEntries = useMemo(() => entries.filter((entry) => entry.state === 'saved'), [entries])
  const dueCount = useMemo(
    () => savedEntries.filter((entry) => StudyModel.isDue(entry)).length,
    [savedEntries],
  )
  const newCount = useMemo(
    () => savedEntries.filter((entry) => Number(entry.reviewCount || 0) === 0).length,
    [savedEntries],
  )

  return (
    <section className="deck-overview workspace" aria-label="Карточки">
      <div className="deck-overview-copy">
        <span>Интервальное повторение</span>
        <h2>Карточки</h2>
        <p>Сначала идут новые и просроченные карточки, затем остальные слова для практики.</p>
      </div>
      <div className="deck-overview-stats" aria-label="Статистика карточек">
        <div><span>Всего</span><strong>{stats?.saved ?? savedEntries.length}</strong></div>
        <div><span>К повторению</span><strong>{dueCount}</strong></div>
        <div><span>Новых</span><strong>{newCount}</strong></div>
      </div>
      <button
        type="button"
        className="mixed-mode-card"
        onClick={onStart}
        disabled={!savedEntries.length}
      >
        <span className="mixed-mode-icon"><Sparkles size={22} /></span>
        <span className="mixed-mode-copy">
          <strong>Смешанный режим</strong>
          <small>{savedEntries.length
            ? `Новые слова и повторение · ${savedEntries.length} карточек`
            : 'Сначала добавьте слова в словарь'}</small>
        </span>
        <ArrowRight size={20} />
      </button>
    </section>
  )
}

function DeckView({ entries, refresh, onExit }) {
  const savedEntries = useMemo(() => entries.filter((entry) => entry.state === 'saved'), [entries])
  const entriesByKey = useMemo(() => new Map(savedEntries.map((entry) => [entry.key, entry])), [savedEntries])
  const initialRound = useMemo(() => StudyModel.buildRound(savedEntries, {}), [])
  const [queue, setQueue] = useState(initialRound)
  const [round, setRound] = useState(1)
  const [roundTotal, setRoundTotal] = useState(initialRound.length)
  const [sessionStats, setSessionStats] = useState({})
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [exiting, setExiting] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [autoplay, setAutoplay] = useState(false)
  const [lastAction, setLastAction] = useState(null)
  const lastKeyRef = useRef('')
  const autoplayRef = useRef(false)
  const lastAutoplayCardKeyRef = useRef('')
  const dragRef = useRef({ pointerId: null, startX: 0, startY: 0, deltaX: 0, dragging: false })
  const suppressClickRef = useRef(false)
  const savedSignature = savedEntries.map((entry) => entry.key).sort().join('\u0000')
  const current = entriesByKey.get(queue[0]) || null
  const currentPosition = current ? Math.max(1, roundTotal - queue.length + 1) : 0
  const currentAttempts = Number(current?.reviewCount || 0) + Number(current?.practiceCount || 0)
  const currentExampleContexts = useMemo(
    () => current ? selectedLearningContexts(current, 1, currentAttempts) : [],
    [current?.key, current?.contexts, currentAttempts],
  )

  useEffect(() => {
    const activeKeys = new Set(savedEntries.map((entry) => entry.key))
    setQueue((previous) => {
      const kept = previous.filter((key) => activeKeys.has(key))
      const queued = new Set(kept)
      const missing = savedEntries.filter((entry) => !queued.has(entry.key)).map((entry) => entry.key)
      if (kept.length || missing.length) {
        const next = [...kept, ...missing]
        if (!previous.length) setRoundTotal(next.length)
        return next
      }
      const next = StudyModel.buildRound(savedEntries, sessionStats, lastKeyRef.current)
      setRoundTotal(next.length)
      return next
    })
  }, [savedSignature])

  useEffect(() => {
    dragRef.current = { pointerId: null, startX: 0, startY: 0, deltaX: 0, dragging: false }
    suppressClickRef.current = false
    setRevealed(false)
    setDragX(0)
    setDragging(false)
    setExiting('')
    setMenuOpen(false)
  }, [current?.key])

  useEffect(() => {
    let active = true
    readYoutubePreferences().then((preferences) => {
      if (active) setAutoplay(preferences.learning_card_autoplay === true)
    }).catch(() => {})
    return () => { active = false }
  }, [])

  useEffect(() => {
    autoplayRef.current = autoplay
  }, [autoplay])

  useEffect(() => {
    const nextKey = current?.key || ''
    if (!nextKey) return
    const shouldSpeak = LearningUtils?.shouldAutoplayCard?.(lastAutoplayCardKeyRef.current, nextKey)
    lastAutoplayCardKeyRef.current = nextKey
    if (autoplayRef.current && shouldSpeak && current?.sourceText) speakLearningText(current.sourceText)
  }, [current?.key])

  useEffect(() => () => notifyNativeStudyCardGesture(false), [])

  useEffect(() => {
    if (!menuOpen) return undefined
    const close = (event) => {
      if (!event.target?.closest?.('.study-card-menu-shell')) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuOpen])

  const review = useCallback(async (result, { animate = true } = {}) => {
    if (!current || busy) return
    setBusy(true)
    const snapshot = {
      queue: [...queue],
      round,
      roundTotal,
      sessionStats: { ...sessionStats },
      lastKey: lastKeyRef.current,
      entryBefore: current,
    }
    const mode = StudyModel.reviewMode(current)
    const nextStats = StudyModel.nextSessionStats(sessionStats, current.key, result)
    const remaining = queue.slice(1).filter((key) => entriesByKey.has(key))
    const nextRound = remaining.length
      ? null
      : StudyModel.buildRound(savedEntries, nextStats, current.key)
    const reviewPromise = store.queueReview({ key: current.key, result, mode }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    )
    if (animate) {
      setDragging(false)
      setExiting(result)
      await new Promise((resolve) => setTimeout(resolve, 210))
    }
    lastKeyRef.current = current.key
    setSessionStats(nextStats)
    if (remaining.length) {
      setQueue(remaining)
    } else {
      setRound((value) => value + 1)
      setRoundTotal(nextRound.length)
      setQueue(nextRound)
    }
    setRevealed(false)
    setDragX(0)
    setDragging(false)
    setExiting('')
    try {
      const outcome = await reviewPromise
      if (outcome.error) throw outcome.error
      const reviewResult = outcome.value
      setLastAction({
        type: 'review',
        snapshot,
        operation: reviewResult?.operation,
        entryBefore: reviewResult?.entryBefore || current,
      })
      refresh({ sync: false }).catch(() => {})
      store.sync({}).catch(() => {})
    } catch (error) {
      setQueue(snapshot.queue)
      setRound(snapshot.round)
      setRoundTotal(snapshot.roundTotal)
      setSessionStats(snapshot.sessionStats)
      lastKeyRef.current = snapshot.lastKey
      setLastAction(null)
      console.error('[Study] review failed', error)
    } finally {
      setBusy(false)
      setDragX(0)
      setDragging(false)
      setExiting('')
    }
  }, [busy, current, entriesByKey, queue, refresh, round, roundTotal, savedEntries, sessionStats])

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if (target?.closest?.('button, a') && !target.closest('.reveal-button')) return
      const revealKey = event.key === 'Enter' || event.key === ' ' || event.code === 'Space'
      if (revealKey && !revealed && current) {
        event.preventDefault()
        if (!event.repeat) setRevealed(true)
        return
      }
      if (busy || event.repeat || !current) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        review('remembered')
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        review('forgotten')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, current, revealed, review])

  const onPointerDown = (event) => {
    if (busy || event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      deltaX: 0,
      dragging: false,
    }
    setExiting('')
  }

  const onPointerMove = (event) => {
    const pointer = dragRef.current
    if (pointer.pointerId !== event.pointerId) return
    const rawDeltaX = event.clientX - pointer.startX
    if (!pointer.dragging) {
      if (Math.abs(rawDeltaX) < 4) return
      pointer.dragging = true
      suppressClickRef.current = true
      try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch {}
      try { window.getSelection?.()?.removeAllRanges?.() } catch {}
      setDragging(true)
    }
    event.preventDefault()
    const deltaX = Math.max(-360, Math.min(360, rawDeltaX))
    pointer.deltaX = deltaX
    setDragX(deltaX)
  }

  const finishPointer = (event, cancelled = false) => {
    const pointer = dragRef.current
    if (pointer.pointerId !== event.pointerId) return
    if (pointer.dragging) {
      try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch {}
    }
    const result = !cancelled && pointer.dragging ? StudyModel.swipeResult(pointer.deltaX, SWIPE_THRESHOLD) : null
    dragRef.current = { pointerId: null, startX: 0, startY: 0, deltaX: 0, dragging: false }
    setDragging(false)
    if (result) review(result)
    else setDragX(0)
    if (pointer.dragging) window.setTimeout(() => { suppressClickRef.current = false }, 0)
  }

  const suppressClickAfterDrag = (event) => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  const restoreDeckSnapshot = (snapshot) => {
    setQueue(snapshot.queue)
    setRound(snapshot.round)
    setRoundTotal(snapshot.roundTotal)
    setSessionStats(snapshot.sessionStats)
    lastKeyRef.current = snapshot.lastKey
    setRevealed(false)
    setDragX(0)
    setDragging(false)
    setExiting('')
  }

  const undoLastAction = async () => {
    if (!lastAction || busy) return
    setBusy(true)
    try {
      if (lastAction.type === 'review') {
        await store.undoReview({
          key: lastAction.entryBefore.key,
          entryBefore: lastAction.entryBefore,
          operation: lastAction.operation,
        })
      } else if (lastAction.type === 'delete') {
        await store.setState({ ...lastAction.entryBefore, state: 'saved', toggle: false })
      }
      restoreDeckSnapshot(lastAction.snapshot)
      setLastAction(null)
      await refresh({ sync: false })
      store.sync({}).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  const removeCurrent = async () => {
    if (!current || busy) return
    const snapshot = {
      queue: [...queue],
      round,
      roundTotal,
      sessionStats: { ...sessionStats },
      lastKey: lastKeyRef.current,
      entryBefore: current,
    }
    setBusy(true)
    setMenuOpen(false)
    try {
      await store.setState({ ...current, state: 'none', toggle: false })
      setLastAction({ type: 'delete', snapshot, entryBefore: current })
      setQueue((previous) => previous.filter((key) => key !== current.key))
      await refresh({ sync: false })
      store.sync({}).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  if (!savedEntries.length) {
    return (
      <section className="deck workspace">
        <div className="deck-empty"><BookOpen size={58} /><h2>Добавьте карточки</h2><p>Сохраните слова из YouTube или добавьте их вручную в словаре.</p></div>
      </section>
    )
  }

  if (!current) return <section className="deck workspace"><div className="page-loader"><RefreshCw className="spin" /></div></section>

  const dragProgress = Math.min(1, Math.abs(dragX) / SWIPE_THRESHOLD)
  const rememberedProgress = dragX < 0 ? dragProgress : 0
  const forgottenProgress = dragX > 0 ? dragProgress : 0
  const transform = exiting
    ? `translate3d(${exiting === 'remembered' ? '-115%' : '115%'},0,0) rotate(${exiting === 'remembered' ? '-5deg' : '5deg'})`
    : `translate3d(${dragX}px,0,0) rotate(${dragX / 90}deg)`
  const currentExample = currentExampleContexts[0] || null
  const currentMeaning = String(currentExample?.meaning || current.translation || '').trim()
  const currentMeaningPart = currentExample?.partOfSpeech || current.partOfSpeech || 'unknown'

  return (
    <section className="deck workspace" aria-label="Карточки">
      {!EMBEDDED_STUDY && (
        <div className="deck-session-heading">
          <button type="button" onClick={onExit}><ArrowLeft size={17} />Карточки</button>
          <strong>Смешанный режим</strong>
        </div>
      )}
      <div className="study-card-stage">
        <div
          key={current.key}
          className={`study-card ${revealed ? 'revealed' : ''} ${dragging ? 'dragging' : ''} ${exiting ? `exiting-${exiting}` : ''}`}
          style={{
            transform,
            transition: dragging && !exiting
              ? 'none'
              : 'transform 210ms cubic-bezier(.2,.78,.28,1)',
          }}
          onClickCapture={suppressClickAfterDrag}
          onPointerDown={onPointerDown}
          onPointerDownCapture={(event) => { if (event.pointerType === 'touch') notifyNativeStudyCardGesture(true) }}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => finishPointer(event)}
          onPointerUpCapture={() => notifyNativeStudyCardGesture(false)}
          onPointerCancel={(event) => finishPointer(event, true)}
          onPointerCancelCapture={() => notifyNativeStudyCardGesture(false)}
          onLostPointerCapture={() => notifyNativeStudyCardGesture(false)}
        >
          <div className="study-card-header">
            <span className="study-card-progress">Круг {round}<i>·</i>{currentPosition}/{roundTotal}</span>
            <div className="study-card-header-actions">
              <button type="button" className="undo-button" onClick={undoLastAction} disabled={!lastAction || busy} title="Отменить последнее действие">
                <ArrowLeft size={15} />Назад
              </button>
              <div className="study-card-menu-shell">
                <button type="button" className="study-card-tool" onClick={() => setMenuOpen((value) => !value)} title="Действия со словом" aria-label="Действия со словом" aria-expanded={menuOpen}>
                  <MoreHorizontal size={20} />
                </button>
                {menuOpen && (
                  <div className="study-card-menu">
                    <button type="button" className="danger" onClick={removeCurrent}><Trash2 size={16} />Удалить из словаря</button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div
            className={`study-question-slot ${revealed ? '' : 'revealable'}`}
            onClick={(event) => {
              if (revealed || event.target?.closest?.('.study-card-speak')) return
              setRevealed(true)
            }}
          >
            <div>
              {expressionTypeLabel(current.expressionType) && <span className="study-expression-type">{expressionTypeLabel(current.expressionType)}</span>}
              <h2 data-selectable-text>{current.sourceText}</h2>
            </div>
            <button type="button" className="study-card-tool study-card-speak" onClick={() => speakLearningText(current.sourceText)} title="Произнести слово" aria-label="Произнести слово">
              <Play size={20} />
            </button>
          </div>
          <div className={`study-answer-slot ${revealed ? 'revealed' : 'concealed'}`}>
            {!revealed ? (
              <button
                type="button"
                className="study-translation-watermark"
                onClick={() => setRevealed(true)}
                aria-label="Показать перевод"
              >
                <span>{currentMeaning || 'Перевод'}</span>
              </button>
            ) : (
              <div className="study-translation" data-selectable-text>
                {currentMeaning || 'Перевод ещё не заполнен'}
                {partOfSpeechLabel(currentMeaningPart) && <small>({partOfSpeechLabel(currentMeaningPart)})</small>}
              </div>
            )}
          </div>
          <div className="study-context-slot visible">
            {currentExample
              ? <LearningExamples
                entry={current}
                explicitContexts={currentExampleContexts}
                limit={1}
                showTarget={revealed}
                collapsible
                onReveal={() => setRevealed(true)}
                onSpeak={speakLearningText}
              />
              : <div className="study-example-empty">Для этой карточки пример ещё не сохранён</div>}
          </div>
          {!revealed && (
            <button
              type="button"
              className="study-reveal-eye"
              onClick={() => setRevealed(true)}
              aria-label="Показать перевод"
              title="Показать перевод"
            ><Eye /></button>
          )}
          <div className="review-actions">
            <button
              type="button"
              className="remembered"
              style={{
                '--review-fill-alpha': String(rememberedProgress * 0.58),
                '--review-ring-alpha': String(rememberedProgress * 0.42),
              }}
              onClick={() => review('remembered')}
              disabled={busy}
            >
              <ArrowLeft size={18} /><span>Я вспомнил</span>
            </button>
            <button
              type="button"
              className="forgotten"
              style={{
                '--review-fill-alpha': String(forgottenProgress * 0.58),
                '--review-ring-alpha': String(forgottenProgress * 0.42),
              }}
              onClick={() => review('forgotten')}
              disabled={busy}
            >
              <span>Я не вспомнил</span><ArrowRight size={18} />
            </button>
          </div>
        </div>
      </div>
      <div className="deck-hint">← / → — ответить</div>
    </section>
  )
}

function practiceVocabularyPack(entries, limit = 12) {
  const candidates = entries.filter((entry) => entry.state === 'saved' && entry.kind === 'word')
  const byKey = new Map(candidates.map((entry) => [entry.key, entry]))
  return StudyModel.buildRound(candidates, {})
    .map((key) => byKey.get(key))
    .filter(Boolean)
    .slice(0, limit)
}

function vocabularyFormLookup(entries) {
  const lookup = new Map()
  for (const entry of entries.filter((item) => item.state === 'saved' || item.state === 'known')) {
    if (entry.kind !== 'word') continue
    const forms = new Set([
      entry.sourceText,
      entry.lemma,
      ...(entry.observedForms || []),
      ...(Lexeme?.formsForLexeme?.(entry) || []),
    ])
    for (const form of forms) {
      const normalized = store.normalizeTerm(form)
      if (normalized && !lookup.has(normalized)) lookup.set(normalized, entry)
    }
  }
  return lookup
}

function InteractiveEnglishText({ text, lookup, onWord }) {
  const parts = LearningUtils?.segmentWords?.(text, 'en') || [{ text, word: false }]
  return parts.map((part, index) => {
    if (!part.word) return <React.Fragment key={`${part.index ?? index}-text`}>{part.text}</React.Fragment>
    const entry = lookup.get(part.normalized)
    return (
      <button
        type="button"
        key={`${part.index ?? index}-${part.text}`}
        className="practice-word"
        data-word={part.normalized}
        data-vocabulary-state={entry?.state || ''}
        onClick={(event) => onWord?.({ word: part.text, entry, anchor: event.currentTarget })}
      >{part.text}</button>
    )
  })
}

function RussianVocabularyText({ text, entries }) {
  const terms = useMemo(() => {
    const values = new Set()
    for (const entry of entries) {
      for (const part of LearningUtils?.segmentWords?.(entry.translation || '', 'ru') || []) {
        if (part.word && part.normalized.length >= 3) values.add(part.normalized)
      }
    }
    return values
  }, [entries])
  const parts = LearningUtils?.segmentWords?.(text, 'ru') || [{ text, word: false }]
  return parts.map((part, index) => terms.has(part.normalized)
    ? <mark key={`${part.index ?? index}-${part.text}`}>{part.text}</mark>
    : <React.Fragment key={`${part.index ?? index}-text`}>{part.text}</React.Fragment>)
}

function PracticeWordCard({ selection, onClose, onChanged }) {
  const [entry, setEntry] = useState(selection?.entry || null)
  const [primary, setPrimary] = useState(selection?.entry?.translation || '')
  const [meanings, setMeanings] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!selection) return undefined
    let active = true
    const identity = Lexeme?.canonicalIdentity?.({
      kind: 'word', sourceLang: 'en', targetLang: 'ru', sourceText: selection.word, context: selection.context,
    }) || { lemma: store.normalizeTerm(selection.word), partOfSpeech: 'unknown', confidence: 'low' }
    Promise.all([
      store.getEntry({
        kind: 'word', sourceLang: 'en', targetLang: 'ru', sourceText: selection.word,
        lemma: identity.lemma, partOfSpeech: identity.partOfSpeech, analysisConfidence: identity.confidence,
      }).catch(() => null),
      learningBridgeJson('/translator/dictionary', { text: selection.word, from: 'en', to: 'ru' }, 20_000),
    ]).then(([savedEntry, payload]) => {
      if (!active) return
      const alternatives = payload?.dictionary?.translations || []
      const first = alternatives[0]?.displayTarget || alternatives[0]?.normalizedTarget || payload?.fallback_translation || ''
      setEntry(savedEntry || selection.entry || null)
      setPrimary(savedEntry?.translation || first)
      setMeanings(alternatives.slice(0, 8).map((item) => ({
        value: item.displayTarget || item.normalizedTarget || '',
        pos: partOfSpeechLabel(String(item.posTag || '').toLocaleLowerCase('en-US')) || String(item.posTag || '').toLocaleLowerCase(),
      })).filter((item) => item.value))
      setError('')
    }).catch((loadError) => {
      if (active) setError(loadError?.message || String(loadError))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [selection])

  useEffect(() => {
    const close = (event) => {
      if (!event.target?.closest?.('.practice-word-card,.practice-word')) onClose()
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [onClose])

  if (!selection) return null
  const width = 380
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, selection.rect.left + selection.rect.width / 2 - width / 2))
  const placeAbove = selection.rect.top > 390
  const top = placeAbove ? Math.max(12, selection.rect.top - 370) : Math.min(window.innerHeight - 390, selection.rect.bottom + 9)

  const toggleState = async (state) => {
    if (busy) return
    setBusy(true)
    try {
      const identity = Lexeme?.canonicalIdentity?.({
        kind: 'word', sourceLang: 'en', targetLang: 'ru', sourceText: selection.word, context: selection.context,
      }) || {}
      const next = await store.setState({
        ...(entry || {}),
        kind: 'word', state, toggle: true, sourceLang: 'en', targetLang: 'ru',
        sourceText: selection.word, normalizedText: identity.lemma || store.normalizeTerm(selection.word),
        lemma: identity.lemma, partOfSpeech: identity.partOfSpeech || 'unknown',
        analysisConfidence: identity.confidence || 'low', observedForms: [store.normalizeTerm(selection.word)],
        translation: primary || entry?.translation || '', translationSource: primary ? 'machine' : '', contexts: [],
      })
      setEntry(next)
      await onChanged?.({ sync: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="practice-word-card" style={{ left, top, width }} aria-label={`Перевод ${selection.word}`}>
      <header>
        <div><strong>{selection.word}</strong><span>{loading ? 'Перевожу…' : primary || 'Перевод не найден'}</span></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={17} /></button>
      </header>
      {error && <div className="practice-word-error">{error}</div>}
      {!loading && meanings.length > 0 && <div className="practice-word-meanings">{meanings.map((item, index) => <div key={`${item.pos}-${item.value}-${index}`}><em>{item.pos || 'перевод'}</em><span>{item.value}</span></div>)}</div>}
      <div className="practice-word-context">{selection.context}</div>
      <footer>
        <StateButton active={entry?.state === 'known'} tone="known" icon={CheckCircle2} onClick={() => toggleState('known')} disabled={busy}>Знаю</StateButton>
        <StateButton active={entry?.state === 'saved'} tone="saved" icon={BookOpen} onClick={() => toggleState('saved')} disabled={busy}>В словарь</StateButton>
      </footer>
    </aside>
  )
}

function PracticeMessage({ message, entries, lookup, onWord }) {
  return (
    <article className={`practice-message ${message.role}`} data-role={message.role}>
      {message.feedbackRussian && <div className="practice-feedback"><Sparkles size={15} /><span>{message.feedbackRussian}</span></div>}
      {message.correctedEnglish && (
        <div className="practice-correction"><small>Лучше сказать</small><span>{message.correctedEnglish}</span></div>
      )}
      <div className="practice-message-english">
        <InteractiveEnglishText
          text={message.english}
          lookup={lookup}
          onWord={({ word, entry, anchor }) => onWord({ word, entry, anchor, context: message.english })}
        />
      </div>
      {message.russian && <div className="practice-message-russian"><RussianVocabularyText text={message.russian} entries={entries} /></div>}
    </article>
  )
}

function PracticeTranslator({ onInsert }) {
  const [from, setFrom] = useState('ru')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const to = from === 'ru' ? 'en' : 'ru'

  const translate = async (event) => {
    event?.preventDefault?.()
    if (!input.trim() || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try { setOutput(await translatePracticeText(input, from, to)) }
    catch (translationError) { setError(translationError?.message || String(translationError)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  const swap = () => {
    setFrom(to)
    setInput(output)
    setOutput(input)
    setError('')
  }

  return (
    <aside className="practice-translator">
      <div className="practice-translator-head"><div><Languages size={18} /><strong>Переводчик</strong></div><button type="button" className="icon-button" onClick={swap} title="Поменять языки"><ArrowLeftRight size={17} /></button></div>
      <div className="practice-language-row"><span>{from === 'ru' ? 'Русский' : 'English'}</span><span>{to === 'en' ? 'English' : 'Русский'}</span></div>
      <form onSubmit={translate}>
        <textarea data-testid="practice-translator-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={from === 'ru' ? 'Слово или фраза по-русски' : 'English word or phrase'} />
        <button type="submit" className="primary-button" disabled={!input.trim() || busy}>{busy ? <RefreshCw size={17} className="spin" /> : <Languages size={17} />}Перевести</button>
      </form>
      <div className={`practice-translation-output ${output ? '' : 'empty'}`}>{output || 'Перевод появится здесь'}</div>
      {error && <div className="practice-translator-error">{error}</div>}
      {output && <div className="practice-translator-actions">
        <button type="button" onClick={() => navigator.clipboard.writeText(output)}><Copy size={15} />Копировать</button>
        {to === 'en' && <button type="button" onClick={() => onInsert(output)}><ArrowLeft size={15} />Вставить в ответ</button>}
      </div>}
    </aside>
  )
}

function PracticeView({ entries, refresh }) {
  const [session, setSession] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selectedWord, setSelectedWord] = useState(null)
  const messagesEndRef = useRef(null)
  const composerRef = useRef(null)
  const busyRef = useRef(false)
  const entriesByKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries])
  const lookup = useMemo(() => vocabularyFormLookup(entries), [entries])
  const fallbackPack = useMemo(() => practiceVocabularyPack(entries), [entries])
  const vocabulary = useMemo(() => {
    const restored = (session?.vocabularyKeys || []).map((key) => entriesByKey.get(key)).filter((entry) => entry?.state === 'saved')
    return restored.length ? restored : fallbackPack
  }, [entriesByKey, fallbackPack, session?.vocabularyKeys])

  useEffect(() => {
    let active = true
    store.getPracticeSession().then((saved) => { if (active) setSession(saved) }).finally(() => { if (active) setLoaded(true) })
    return () => { active = false }
  }, [])

  useEffect(() => { messagesEndRef.current?.scrollIntoView?.({ block: 'end' }) }, [session?.messages?.length, busy])

  const persist = async (next) => {
    const saved = await store.savePracticeSession(next)
    setSession(saved)
    return saved
  }

  const payloadVocabulary = (items) => items.map((entry) => ({
    id: entry.key,
    term: entry.sourceText,
    translation: entry.translation || '',
    partOfSpeech: entry.partOfSpeech || 'unknown',
  }))

  const start = async () => {
    if (busyRef.current || !fallbackPack.length) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await learningBridgeJson('/learning/practice', {
        action: 'start', vocabulary: payloadVocabulary(fallbackPack), history: [], answer: '',
      })
      await persist({
        vocabularyKeys: fallbackPack.map((entry) => entry.key),
        messages: [{
          id: practiceMessageId('assistant'), role: 'assistant', english: result.assistantEnglish,
          russian: result.assistantRussian, feedbackRussian: '', correctedEnglish: '',
          usedVocabularyIds: result.usedVocabularyIds || [], createdAt: Date.now(),
        }],
        createdAt: Date.now(),
      })
      requestAnimationFrame(() => composerRef.current?.focus())
    } catch (startError) {
      setError(startError?.message || String(startError))
    } finally { busyRef.current = false; setBusy(false) }
  }

  const send = async () => {
    const answer = draft.trim()
    if (!answer || busyRef.current || !session || !vocabulary.length) return
    busyRef.current = true
    setBusy(true)
    setDraft('')
    setError('')
    try {
      const [result, russian] = await Promise.all([
        learningBridgeJson('/learning/practice', {
          action: 'turn', answer, vocabulary: payloadVocabulary(vocabulary),
          history: (session.messages || []).map((message) => ({ role: message.role, english: message.english, russian: message.russian })),
        }),
        translatePracticeText(answer, 'en', 'ru').catch(() => ''),
      ])
      const now = Date.now()
      await persist({
        ...session,
        messages: [
          ...(session.messages || []),
          { id: practiceMessageId('user'), role: 'user', english: answer, russian, createdAt: now },
          {
            id: practiceMessageId('assistant'), role: 'assistant', english: result.assistantEnglish,
            russian: result.assistantRussian, feedbackRussian: result.feedbackRussian || '',
            correctedEnglish: result.correctedEnglish || '', usedVocabularyIds: result.usedVocabularyIds || [], createdAt: now + 1,
          },
        ],
      })
      requestAnimationFrame(() => composerRef.current?.focus())
    } catch (sendError) {
      setDraft(answer)
      setError(sendError?.message || String(sendError))
    } finally { busyRef.current = false; setBusy(false) }
  }

  const reset = async () => {
    if (busyRef.current) return
    await store.clearPracticeSession()
    setSession(null)
    setDraft('')
    setError('')
    setSelectedWord(null)
  }

  const selectWord = ({ word, entry, anchor, context }) => {
    const rect = anchor.getBoundingClientRect()
    setSelectedWord({ word, entry, context, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } })
  }

  if (!loaded) return <section className="workspace practice-workspace"><div className="page-loader"><RefreshCw className="spin" /></div></section>

  return (
    <section className="workspace practice-workspace" aria-label="Практика английского">
      <div className="practice-chat">
        <header className="practice-chat-head">
          <div><MessageCircle size={20} /><div><strong>Разговорная практика</strong><span>{session ? `${vocabulary.length} слов в этой сессии` : 'Диалог на основе вашего словаря'}</span></div></div>
          {session && <button type="button" className="secondary-button" onClick={reset} disabled={busy}>Новый диалог</button>}
        </header>
        {!session ? (
          <div className="practice-start">
            <div className="practice-start-icon"><MessageCircle size={34} /></div>
            <h2>Потренируем живой английский</h2>
            <p>AI начнёт короткий двуязычный диалог и будет естественно использовать слова из вашего словаря.</p>
            <button data-testid="practice-start" type="button" className="primary-button" onClick={start} disabled={busy || !fallbackPack.length}>
              {busy ? <RefreshCw size={18} className="spin" /> : <Sparkles size={18} />}{fallbackPack.length ? 'Начать' : 'Сначала добавьте слова'}
            </button>
          </div>
        ) : (
          <>
            <div className="practice-vocabulary-strip" aria-label="Слова сессии">{vocabulary.map((entry) => <span key={entry.key}>{entry.sourceText}</span>)}</div>
            <div className="practice-messages">
              {(session.messages || []).map((message) => <PracticeMessage key={message.id} message={message} entries={entries} lookup={lookup} onWord={selectWord} />)}
              {busy && <div className="practice-typing"><span /><span /><span /></div>}
              <div ref={messagesEndRef} />
            </div>
            <div className="practice-composer">
              <textarea
                ref={composerRef}
                data-testid="practice-composer"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
                }}
                placeholder="Ответьте по-английски — сюда можно диктовать через Voice Record"
                disabled={busy}
              />
              <button data-testid="practice-send" type="button" className="practice-send" onClick={send} disabled={!draft.trim() || busy} aria-label="Отправить"><Send size={19} /></button>
            </div>
          </>
        )}
        {error && <div className="practice-error">{error}</div>}
      </div>
      <PracticeTranslator onInsert={(text) => { setDraft((value) => `${value}${value ? ' ' : ''}${text}`); requestAnimationFrame(() => composerRef.current?.focus()) }} />
      {selectedWord && <PracticeWordCard selection={selectedWord} onClose={() => setSelectedWord(null)} onChanged={refresh} />}
    </section>
  )
}

function mediaDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0)))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

function mediaBytes(value) {
  const bytes = Number(value || 0)
  if (!bytes) return ''
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`
  return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`
}

async function translateAllMediaCues(cues, onProgress) {
  const unique = []
  const seen = new Set()
  for (const cue of cues || []) {
    const text = String(cue?.text || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    unique.push({ text })
  }
  const batches = LearningUtils?.batchTexts?.(unique, 25, 5_000) || unique.map(item => [item])
  const translations = []
  let done = 0
  onProgress?.({ done, total: unique.length })
  for (const batch of batches) {
    const payload = await learningBridgeJson('/translator/translate', {
      texts: batch.map(item => item.text),
      from: 'en',
      to: 'ru',
    }, 30_000)
    translations.push(...(payload?.translations || []))
    done += batch.length
    onProgress?.({ done, total: unique.length })
  }
  return translations
}

function VideoView() {
  const stageRef = useRef(null)
  const videoRef = useRef(null)
  const videoInputRef = useRef(null)
  const subtitlesInputRef = useRef(null)
  const localObjectUrlRef = useRef('')
  const initialMediaHandledRef = useRef(false)
  const [items, setItems] = useState([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState(null)
  const [localVideo, setLocalVideo] = useState(null)
  const [localSubtitles, setLocalSubtitles] = useState(null)
  const [preparing, setPreparing] = useState(null)
  const [downloads, setDownloads] = useState({})
  const [error, setError] = useState('')

  const requestedMediaId = Number(new URLSearchParams(window.location.search).get('media') || 0)
  const requestedStartSeconds = Number(new URLSearchParams(window.location.search).get('t') || 0)

  const loadLibrary = useCallback(async () => {
    setLoading(true)
    try {
      const payload = await learningBridgeGet('/learning/media/library')
      const next = Array.isArray(payload?.items) ? payload.items : []
      setItems(next)
      setError('')
      return next
    } catch (loadError) {
      setError(loadError?.message || String(loadError))
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  const openLibraryItem = useCallback(async (item) => {
    if (!item?.videoReady) return false
    setError('')
    setPreparing({ phase: 'subtitles', done: 0, total: 0 })
    try {
      const payload = await learningBridgeGet(item.subtitlesUrl)
      const cues = LearningUtils?.finalizeCues?.(payload?.cues || []) || payload?.cues || []
      if (!cues.length) throw new Error('В английской дорожке нет таймкодированных реплик')
      setLocalVideo(null)
      setLocalSubtitles(null)
      setActive({
        identity: `boosty:${item.id}`,
        mediaId: item.id,
        title: item.title,
        author: item.author,
        sourceUrl: item.sourceUrl,
        sourceName: 'Boosty · локальное видео',
        videoUrl: `${BRIDGE}${item.videoUrl}`,
        startSeconds: requestedStartSeconds > 0 ? requestedStartSeconds : null,
        cues,
      })
      const url = new URL(window.location.href)
      url.searchParams.set('media', String(item.id))
      url.hash = 'video'
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
      return true
    } catch (openError) {
      setPreparing(null)
      setError(openError?.message || String(openError))
      return false
    }
  }, [])

  useEffect(() => {
    let activeEffect = true
    loadLibrary().then((next) => {
      if (!activeEffect || initialMediaHandledRef.current || !requestedMediaId) return
      initialMediaHandledRef.current = true
      const requested = next.find(item => Number(item.id) === requestedMediaId)
      if (requested?.videoReady) openLibraryItem(requested)
      else if (requested) setError('Видео выбрано, но полный файл ещё не скачан')
    })
    return () => { activeEffect = false }
  }, [loadLibrary, openLibraryItem, requestedMediaId])

  useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    const video = videoRef.current
    const stage = stageRef.current
    if (!video || !stage) return undefined
    ;(async () => {
      try {
        const overlay = await ensureLearningOverlayLoaded()
        if (cancelled) return
        setPreparing({ phase: 'translation', done: 0, total: active.cues.length })
        const translations = await translateAllMediaCues(active.cues, progress => {
          if (!cancelled) setPreparing({ phase: 'translation', ...progress })
        })
        if (cancelled) return
        if (video.readyState < 1) {
          await new Promise((resolve, reject) => {
            const onReady = () => { cleanup(); resolve() }
            const onError = () => { cleanup(); reject(new Error('Не удалось открыть видеофайл')) }
            const cleanup = () => {
              video.removeEventListener('loadedmetadata', onReady)
              video.removeEventListener('error', onError)
            }
            video.addEventListener('loadedmetadata', onReady, { once: true })
            video.addEventListener('error', onError, { once: true })
          })
        }
        if (cancelled) return
        const firstCueSeconds = Math.max(0, Number(active.cues[0]?.startMs || 0) / 1000 + 0.02)
        const startSeconds = Number.isFinite(Number(active.startSeconds)) && Number(active.startSeconds) > 0
          ? Number(active.startSeconds)
          : firstCueSeconds
        if (Math.abs(video.currentTime - startSeconds) > 0.05) video.currentTime = startSeconds
        if (!overlay?.openMedia) throw new Error('Интерактивный слой субтитров не загрузился')
        await overlay.openMedia({
          anchor: stage,
          video,
          id: active.identity,
          title: active.title,
          sourceUrl: active.sourceUrl,
          sourceName: active.sourceName,
          languageCode: 'en',
          trackLabel: 'English · SRT',
          cues: active.cues,
          translations,
          literalInitialAhead: 10,
          literalPrefetchAhead: 16,
          onLiteralProgress: progress => {
            if (!cancelled) setPreparing({ phase: 'literal', ...progress })
          },
        })
        setPreparing(null)
      } catch (prepareError) {
        if (!cancelled) {
          setPreparing(null)
          setError(prepareError?.message || String(prepareError))
        }
      }
    })()
    return () => {
      cancelled = true
      window.__scLearningOverlay?.closeMedia?.()
    }
  }, [active])

  useEffect(() => () => {
    window.__scLearningOverlay?.closeMedia?.()
    if (localObjectUrlRef.current) URL.revokeObjectURL(localObjectUrlRef.current)
  }, [])

  async function downloadItem(item) {
    if (!item || (downloads[item.id] && downloads[item.id].status !== 'error')) return
    setDownloads(current => ({ ...current, [item.id]: { status: 'starting', percent: 0 } }))
    setError('')
    try {
      const started = await learningBridgeJson(`/learning/media/${item.id}/download`, {})
      if (!started.ready) {
        let terminal = null
        while (!terminal) {
          await new Promise(resolve => setTimeout(resolve, 900))
          const status = await learningBridgeGet(`/learning/media/download-status?id=${encodeURIComponent(started.jobId)}`)
          const job = status.job
          const percent = Number(job?.progress?.percent || 0)
          setDownloads(current => ({ ...current, [item.id]: { status: job?.status || 'running', percent } }))
          if (job?.status === 'done') terminal = 'done'
          else if (job?.status === 'error' || job?.status === 'cancelled') throw new Error(job.error || 'Скачивание видео не завершено')
        }
      }
      const next = await loadLibrary()
      const ready = next.find(candidate => Number(candidate.id) === Number(item.id))
      if (!ready?.videoReady) throw new Error('Скачивание завершилось без локального видеофайла')
      setDownloads(current => { const copy = { ...current }; delete copy[item.id]; return copy })
      await openLibraryItem(ready)
    } catch (downloadError) {
      setDownloads(current => ({ ...current, [item.id]: { status: 'error', percent: 0 } }))
      setError(downloadError?.message || String(downloadError))
    }
  }

  async function openLocalFiles(videoFile = localVideo, subtitlesFile = localSubtitles) {
    if (!videoFile || !subtitlesFile) return
    setError('')
    setPreparing({ phase: 'subtitles', done: 0, total: 0 })
    try {
      const subtitleText = await subtitlesFile.text()
      const cues = LearningUtils?.parseVttCues?.(subtitleText) || []
      if (!cues.length) throw new Error('Не удалось прочитать таймкоды из SRT/VTT')
      if (localObjectUrlRef.current) URL.revokeObjectURL(localObjectUrlRef.current)
      const objectUrl = URL.createObjectURL(videoFile)
      localObjectUrlRef.current = objectUrl
      setActive({
        identity: `local:${videoFile.name}:${videoFile.size}:${videoFile.lastModified}`,
        title: videoFile.name.replace(/\.[^.]+$/, ''),
        author: 'Локальный файл',
        sourceUrl: window.location.href,
        sourceName: 'Локальное видео',
        videoUrl: objectUrl,
        cues,
      })
    } catch (localError) {
      setPreparing(null)
      setError(localError?.message || String(localError))
    }
  }

  function acceptFiles(fileList) {
    const files = Array.from(fileList || [])
    const videoFile = files.find(file => file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv)$/i.test(file.name)) || null
    const subtitlesFile = files.find(file => /\.(srt|vtt)$/i.test(file.name)) || null
    const nextVideo = videoFile || localVideo
    const nextSubtitles = subtitlesFile || localSubtitles
    if (videoFile) setLocalVideo(videoFile)
    if (subtitlesFile) setLocalSubtitles(subtitlesFile)
    if (nextVideo && nextSubtitles) void openLocalFiles(nextVideo, nextSubtitles)
  }

  const visibleItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru-RU')
    return items.filter(item => !needle || `${item.title} ${item.author}`.toLocaleLowerCase('ru-RU').includes(needle))
  }, [items, query])

  const preparationLabel = preparing?.phase === 'translation'
    ? `Готовлю русский перевод · ${preparing.done || 0} / ${preparing.total || 0}`
    : preparing?.phase === 'literal'
      ? `Готовлю запас дословных субтитров · ${preparing.done || 0} / ${preparing.total || 0}`
      : preparing ? 'Читаю английскую дорожку…' : ''

  return (
    <section className="workspace video-workspace" aria-label="Видео с двойными субтитрами">
      <div className="video-heading">
        <div><Clapperboard size={22} /><div><h2>Видео</h2><p>Локальное воспроизведение с интерактивными английскими и русскими субтитрами.</p></div></div>
        <button type="button" className="secondary-button" onClick={loadLibrary} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />Обновить</button>
      </div>

      <div
        className="video-dropzone"
        onDragOver={event => { event.preventDefault(); event.currentTarget.dataset.dragging = '1' }}
        onDragLeave={event => { delete event.currentTarget.dataset.dragging }}
        onDrop={event => { event.preventDefault(); delete event.currentTarget.dataset.dragging; acceptFiles(event.dataTransfer.files) }}
      >
        <Upload size={20} />
        <div><strong>Перетащите видео и SRT/VTT</strong><span>Можно выбрать файлы по отдельности.</span></div>
        <div className="video-file-actions">
          <button type="button" className="secondary-button" onClick={() => videoInputRef.current?.click()}><Play size={14} />Видео</button>
          <button type="button" className="secondary-button" onClick={() => subtitlesInputRef.current?.click()}><FileText size={14} />Субтитры</button>
        </div>
        <input ref={videoInputRef} hidden type="file" accept="video/*,.mp4,.m4v,.mov,.webm,.mkv" onChange={event => acceptFiles(event.target.files)} />
        <input ref={subtitlesInputRef} hidden type="file" accept=".srt,.vtt,text/vtt" onChange={event => acceptFiles(event.target.files)} />
      </div>

      {(localVideo || localSubtitles) && !active?.identity?.startsWith('local:') && (
        <div className="video-local-pending">
          <span>{localVideo ? `Видео: ${localVideo.name}` : 'Выберите видео'}</span>
          <span>{localSubtitles ? `Субтитры: ${localSubtitles.name}` : 'Добавьте SRT/VTT'}</span>
        </div>
      )}

      {active && (
        <div className="video-player-card">
          <div className="video-player-copy"><strong>{active.title}</strong><span>{active.author}</span></div>
          <div ref={stageRef} className="video-stage" data-testid="learning-video-stage">
            <video key={active.identity} ref={videoRef} src={active.videoUrl} controls playsInline preload="metadata" crossOrigin="anonymous" />
            {preparationLabel && <div className="video-preparing"><RefreshCw size={18} className="spin" />{preparationLabel}</div>}
          </div>
          <div className="video-player-hint">A / D или [ / ] — соседняя реплика · клик по слову — перевод и словарь</div>
        </div>
      )}

      {error && <div className="error-banner">{error}<button type="button" onClick={() => setError('')}><X size={16} /></button></div>}

      <div className="video-library-head">
        <div><strong>Boosty-медиатека</strong><span>{items.filter(item => item.videoReady).length} видео скачано · {items.filter(item => item.subtitlesReady).length} с SRT</span></div>
        <label className="search-box"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти интервью" /></label>
      </div>
      <div className="video-library" data-testid="learning-video-library">
        {loading && !items.length && <div className="page-loader"><RefreshCw className="spin" /><span>Читаю медиатеку…</span></div>}
        {!loading && !visibleItems.length && <div className="video-library-empty">Видео не найдены.</div>}
        {visibleItems.map(item => {
          const download = downloads[item.id]
          return (
            <div key={item.id} className={`video-library-row ${active?.mediaId === item.id ? 'active' : ''}`}>
              <div className="video-library-icon"><Clapperboard size={18} /></div>
              <div className="video-library-copy">
                <strong>{item.title}</strong>
                <span>{item.author} · {mediaDuration(item.durationSeconds)}{item.videoBytes ? ` · ${mediaBytes(item.videoBytes)}` : ''}</span>
                <small>{item.subtitlesReady ? 'English SRT готов' : 'Нет таймкодированных субтитров'} · {item.videoReady ? 'видео на диске' : 'есть аудио, видео можно докачать'}</small>
              </div>
              {item.videoReady ? (
                <button type="button" className="primary-button" onClick={() => openLibraryItem(item)} disabled={!item.subtitlesReady}><Play size={15} />Открыть</button>
              ) : (
                <button type="button" className="secondary-button" onClick={() => downloadItem(item)} disabled={(!!download && download.status !== 'error') || !item.subtitlesReady}>
                  {download && download.status !== 'error' ? <RefreshCw size={14} className="spin" /> : <Download size={14} />}
                  {download && download.status !== 'error' ? `${Math.round(download.percent || 0)}%` : download?.status === 'error' ? 'Повторить' : 'Скачать видео'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function SettingsView() {
  const [enabled, setEnabled] = useState(true)
  const [autoplay, setAutoplay] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    readYoutubePreferences()
      .then((preferences) => {
        if (!active) return
        setEnabled(preferences.learning_ai_explanation !== false)
        setAutoplay(preferences.learning_card_autoplay === true)
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const toggle = async () => {
    if (saving || loading) return
    const next = !enabled
    setEnabled(next)
    setSaving(true)
    setMessage('')
    try {
      const result = await patchYoutubePreferences({ learning_ai_explanation: next })
      const canonical = result?.settings?.learning_ai_explanation
      if (typeof canonical === 'boolean') setEnabled(canonical)
      setMessage(preferenceSavedMessage(result))
    } catch (error) {
      setEnabled(!next)
      setMessage(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  const toggleAutoplay = async () => {
    if (saving || loading) return
    const next = !autoplay
    setAutoplay(next)
    setSaving(true)
    setMessage('')
    try {
      const result = await patchYoutubePreferences({ learning_card_autoplay: next })
      const canonical = result?.settings?.learning_card_autoplay
      if (typeof canonical === 'boolean') setAutoplay(canonical)
      setMessage(preferenceSavedMessage(result))
    } catch (error) {
      setAutoplay(!next)
      setMessage(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="workspace settings-workspace" aria-label="Настройки словаря">
      {!REMOTE_STUDY && <div className="settings-card">
        <div className="settings-copy">
          <div className="settings-title"><Sparkles size={19} /><strong>AI-пояснение слова в контексте</strong></div>
          <p>При открытии слова в субтитрах показывать 1–2 коротких предложения о его значении именно в текущей реплике.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          className={`settings-switch ${enabled ? 'on' : ''}`}
          onClick={toggle}
          disabled={loading || saving}
        ><span /></button>
      </div>}
      <div className="settings-card">
        <div className="settings-copy">
          <div className="settings-title"><Volume2 size={19} /><strong>Автопроигрывание карточек</strong></div>
          <p>Произносить английское слово или фразу сразу после появления следующей карточки.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={autoplay}
          className={`settings-switch ${autoplay ? 'on' : ''}`}
          onClick={toggleAutoplay}
          disabled={loading || saving}
        ><span /></button>
      </div>
      <div className="settings-card compact">
        <div className="settings-copy">
          <strong>Модель</strong>
          <p>Gemini 3.1 Flash‑Lite · без инструментов агента · успешные ответы кэшируются локально на Mac.</p>
        </div>
      </div>
      {message && <div className="settings-message">{message}</div>}
    </section>
  )
}

function App() {
  const routeFromLocation = () => {
    if (!REMOTE_STUDY && (window.location.hash === '#video' || new URLSearchParams(window.location.search).has('media'))) return 'video'
    if (window.location.hash === '#session') return 'session'
    if (window.location.hash === '#cards') return 'cards'
    if (window.location.hash === '#dictionary') return 'dictionary'
    if (!REMOTE_STUDY && window.location.hash === '#practice') return 'practice'
    if (window.location.hash === '#settings') return 'settings'
    return 'cards'
  }
  const [tab, setTab] = useState(() => {
    return routeFromLocation()
  })
  const [entries, setEntries] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const learnedPercent = stats?.total ? Math.round((stats.known / stats.total) * 100) : 0
  const chooseTab = (nextTab) => {
    setTab(nextTab)
    window.history.replaceState(null, '', `#${nextTab}`)
  }

  useEffect(() => {
    if (!REMOTE_STUDY) return undefined
    const applyHash = () => setTab(routeFromLocation())
    window.addEventListener('hashchange', applyHash)
    return () => window.removeEventListener('hashchange', applyHash)
  }, [])

  useEffect(() => {
    const sessionActive = EMBEDDED_STUDY && tab === 'session'
    document.documentElement.classList.toggle('study-session-active', sessionActive)
    document.body.classList.toggle('study-session-active', sessionActive)
    notifyNativeStudyRoute(tab)
    return () => {
      document.documentElement.classList.remove('study-session-active')
      document.body.classList.remove('study-session-active')
    }
  }, [tab])

  const readLocal = useCallback(async () => {
    const [nextEntries, nextStats] = await Promise.all([
      store.listEntries({}),
      store.stats({}),
    ])
    setEntries(nextEntries)
    setStats(nextStats)
    setLoading(false)
  }, [])

  const refresh = useCallback(async ({ sync = false } = {}) => {
    await readLocal()
    if (!sync) return
    setSyncing(true)
    try {
      await store.sync({})
      setError('')
    } catch (syncError) {
      setError(syncError?.message || String(syncError))
    } finally {
      setSyncing(false)
      await readLocal()
    }
  }, [readLocal])

  useEffect(() => {
    let active = true
    const unsubscribe = store.subscribe(() => {
      if (active) readLocal().catch(() => {})
    })
    ;(async () => {
      try {
        await store.migrateLegacy({})
        if (!active) return
        await readLocal()
        setSyncing(true)
        await store.sync({})
        if (active) await readLocal()
      } catch (loadError) {
        if (active) setError(loadError?.message || String(loadError))
      } finally {
        if (active) { setLoading(false); setSyncing(false) }
      }
    })()
    return () => { active = false; unsubscribe() }
  }, [readLocal])

  if (!store) return <div className="fatal">Словарь не загрузился.</div>

  return (
    <div className={`app-shell tab-${tab} ${REMOTE_STUDY ? 'remote-study' : ''} ${EMBEDDED_STUDY ? 'embedded-study' : ''}`}>
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Sparkles size={22} /></div><div><h1>Словарь / Карточки</h1><p>{REMOTE_STUDY ? 'Общая база Voice Record на Mac' : 'Работает офлайн и синхронизируется через Voice Record'}</p></div></div>
        <SyncBadge stats={stats} syncing={syncing} onSync={() => refresh({ sync: true })} />
      </header>
      {!EMBEDDED_STUDY && <div className="summary">
        <div><span>В словаре</span><strong>{stats?.saved || 0}</strong></div>
        <div><span>Знаю</span><strong>{stats?.known || 0}</strong></div>
        <div><span>К повторению</span><strong>{stats?.due || 0}</strong></div>
        <div><span>Освоено</span><strong>{learnedPercent}%</strong></div>
      </div>}
      {!EMBEDDED_STUDY && <nav className="tabs" aria-label="Разделы">
        <button type="button" className={tab === 'dictionary' ? 'active' : ''} onClick={() => chooseTab('dictionary')}><BookOpen size={18} />Словарь</button>
        <button type="button" className={tab === 'cards' || tab === 'session' ? 'active' : ''} onClick={() => chooseTab('cards')}><Sparkles size={18} />Карточки{(stats?.saved || 0) > 0 && <strong>{stats.saved}</strong>}</button>
        {!REMOTE_STUDY && <button type="button" className={tab === 'video' ? 'active' : ''} onClick={() => chooseTab('video')}><Clapperboard size={18} />Видео</button>}
        {!REMOTE_STUDY && <button type="button" className={tab === 'practice' ? 'active' : ''} onClick={() => chooseTab('practice')}><MessageCircle size={18} />Практика</button>}
        <button type="button" className={tab === 'settings' ? 'active' : ''} onClick={() => chooseTab('settings')}><Settings size={18} />Настройки</button>
      </nav>}
      {error && <div className="error-banner">{error}<button type="button" onClick={() => setError('')}><X size={16} /></button></div>}
      {loading ? <div className="page-loader"><RefreshCw className="spin" /><span>Открываю локальную базу…</span></div> : tab === 'dictionary'
        ? <DictionaryView entries={entries} refresh={refresh} />
        : tab === 'cards'
          ? <DeckOverview entries={entries} stats={stats} onStart={() => chooseTab('session')} />
          : tab === 'session'
            ? <DeckView entries={entries} refresh={refresh} onExit={() => chooseTab('cards')} />
          : tab === 'video'
            ? <VideoView />
          : tab === 'practice'
            ? <PracticeView entries={entries} refresh={refresh} />
            : <SettingsView />}
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
