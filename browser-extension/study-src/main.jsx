import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal, flushSync } from 'react-dom'
import {
  BookOpen,
  ArrowLeftRight,
  ArrowLeft,
  ArrowRight,
  SkipForward,
  Archive,
  Check,
  CheckCircle2,
  CalendarDays,
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
import '../vendor/ts-fsrs-5.4.1.js'
import '../study-state.js'
import '../review-scheduler.js'
import '../learning-store.js'
import '../learning-save-state.js'
import '../learning-word-gesture.js'
import '../study-model.js'
import '../study-feed.js'
import '../youtube-learning-utils.js'
import '../learning-phrase-composition.js'
import '../learning-choices-popover.js'
import './study.css'

const extensionStore = window.__scLearningStore
const StudyModel = window.__scStudyModel
const StudyFeed = window.__scStudyFeed
const StudyState = window.__scStudyState
const StudyPreferencesContext = React.createContext({ showSupport: true, maskExampleAnswer: true })
const LearningUtils = window.__scYtLearningUtils
const PhraseComposition = window.__scPhraseComposition
const Lexeme = window.__scEnglishLexeme
const vocabularySaves = window.__scCreateVocabularySaveObserver(payload => learningBridgeJson('/learning/catalogue', payload, 600_000))
const WordCardContext = React.createContext(null)

function useVocabularySaveState(word, lemma) {
  const [, rerender] = useState(0)
  useEffect(() => vocabularySaves.subscribe(() => rerender(value => value + 1)), [])
  return vocabularySaves.get(word, lemma)
}
const BRIDGE = 'http://127.0.0.1:53127'
const REMOTE_STUDY = /^https?:$/.test(window.location.protocol)
const NATIVE_STUDY = !REMOTE_STUDY && !!window.webkit?.messageHandlers?.studyNative
const HOSTED_STUDY = REMOTE_STUDY || NATIVE_STUDY
const EMBEDDED_STUDY = new URLSearchParams(window.location.search).get('embed') === '1'
let nativePracticeStateRevision = 0
if (NATIVE_STUDY) { window.__scStudyPracticeSessionId = 0; window.__scStudyPracticeDraftEpoch = 0 }

function nativeStudyDocumentId() {
  const id = window.__scStudyDocumentId
  return NATIVE_STUDY && typeof id === 'string' && id.length > 0
    && window.__scStudyNativeDocumentId === id ? id : ''
}

function postNativeStudyMessage(name, payload) {
  const documentId = nativeStudyDocumentId()
  if (!documentId) return false
  window.webkit?.messageHandlers?.[name]?.postMessage({ ...payload, version: 2, documentId })
  return true
}

function useNativeDocumentRevision() {
  const [revision, setRevision] = useState(() => nativeStudyDocumentId() ? 1 : 0)
  useEffect(() => {
    if (!NATIVE_STUDY) return undefined
    const ready = event => {
      if (event.detail?.version === 2 && event.detail.documentId === nativeStudyDocumentId()) setRevision(value => value + 1)
    }
    window.addEventListener('sc-study-document-ready', ready)
    const documentId = window.__scStudyDocumentId
    if (typeof documentId === 'string' && documentId) {
      window.webkit?.messageHandlers?.studyDocument?.postMessage({ version: 2, documentId })
    }
    return () => window.removeEventListener('sc-study-document-ready', ready)
  }, [])
  return revision
}
const REMOTE_TOKEN_KEY = 'voice-study-token-v1'
const REMOTE_PREFERENCES_KEY = 'voice-study-preferences-v1'
const NATIVE_PRACTICE_DRAFT_KEY = 'voice-study-native-practice-draft-v1'
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
      throw Object.assign(new Error(payload?.error || (response.status >= 500 ? 'Voice Record на Mac недоступен' : `Voice Record HTTP ${response.status}`)), { status: response.status })
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
    expressionType: item.expressionType || item.senseCatalog?.expressionType || '',
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
    senses: Array.isArray(item.senses) ? item.senses : [],
    senseCatalog: item.senseCatalog || null,
    createdAt: Number(item.createdAt || 0),
    updatedAt: Number(item.updatedAt || 0),
    stateUpdatedAt: Number(item.stateUpdatedAt || item.updatedAt || 0),
    translationUpdatedAt: Number(item.translationUpdatedAt || item.updatedAt || 0),
    dueAt: item.dueAt || new Date().toISOString(),
    reviewSchedule: item.reviewSchedule || null,
    lastReviewedAt: item.lastReviewedAt || null,
    lastPracticedAt: item.lastPracticedAt || null,
    reviewCount: Number(item.reviewCount || 0),
    rememberedCount: Number(item.rememberedCount || 0),
    forgottenCount: Number(item.forgottenCount || 0),
    partialCount: Number(item.partialCount || 0),
    practiceCount: Number(item.practiceCount || 0),
    practiceRememberedCount: Number(item.practiceRememberedCount || 0),
    practiceForgottenCount: Number(item.practiceForgottenCount || 0),
    practicePartialCount: Number(item.practicePartialCount || 0),
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
  let writeVersion = 0
  const notify = () => { for (const listener of listeners) { try { listener({ type: 'remote-changed' }) } catch {} } }
  const replace = (entry) => {
    writeVersion += 1
    entries = [entry, ...entries.filter(item => item.key !== entry.key)]
    fetchedAt = Date.now()
    notify()
    return entry
  }
  const load = async (force = false) => {
    if (!force && entries.length && Date.now() - fetchedAt < 1_000) return entries
    if (inflight) {
      try { await inflight } catch (error) { if (!force) throw error }
      // A completion-triggered refresh must start after that completion,
      // rather than inheriting a GET that began before the Save committed.
      return force ? load(true) : entries
    }
    const requestedVersion = writeVersion
    inflight = remoteApi('/api/vocabulary?limit=5000&includeInactive=1')
      .then(payload => {
        if (requestedVersion === writeVersion) entries = (payload?.items || []).map(remoteEntry).filter(Boolean)
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
    ...(payload?.senseCatalog ? { senseCatalog: payload.senseCatalog } : {}),
  })
  return {
    normalizeTerm: normalizeRemoteTerm,
    subscribe(listener) { listeners.add(listener); const stop = extensionStore.subscribe(listener); return () => { listeners.delete(listener); stop() } },
    getStudyState: payload => extensionStore.getStudyState(payload),
    studyAction: payload => extensionStore.studyAction(payload),
    async migrateLegacy() { return { migrated: 0, already: true } },
    async sync() {
      const pending = await extensionStore.studySyncPayload({})
      const activity = await remoteApi('/api/vocabulary/study-state', { method: 'POST', body: pending })
      await extensionStore.applyStudySync(activity)
      await load(true)
      return { online: true, items: entries, ...activity }
    },
    async listEntries() { return [...await load()] },
    async stats() {
      const items = await load()
      const now = Date.now()
      const active = items.filter(item => item.state !== 'none')
      return {
        total: active.filter(item => item.state === 'saved' || item.state === 'known').length,
        saved: active.filter(item => item.state === 'saved').length,
        known: active.filter(item => item.state === 'known').length,
        archived: active.filter(item => item.state === 'archived').length,
        due: active.filter(item => StudyModel.isAvailable(item, now)).length,
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
      const id = itemId(existing || payload)
      // Read projections and stale screen fields are not write commands. A
      // state action must preserve translations, the catalogue and scheduling.
      const body = id ? { state: nextState } : { ...mutationBody(payload), state: nextState }
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
    async queueReview({ key, result, mode, durationMs, recallVersion, trace, meaningRecall }) {
      const before = entries.find(item => item.key === key) || await this.getEntry({ key })
      const operationId = `web-review-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      const payload = await remoteApi(`/api/vocabulary/${encodeURIComponent(key)}/review`, {
        method: 'POST', body: { result, mode, operationId, reviewedAt: Date.now(), durationMs, recallVersion, trace, meaningRecall },
      })
      const entry = replace(remoteEntry(payload.item))
      return { entry, operation: { id: operationId }, entryBefore: before }
    },
    async queueSkip({ key }) {
      const before = entries.find(item => item.key === key) || await this.getEntry({ key })
      const operation = { id: `web-skip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, type: 'skip', skippedAt: Date.now() }
      const payload = await remoteApi(`/api/vocabulary/${encodeURIComponent(key)}/skip`, {
        method: 'POST', body: { operationId: operation.id, skippedAt: operation.skippedAt },
      })
      const entry = replace(remoteEntry(payload.item))
      return { entry, operation, entryBefore: before }
    },
    async undoSkip({ key, operation }) {
      const payload = await remoteApi(`/api/vocabulary/${encodeURIComponent(key)}/skip/undo`, {
        method: 'POST', body: { operationId: operation.id },
      })
      return replace(remoteEntry(payload.item))
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

async function nativeStudyRequest(path, { method = 'GET', body } = {}) {
  const handler = window.webkit?.messageHandlers?.studyNative
  if (!handler?.postMessage) throw new Error('Локальная копия карточек недоступна')
  // Match the HTTP JSON wire format before crossing WebKit's native boundary.
  // Raw NaN/Infinity NSNumber values can raise an Objective-C exception in Swift JSONSerialization.
  const message = JSON.parse(JSON.stringify({ kind: 'request', path, method,
    ...(body === undefined ? {} : { body }) }))
  const payload = await handler.postMessage(message)
  if (!payload || payload.ok === false) {
    const error = new Error(payload?.error || 'iOS не вернул данные карточек')
    if (Number.isFinite(Number(payload?.status))) error.status = Number(payload.status)
    throw error
  }
  return payload
}

async function learningBridgeJson(path, body, timeoutMs = 45_000) {
  const readAction = { '/translator/dictionary': 'dictionary', '/translator/examples': 'examples', '/translator/translate': 'translate' }[path]
  if (readAction) { path = '/learning/catalogue'; body = { ...body, action: readAction } }
  if (NATIVE_STUDY) return nativeStudyRequest(path, { method: 'POST', body })
  if (REMOTE_STUDY) {
    if (path === '/learning/practice') {
      return remoteApi('/api/desktop/vocabulary-practice', { method: 'POST', body }, timeoutMs)
    }
    if (path === '/learning/catalogue') {
      return remoteApi('/api/desktop/learning-catalogue', { method: 'POST', body }, timeoutMs)
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
    if (!response.ok || payload?.ok === false) throw Object.assign(new Error(payload?.error || `SC Desktop HTTP ${response.status}`), { status: response.status })
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
  if (NATIVE_STUDY) return nativeStudyRequest(path)
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

const practiceQuickTranslations = new Map()
const practiceQuickTranslationPending = new Set()

function practiceQuickTranslationKey(word) {
  return store.normalizeTerm(word)
}

function fixedPracticeQuickRows(word) {
  const normalized = practiceQuickTranslationKey(word)
  if (normalized === 'the') return [{ value: 'определённый артикль', partOfSpeech: '' }]
  if (normalized === 'a' || normalized === 'an') return [{ value: 'неопределённый артикль', partOfSpeech: '' }]
  return []
}

function practiceQuickRows(word, entry = null) {
  const key = practiceQuickTranslationKey(word)
  const fallbacks = [
    ...fixedPracticeQuickRows(word),
    ...(practiceQuickTranslations.get(key) || []),
    entry?.translation || '',
  ]
  return LearningUtils?.quickWordTranslationRows?.(null, fallbacks, 1, word) || []
}

async function prefetchPracticeQuickTranslations(texts) {
  const queued = []
  const seen = new Set()
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    for (const part of LearningUtils?.segmentWords?.(String(text || ''), 'en') || []) {
      if (!part.word || seen.has(part.normalized)) continue
      seen.add(part.normalized)
      const key = practiceQuickTranslationKey(part.text)
      const fixed = fixedPracticeQuickRows(part.text)
      if (fixed.length) {
        practiceQuickTranslations.set(key, fixed)
        continue
      }
      if (!key || practiceQuickTranslations.has(key) || practiceQuickTranslationPending.has(key)) continue
      practiceQuickTranslationPending.add(key)
      queued.push({ key, source: part.text, text: part.normalized || part.text })
    }
  }
  if (!queued.length) return false
  if (HOSTED_STUDY) {
    for (const item of queued) {
      practiceQuickTranslations.set(item.key, [{ value: item.source, partOfSpeech: '' }])
      practiceQuickTranslationPending.delete(item.key)
    }
    return true
  }
  try {
    for (let offset = 0; offset < queued.length; offset += 25) {
      const batch = queued.slice(offset, offset + 25)
      const payload = await learningBridgeJson('/translator/translate', {
        texts: batch.map((item) => item.text),
        from: 'en',
        to: 'ru',
      }, 20_000)
      for (const item of payload?.translations || []) {
        const key = practiceQuickTranslationKey(item.source_text)
        const value = String(item.translated_text || '').trim()
        if (key && value) practiceQuickTranslations.set(key, [{ value, partOfSpeech: '' }])
      }
      for (const item of batch) {
        if (!practiceQuickTranslations.has(item.key)) {
          practiceQuickTranslations.set(item.key, [{ value: item.source, partOfSpeech: '' }])
        }
      }
    }
    return true
  } catch {
    for (const item of queued) {
      if (!practiceQuickTranslations.has(item.key)) {
        practiceQuickTranslations.set(item.key, [{ value: item.source, partOfSpeech: '' }])
      }
    }
    return false
  } finally {
    for (const item of queued) practiceQuickTranslationPending.delete(item.key)
  }
}

function practiceMessageId(prefix = 'practice') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function readRemoteYoutubePreferences() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(REMOTE_PREFERENCES_KEY) || '{}')
    return {
      learning_ai_explanation: stored.learning_ai_explanation !== false,
      learning_card_autoplay: stored.learning_card_autoplay === true,
      learning_practice_hide_translations: stored.learning_practice_hide_translations !== false,
      learning_hover_word_translation: stored.learning_hover_word_translation === true,
    }
  } catch {
    return { learning_ai_explanation: true, learning_card_autoplay: false, learning_practice_hide_translations: true, learning_hover_word_translation: false }
  }
}

function readYoutubePreferences() {
  if (NATIVE_STUDY) return nativeStudyRequest('/learning/preferences', {
    method: 'POST', body: { legacy: readRemoteYoutubePreferences() },
  }).then(result => result.settings)
  if (HOSTED_STUDY) return Promise.resolve(readRemoteYoutubePreferences())
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) {
    return Promise.resolve({ learning_ai_explanation: true, learning_card_autoplay: false, learning_practice_hide_translations: true, learning_hover_word_translation: false })
  }
  return new Promise((resolve) => {
    chrome.storage.sync.get({ __yt: { learning_ai_explanation: true, learning_card_autoplay: false, learning_practice_hide_translations: true, learning_hover_word_translation: false } }, (raw) => {
      const settings = raw?.__yt && typeof raw.__yt === 'object' ? raw.__yt : {}
      resolve({
        learning_ai_explanation: settings.learning_ai_explanation !== false,
        learning_card_autoplay: settings.learning_card_autoplay === true,
        learning_practice_hide_translations: settings.learning_practice_hide_translations !== false,
        learning_hover_word_translation: settings.learning_hover_word_translation === true,
      })
    })
  })
}

function patchYoutubePreferences(patch) {
  if (NATIVE_STUDY) return nativeStudyRequest('/learning/preferences', { method: 'POST', body: { patch } })
  if (HOSTED_STUDY) {
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

let learningSpeechRequestId = 0
const LEARNING_SPEECH_VOICE_WAIT_MS = 1_200

function waitForLearningSpeechVoice(synthesis, language) {
  const select = () => LearningUtils?.preferredEnglishSpeechVoice?.(synthesis.getVoices(), language) || null
  try {
    const voice = select()
    if (voice || synthesis.getVoices().length > 0) return Promise.resolve(voice)
  } catch {
    return Promise.resolve(null)
  }
  if (typeof synthesis.addEventListener !== 'function') return Promise.resolve(null)
  return new Promise((resolve) => {
    let timer = null
    const finish = (voice = null) => {
      if (timer !== null) clearTimeout(timer)
      synthesis.removeEventListener?.('voiceschanged', onVoicesChanged)
      resolve(voice)
    }
    const onVoicesChanged = () => {
      try {
        const voice = select()
        if (voice || synthesis.getVoices().length > 0) finish(voice)
      } catch {
        finish(null)
      }
    }
    synthesis.addEventListener('voiceschanged', onVoicesChanged)
    timer = setTimeout(() => {
      try { finish(select()) } catch { finish(null) }
    }, LEARNING_SPEECH_VOICE_WAIT_MS)
  })
}

function speakLearningText(text) {
  const value = String(text || '').trim()
  if (NATIVE_STUDY) {
    try {
      window.webkit.messageHandlers.studyNative.postMessage({ kind: 'speak', text: value })
      return Boolean(value)
    } catch { return false }
  }
  if (!value || typeof speechSynthesis === 'undefined') return false
  try {
    const requestId = ++learningSpeechRequestId
    speechSynthesis.cancel()
    const desktopChromium = LearningUtils?.isDesktopChromiumSpeech?.(navigator.userAgent)
    const speak = (voice = null) => {
      if (requestId !== learningSpeechRequestId) return
      const utterance = new SpeechSynthesisUtterance(value)
      utterance.lang = 'en-US'
      if (voice) utterance.voice = voice
      if (desktopChromium) utterance.rate = 0.85
      speechSynthesis.speak(utterance)
    }
    if (desktopChromium) {
      waitForLearningSpeechVoice(speechSynthesis, 'en-US').then(speak).catch(() => speak(null))
    } else {
      speak()
    }
    return true
  } catch {
    return false
  }
}

function notifyNativeStudyCardGesture(active) {
  if (!HOSTED_STUDY || !EMBEDDED_STUDY) return
  try {
    postNativeStudyMessage('studyCardGesture', { active: Boolean(active) })
  } catch {}
}

function notifyNativeStudyRoute(route) {
  if (!HOSTED_STUDY || !EMBEDDED_STUDY) return
  try {
    postNativeStudyMessage('studyRouteChanged', { route: String(route || 'cards') })
  } catch {}
}

function notifyNativeStudyDebug(message) {
  if (!NATIVE_STUDY || !EMBEDDED_STUDY) return
  try {
    window.webkit?.messageHandlers?.studyDebug?.postMessage({ message: String(message || '') })
  } catch {}
}

// WKWebView may freeze or drop ordinary timers while the host app leaves the
// foreground. A review must never leave its only card translated off-screen.
// Lifecycle events finish the visual delay immediately; the ordinary timer
// still provides the full animation while the page remains active.
function waitForStudyCardExit(duration = 210) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (reason) => {
      if (settled) return
      settled = true
      if (timer) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('freeze', onFreeze)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      resolve(reason)
    }
    const onVisibility = () => finish(`visibility-${document.visibilityState}`)
    const onFreeze = () => finish('freeze')
    const onPageHide = () => finish('pagehide')
    const onPageShow = () => finish('pageshow')
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('freeze', onFreeze)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    if (document.visibilityState === 'hidden') queueMicrotask(() => finish('hidden-start'))
    timer = window.setTimeout(() => finish('timer'), duration)
  })
}

function stateLabel(state) {
  if (state === 'archived') return 'В архиве'
  if (state === 'known') return 'Не учу'
  if (state === 'saved') return 'В словаре'
  return 'Без отметки'
}

const PART_OF_SPEECH_LABELS = {
  noun: 'сущ.',
  verb: 'гл.',
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
  return PART_OF_SPEECH_LABELS[String(value || '').trim().toLocaleLowerCase('en-US')] || ''
}

function entryPartOfSpeechLabel(entry, overview = StudyModel.buildSenseOverview(entry)) {
  if (entry?.kind === 'phrase') return ''
  const labels = [
    ...(Array.isArray(entry?.partsOfSpeech) ? entry.partsOfSpeech : []),
    entry?.partOfSpeech,
    ...((overview?.senses || []).map((sense) => sense.partOfSpeech)),
  ].map(partOfSpeechLabel).filter(Boolean)
  return Array.from(new Set(labels)).join(', ')
}

function expressionTypeLabel(value) {
  return EXPRESSION_TYPE_LABELS[value] || ''
}

function ExpressionBadge({ entry }) {
  const type = entry?.expressionType || entry?.senseCatalog?.expressionType
  const label = type === 'phrasal_verb' ? 'фраз. гл.' : type === 'function_phrase' ? 'служ. выраж.' : type === 'idiom' ? 'идиома'
    : entry?.kind === 'phrase' ? 'выражение' : ''
  return label ? <span className="study-expression-type" title={expressionTypeLabel(type) || 'Выражение'}>{label}</span> : null
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

async function scheduleKnownEntry(entry) {
  if (!entry) return null
  let active = entry
  if (active.state !== 'saved') {
    active = await store.setState({ ...active, state: 'saved', toggle: false })
  }
  const units = StudyModel.buildReviewUnits([active])
  let updated = active
  for (const unit of units) {
    const result = await store.queueReview({
      key: active.key,
      result: 'known',
      mode: 'scheduled',
    })
    updated = result?.entry || updated
  }
  store.sync({}).catch(() => {})
  return updated
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

function entrySenseSummaries(entry, overview = StudyModel.buildSenseOverview(entry)) {
  return [
    ...(overview?.senses || []).map((sense) => ({
      id: sense.id,
      meaning: sense.meaning || sense.shortMeaning,
      partOfSpeech: sense.partOfSpeech || 'unknown',
      support: false,
    })),
    ...(overview?.support || []).map((sense) => ({
      id: sense.id,
      meaning: sense.meaning || sense.shortMeaning,
      partOfSpeech: sense.partOfSpeech || 'unknown',
      support: true,
    })),
  ].filter((sense) => sense.meaning)
}

function HighlightedExampleText({ segments, onReveal = null, revealLabel = 'Показать скрытый перевод в примере' }) {
  return (segments || []).map((segment, index) => segment.active
    ? (LearningUtils.segmentWords(segment.text, 'ru') || []).map((part, wordIndex) => part.word
      ? <mark key={`${segment.start}-${index}-${wordIndex}`} onClick={onReveal ? event => {
          event.preventDefault(); event.stopPropagation(); onReveal()
        } : undefined}>{onReveal
          ? <button type="button" className="study-example-answer-mask" aria-label={revealLabel}>{part.text}</button>
          : part.text}</mark>
      : <React.Fragment key={`${segment.start}-${index}-${wordIndex}`}>{part.text}</React.Fragment>)
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
  resolveTranslations = true,
  targetMeaning = entry?.translation,
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
    if (!resolveTranslations) return () => { active = false }
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
  }, [entry?.key, contextSignature, resolveTranslations])

  useEffect(() => {
    setExpandedRows({})
  }, [entry?.key, contextSignature, showTarget])

  if (!contexts.length) return null
  const sourceTerms = entrySourceTerms(entry)
  const targetTerms = [targetMeaning].filter(Boolean)
  return (
    <div className="learning-examples">
      {contexts.map((context, index) => {
        const translated = resolved[index]
        const presentation = LearningUtils.learningExamplePresentation({
          sourceText: context.sourceText,
          ...StudyModel.exampleTranslation(context, translated),
          sourceTerms,
          targetTerms: [context.meaning, ...targetTerms].filter(Boolean),
          sourceLanguage: entry?.sourceLang || 'en',
          targetLanguage: entry?.targetLang || 'ru',
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
              {expanded && (presentation.targetText || !resolveTranslations) && (
                <div className="learning-example-detail-row" data-selectable-text>
                  {presentation.targetText
                    ? <HighlightedExampleText segments={presentation.targetSegments} />
                    : <span className="study-example-missing">Перевод примера ещё не сохранён</span>}
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

function AddEntry({ onChanged, home = false, request, searchTerm = '', noMatches = false }) {
  const [open, setOpen] = useState(!!request)
  const [term, setTerm] = useState(request?.term || '')
  const [phase, setPhase] = useState('input')
  const [prepared, setPrepared] = useState(null)
  const [resolution, setResolution] = useState(null)
  const [resolvedExpression, setResolvedExpression] = useState('')
  const [keepExpression, setKeepExpression] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)
  const busyRef = useRef(false)
  const busy = phase === 'preparing' || phase === 'saving'
  const previewEntry = useMemo(() => {
    if (prepared?.item) return remoteEntry(prepared.item)
    if (!prepared?.preview) return null
    const { input, catalogue } = prepared.preview
    return StudyModel.catalogueDisplayEntry({ sourceText: input.term, lemma: input.term, kind: input.kind || catalogue.kind,
      expressionType: input.expressionType || catalogue.expressionType || '',
      sourceLang: 'en', targetLang: 'ru', senseCatalog: catalogue }, catalogue)
  }, [prepared])
  const overview = useMemo(() => StudyModel.buildSenseOverview(previewEntry), [previewEntry])

  useEffect(() => () => { requestRef.current += 1 }, [])
  const close = () => {
    requestRef.current += 1
    busyRef.current = false
    setOpen(false)
    setPhase('input')
    setPrepared(null)
    setResolution(null)
    setResolvedExpression('')
    setKeepExpression(false)
    setError('')
  }

  const prepareTerm = async (value = term) => {
    if (!value.trim() || busyRef.current || prepared || (resolution && !resolvedExpression)) return
    const requestId = ++requestRef.current
    busyRef.current = true
    setPhase('preparing')
    setPrepared(null)
    setError('')
    try {
      const result = await learningBridgeJson('/learning/catalogue', { action: 'prepare', word: value.trim(),
        ...(resolution ? { resolvedExpression, ...(keepExpression ? { keepExpression: true } : {}) } : {}) }, 600_000)
      if (requestId !== requestRef.current) return
      if (result.resolutionRequired) {
        if (!result.resolution || !Array.isArray(result.resolution.candidates)) throw new Error('Сервер не вернул варианты уточнения.')
        setResolution(result.resolution)
        setResolvedExpression('')
        setKeepExpression(false)
        setPhase('input')
        return
      }
      if (!result.preview && !result.item) throw new Error('Сервер не вернул карточку.')
      setPrepared(result)
      setResolution(null)
      setPhase('preview')
    } catch (cause) {
      if (requestId !== requestRef.current) return
      setError(`Не удалось подготовить карточку. ${cause.message || 'Повторите попытку.'}`)
      setPhase('input')
    } finally {
      if (requestId === requestRef.current) busyRef.current = false
    }
  }

  const confirm = async () => {
    if (!prepared?.preview || busyRef.current) return
    const requestId = ++requestRef.current
    busyRef.current = true
    setPhase('saving')
    setError('')
    try {
      const result = await learningBridgeJson('/learning/catalogue', { action: 'confirm', preview: prepared.preview }, 30_000)
      if (requestId !== requestRef.current) return
      setTerm('')
      close()
      await onChanged({ sync: true })
    } catch (cause) {
      if (requestId !== requestRef.current) return
      setError(`Не удалось добавить карточку. ${cause.message || 'Повторите попытку.'}`)
      setPhase('preview')
    } finally {
      if (requestId === requestRef.current) busyRef.current = false
    }
  }

  if (!open) {
    return <div className={`manual-entry ${home ? 'on-home' : ''}`}>
      <button type="button" className={home ? 'secondary-button add-word-button' : 'primary-button'} onClick={() => {
        setOpen(true)
        if (noMatches && searchTerm.trim()) { setTerm(searchTerm.trim()); void prepareTerm(searchTerm.trim()) }
      }}>
        <Plus size={18} />Добавить
      </button>
    </div>
  }
  return (
    <div className={`manual-entry expanded ${home ? 'on-home' : ''}`}>
      <form className="manual-entry-form" onSubmit={event => { event.preventDefault(); void prepareTerm() }}>
        <label>Слово или выражение
          <input autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false} value={term} disabled={busy}
            onChange={event => { setTerm(event.target.value); setPrepared(null); setResolution(null); setResolvedExpression(''); setKeepExpression(false); setPhase('input'); setError('') }}
            placeholder="Например: schedule или make money" />
        </label>
        {resolution && <fieldset className="manual-entry-resolution" disabled={busy}>
          <legend>Уточните выражение</legend>
          {resolution.reason && <p>{resolution.reason}</p>}
          {[...new Map(resolution.candidates.filter(candidate => candidate?.canonical)
            .map(candidate => [candidate.canonical, candidate])).values()].map(candidate => <label key={candidate.canonical}>
            <input type="radio" name="expression-resolution" value={candidate.canonical} checked={!keepExpression && resolvedExpression === candidate.canonical}
              onChange={() => { setResolvedExpression(candidate.canonical); setKeepExpression(false) }} />
            <span><strong>{candidate.canonical}</strong> <ExpressionBadge entry={{ kind: 'phrase', expressionType: candidate.expressionType }} />
              {candidate.label && <small>{candidate.label}</small>}</span>
          </label>)}
          <label>
            <input type="radio" name="expression-resolution" value="keep-whole-expression" checked={keepExpression}
              onChange={() => { setResolvedExpression(term.trim()); setKeepExpression(true) }} />
            <span>Оставить целиком: <strong>{term.trim()}</strong></span>
          </label>
        </fieldset>}
        <div className="manual-entry-actions">
          {!prepared && <button type="submit" className="primary-button" disabled={!term.trim() || busy || (!!resolution && !resolvedExpression)}>
            {phase === 'preparing' ? <><RefreshCw size={16} className="spin" />Готовим карточку…</> : resolution ? 'Продолжить' : 'Подготовить карточку'}
          </button>}
          <button type="button" className="secondary-button" disabled={phase === 'saving'} onClick={close}>Отмена</button>
        </div>
      </form>
      {error && <p className="manual-entry-error" role="alert">{error}</p>}
      {previewEntry && <section className="manual-entry-preview" aria-label="Предпросмотр карточки">
        {prepared.existing && <p className="manual-entry-notice" role="status">{previewEntry.state === 'archived'
          ? 'Уже находится в архиве'
          : `Уже есть в словаре${previewEntry.state === 'known' ? ' · Не учу' : ''}`}</p>}
        <div className="manual-entry-preview-header"><div className="study-term-heading"><h3>{previewEntry.sourceText}</h3><ExpressionBadge entry={previewEntry} /></div>
          <button type="button" className="icon-button" aria-label="Произнести слово" onClick={() => speakLearningText(previewEntry.sourceText)}><Volume2 size={18} /></button>
        </div>
        <StudyMeaningSummary senses={overview.senses} support={overview.support} catalogue={previewEntry.senseCatalog} revealed />
        <StudyCatalogueExamples entry={previewEntry} overview={overview} revealed />
        {prepared.preview
          ? <button type="button" className="primary-button confirm-word-button" onClick={confirm} disabled={busy}>
            <Check size={18} />{phase === 'saving' ? 'Добавляем…' : 'Подтвердить добавление'}
          </button>
          : <button type="button" className="secondary-button" onClick={close}>Готово</button>}
      </section>}
    </div>
  )
}

function preferredTranslationValues(group) {
  const seen = new Set()
  return [group?.shortMeaning, ...(Array.isArray(group?.alternatives) ? group.alternatives : [])]
    .filter(value => typeof value === 'string')
    .map(value => value.normalize('NFKC').replace(/\s+/g, ' ').trim())
    .filter(value => {
      const key = value.toLocaleLowerCase('ru-RU')
      if (!value || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function editableTranslationGroups(item) {
  const catalog = item?.senseCatalog
  const seen = new Set()
  return [
    ...(catalog?.groups || []).map(group => ({ ...group, support: false })),
    ...(catalog?.supportGroups || []).map(group => ({ ...group, support: true })),
  ].filter(group => {
    if (!group?.id || seen.has(group.id)) return false
    seen.add(group.id)
    return true
  })
}

function TranslationEditor({ entry, onChanged, onClose, onSaved }) {
  const dialogRef = useRef(null)
  const requestRef = useRef(0)
  const busyRef = useRef(false)
  const entryIdRef = useRef(entry.remoteId || (REMOTE_STUDY ? entry.key : ''))
  const savedRef = useRef(null)
  const [source, setSource] = useState(null)
  const [groupId, setGroupId] = useState('')
  const [draft, setDraft] = useState('')
  const [phase, setPhase] = useState('loading')
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const groups = useMemo(() => editableTranslationGroups(source?.item), [source])
  const group = groups.find(value => value.id === groupId)
  const variants = useMemo(() => preferredTranslationValues(group), [group])
  const pending = ['loading', 'saving', 'syncing'].includes(phase)
  const locked = pending || !!savedRef.current

  const load = async (preserveDraft = false) => {
    if (busyRef.current) return
    busyRef.current = true
    const requestId = ++requestRef.current
    setPhase('loading')
    setError('')
    try {
      if (!entryIdRef.current) {
        const synced = await store.sync({})
        if (synced?.online === false) throw new Error('Нужна связь с Voice Record, чтобы редактировать перевод.')
        const syncedEntry = await store.getEntry({ key: entry.key })
        entryIdRef.current = syncedEntry?.remoteId || ''
      }
      if (!entryIdRef.current) throw new Error('Карточка ещё не синхронизирована. Повторите после подключения к Voice Record.')
      const result = await learningBridgeJson('/learning/catalogue', { action: 'translation-editor', entryId: entryIdRef.current })
      if (requestId !== requestRef.current) return
      const nextGroups = editableTranslationGroups(result.item)
      if (!result.revision || !nextGroups.length) throw new Error('У карточки пока нет доступных для редактирования значений.')
      setSource(result)
      setStale(false)
      if (!preserveDraft) {
        setGroupId(nextGroups[0].id)
        setDraft(nextGroups[0].shortMeaning || '')
      } else if (!nextGroups.some(value => value.id === groupId)) {
        setError('Это значение изменилось или удалено. Черновик сохранён; выберите значение заново.')
      }
    } catch (cause) {
      if (requestId === requestRef.current) setError(cause.message || 'Не удалось открыть перевод.')
    } finally {
      if (requestId === requestRef.current) { busyRef.current = false; setPhase('editing') }
    }
  }

  useEffect(() => {
    const dialog = dialogRef.current
    dialog.showModal()
    load()
    return () => { requestRef.current += 1; dialog.close() }
  }, [])

  const syncSaved = async (requestId) => {
    setPhase('syncing')
    const savedGroup = editableTranslationGroups(savedRef.current.item).find(value => value.id === groupId)
    // A sync already in flight when the save finished can contain the old item.
    // Read the shared projection and allow one fresh pull, never another edit.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await store.sync({})
      if (result?.online === false) throw new Error('Перевод сохранён, но карточка пока не обновилась. Проверьте связь и нажмите «Обновить карточку».')
      const updated = await store.getEntry({ key: entry.key })
      const overview = StudyModel.buildSenseOverview(updated)
      const currentGroup = [...overview.senses, ...(overview.support || [])]
        .find(value => (value.catalogGroupId || value.id) === groupId)
      if (savedGroup && currentGroup?.shortMeaning === savedGroup.shortMeaning) {
        await onChanged({ sync: false })
        if (requestId === requestRef.current) onSaved()
        return
      }
    }
    throw new Error('Перевод сохранён, но в общей копии пока другая версия. Нажмите «Обновить карточку». Повторно сохранять перевод не нужно.')
  }

  const save = async event => {
    event.preventDefault()
    if (busyRef.current || (!savedRef.current && (!group || stale))) return
    const shortMeaning = draft.normalize('NFKC').replace(/\s+/g, ' ').trim()
    if (!savedRef.current && (!shortMeaning || shortMeaning.split(' ').length > 3 || shortMeaning.includes('/'))) {
      setError('Основной перевод — от 1 до 3 русских слов, без слэша. Это вариант текущего смысла, не новый смысл.')
      return
    }
    const alternatives = variants.filter(value => value.toLocaleLowerCase('ru-RU') !== shortMeaning.toLocaleLowerCase('ru-RU'))
    if (!savedRef.current && (shortMeaning.length > 200 || alternatives.some(value => value.length > 200))) {
      setError('Вариант перевода должен быть не длиннее 200 символов.')
      return
    }
    busyRef.current = true
    const requestId = ++requestRef.current
    setError('')
    setPhase(savedRef.current ? 'syncing' : 'saving')
    try {
      if (!savedRef.current) {
        const result = await learningBridgeJson('/learning/catalogue', { action: 'translation-edit',
          entryId: entryIdRef.current, groupId, shortMeaning, alternatives, expectedRevision: source.revision }, 120_000)
        if (requestId !== requestRef.current) return
        if (!result.item || !result.revision) throw new Error('Сервер не подтвердил обновление карточки.')
        savedRef.current = result
      }
      await syncSaved(requestId)
    } catch (cause) {
      if (requestId !== requestRef.current) return
      setError(savedRef.current
        ? `Перевод уже сохранён. ${cause.message || 'Не удалось обновить карточку.'}`
        : cause.message || 'Не удалось сохранить перевод. Черновик остался в поле.')
      if (cause.status === 409) setStale(true)
    } finally {
      if (requestId === requestRef.current) { busyRef.current = false; setPhase('editing') }
    }
  }

  return <dialog className="meaning-editor" ref={dialogRef} aria-labelledby="meaning-editor-title"
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); if (!['saving', 'syncing'].includes(phase)) onClose() }}>
    <form onSubmit={save}>
      <div className="meaning-editor-header">
        <div><h3 id="meaning-editor-title">Редактировать перевод</h3><p>{entry.sourceText}</p></div>
        <button type="button" className="icon-button" aria-label="Закрыть редактор" disabled={['saving', 'syncing'].includes(phase)} onClick={onClose}><X size={18} /></button>
      </div>
      {phase === 'loading' && <p role="status"><RefreshCw size={16} className="spin" /> Загружаем значения…</p>}
      {source && <>
        <label className="meaning-editor-field">Значение
          <select value={groupId} disabled={locked} onChange={event => {
            const next = groups.find(value => value.id === event.target.value)
            setGroupId(event.target.value); setDraft(next?.shortMeaning || ''); setError('')
          }}>
            {!group && <option value={groupId}>Выберите значение</option>}
            {[false, true].map(support => groups.some(value => value.support === support) && <optgroup key={String(support)} label={support ? 'Серые значения' : 'Основные значения'}>
              {groups.filter(value => value.support === support).map(value => <option key={value.id} value={value.id}>{value.shortMeaning}</option>)}
            </optgroup>)}
          </select>
        </label>
        {group && <div className={`meaning-editor-variants ${group.support ? 'support' : ''}`}>
          <p>Сейчас: <strong>{group.shortMeaning}</strong></p>
          <div role="group" aria-label="Варианты основного перевода">
            {variants.map(value => <button type="button" key={value} disabled={locked} aria-pressed={draft === value}
              onClick={() => { setDraft(value); setError('') }}>{value}</button>)}
          </div>
        </div>}
        <label className="meaning-editor-field">Основной перевод
          <input value={draft} disabled={locked} onChange={event => { setDraft(event.target.value); setError('') }}
            autoComplete="off" placeholder="Выберите вариант или введите свой" />
        </label>
        <p className="meaning-editor-hint">1–3 слова. Прежний перевод останется среди вариантов. Смысл и пример не меняются.</p>
      </>}
      {error && <p className="manual-entry-error" role="alert">{error}</p>}
      {stale && <button type="button" className="secondary-button" disabled={pending} onClick={() => load(true)}>Обновить данные, сохранив черновик</button>}
      {!source && phase !== 'loading' && <button type="button" className="secondary-button" onClick={() => load()}>Повторить загрузку</button>}
      <div className="meaning-editor-actions">
        <button type="button" className="secondary-button" disabled={['saving', 'syncing'].includes(phase)} onClick={onClose}>Отмена</button>
        {source && <button type="submit" className="primary-button" disabled={pending || (!savedRef.current && (!group || !draft.trim() || stale))}>
          {phase === 'saving' ? 'Проверяем и сохраняем…' : phase === 'syncing' ? 'Обновляем карточку…' : savedRef.current ? 'Обновить карточку' : 'Сохранить перевод'}
        </button>}
      </div>
    </form>
  </dialog>
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

function EntryRow({ entry, onState, onKnown, onEdit, onResolve }) {
  const [expanded, setExpanded] = useState(false)
  const totalAttempts = Number(entry.reviewCount || 0) + Number(entry.practiceCount || 0)
  const observedForms = Array.from(new Set(entry.observedForms || []))
    .filter((form) => form && form !== entry.lemma)
  const overview = useMemo(() => StudyModel.buildSenseOverview(entry), [entry])
  const senses = useMemo(() => entrySenseSummaries(entry, overview), [entry, overview])
  const partOfSpeech = entryPartOfSpeechLabel(entry, overview)
  const hasExamples = [...(overview.senses || []), ...(overview.support || [])]
    .some((sense) => sense.example?.sourceText)

  return (
    <article className={`entry-row state-${entry.state}`} data-entry-key={entry.key}>
      <div className="entry-main">
        <div className="entry-copy">
          <div className="entry-term-line">
            <h3>{entry.sourceText}</h3>
            {partOfSpeech && <span className="entry-part-of-speech">({partOfSpeech})</span>}
            <span className={`state-dot ${entry.state}`}>{stateLabel(entry.state)}</span>
            {entry.kind === 'phrase' && <span className="kind-pill">{expressionTypeLabel(entry.expressionType) || 'фраза'}</span>}
          </div>
          {observedForms.length > 0 && <div className="entry-observed-forms">Формы: {observedForms.join(', ')}</div>}
          {senses.length ? (
            <div className="entry-senses">
              {senses.map((sense) => (
                <div key={sense.id || `${sense.partOfSpeech}-${sense.meaning}`} className={sense.support ? 'support' : ''}>
                  <span>{sense.meaning}</span>
                  {partOfSpeechLabel(sense.partOfSpeech) && <small>({partOfSpeechLabel(sense.partOfSpeech)})</small>}
                </div>
              ))}
              <button type="button" className="entry-senses-edit" onClick={() => onEdit(entry)} aria-label="Изменить основной перевод"><Pencil size={13} /></button>
            </div>
          ) : (
            <button type="button" className={`translation-value ${entry.translation ? '' : 'empty'}`} onClick={() => onEdit(entry)}>
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
          <StateButton active={false} tone="known" icon={CheckCircle2} onClick={() => onKnown(entry)}>Знаю</StateButton>
          <StateButton active={entry.state === 'saved'} tone="saved" icon={BookOpen} onClick={() => onState(entry, 'saved')}>В словарь</StateButton>
          <StateButton active={entry.state === 'known'} tone="known" icon={X} onClick={() => onState(entry, 'known')}>Не учить</StateButton>
          {hasExamples && (
            <button type="button" className="entry-examples-toggle" aria-label={`${expanded ? 'Скрыть' : 'Показать'} примеры: ${entry.sourceText}`}
              aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
              <FileText size={15} /><span>Примеры</span>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          )}
        </div>
      </div>
      <ConflictBox entry={entry} onResolve={onResolve} />
      {expanded && (
        <div className="contexts">
          <StudyCatalogueExamples entry={entry} overview={overview} revealed examplesToggleable defaultTranslationsVisible={false} />
        </div>
      )}
    </article>
  )
}

function DictionaryView({ entries, refresh }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [editingEntry, setEditingEntry] = useState(null)

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en-US')
    return entries.filter((entry) => entry.state !== 'none' && entry.state !== 'archived')
      .filter((entry) => filter === 'all' || entry.state === filter)
      .filter((entry) => !needle
        || entry.sourceText.toLocaleLowerCase('en-US').includes(needle)
        || entry.translation.toLocaleLowerCase('en-US').includes(needle))
  }, [entries, filter, query])

  const setState = async (entry, state) => {
    await store.setState({ ...entry, state, toggle: true })
    await refresh({ sync: true })
  }
  const markKnown = async (entry) => {
    await scheduleKnownEntry(entry)
    await refresh({ sync: false })
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
          {[['all', 'Все'], ['saved', 'В словаре'], ['known', 'Не учу']].map(([value, label]) => (
            <button type="button" key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <AddEntry onChanged={refresh} searchTerm={query} noMatches={!visible.length} />
      </div>
      <div className="entry-list">
        {visible.map((entry) => <EntryRow key={entry.key} entry={entry} onState={setState} onKnown={markKnown} onEdit={setEditingEntry} onResolve={resolve} />)}
        {!visible.length && <div className="empty-state"><BookOpen size={38} /><h2>Здесь пока пусто</h2><p>Добавьте слово вручную или нажмите «В словарь» в субтитрах YouTube.</p></div>}
      </div>
      {editingEntry && <TranslationEditor key={editingEntry.key} entry={editingEntry} onChanged={refresh}
        onClose={() => setEditingEntry(null)} onSaved={() => setEditingEntry(null)} />}
    </section>
  )
}

function studyDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function shiftStudyDate(date, delta) {
  const shifted = new Date(`${date}T12:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + delta)
  return shifted.toISOString().slice(0, 10)
}

function studyCountLabel(count, forms) {
  const last = count % 10, lastTwo = count % 100
  return forms[last === 1 && lastTwo !== 11 ? 0 : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 1 : 2]
}

function StudyDatePicker({ value, onChange, data, label }) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(value.slice(0, 7))
  const [position, setPosition] = useState(null)
  const wrapRef = useRef(null), triggerRef = useRef(null), panelRef = useRef(null)
  const close = () => { setOpen(false); setPosition(null) }
  useEffect(() => { setMonth(value.slice(0, 7)) }, [value])
  useEffect(() => {
    // The trigger/wrapper stays mounted. Listen for its whole lifetime so an
    // immediate outside tap cannot fall into a deferred-listener gap.
    const outside = event => { if (!wrapRef.current?.contains(event.target)) close() }
    const escape = event => { if (event.key === 'Escape' && panelRef.current) { close(); triggerRef.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [])
  useLayoutEffect(() => {
    if (!open) return undefined
    const place = () => {
      const panel = panelRef.current
      if (!LearningUtils.fitFloatingElement(panel, triggerRef.current, { preferBelow: true, gap: 6,
        bottomLimit: NATIVE_STUDY ? window.__scStudyAvailableBottom : undefined })) return
      setPosition({ left: panel.style.left, top: panel.style.top, maxHeight: panel.style.maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [open, month])
  const changeMonth = delta => {
    const date = new Date(`${month}-01T12:00:00Z`)
    date.setUTCMonth(date.getUTCMonth() + delta)
    setMonth(date.toISOString().slice(0, 7))
  }
  const first = `${month}-01`
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7
  const monthEnd = new Date(`${first}T12:00:00Z`)
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0)
  const days = Array.from({ length: Math.ceil((offset + monthEnd.getUTCDate()) / 7) * 7 }, (_, index) => shiftStudyDate(first, index - offset))
  const activity = new Map((data?.days || []).map(day => [day.date, day.words]))
  const pick = date => { onChange(date); close(); triggerRef.current?.focus() }
  const years = data ? Array.from({ length: Number(data.today.slice(0, 4)) - Number(data.firstDate.slice(0, 4)) + 1 }, (_, index) => Number(data.firstDate.slice(0, 4)) + index) : []
  return <div className="study-date-picker" ref={wrapRef}>
    <button type="button" ref={triggerRef} aria-label="Выбрать дату статистики" aria-expanded={open} aria-haspopup="dialog" disabled={!data}
      onClick={() => { if (open) close(); else { setMonth(value.slice(0, 7)); setOpen(true) } }}><CalendarDays size={15} /><span>{label}</span></button>
    {open && <div ref={panelRef} className="study-calendar" role="dialog" aria-label="Календарь статистики"
      style={{ ...position, visibility: position ? 'visible' : 'hidden' }}>
      <div className="study-calendar-month">
        <button type="button" aria-label="Предыдущий месяц" disabled={month <= data.firstDate.slice(0, 7)} onClick={() => changeMonth(-1)}><ArrowLeft size={16} /></button>
        <span>{new Intl.DateTimeFormat('ru', { month: 'long' }).format(new Date(`${first}T12:00:00`))}</span>
        <select aria-label="Год статистики" value={month.slice(0, 4)} onChange={event => {
          const next = `${event.target.value}-${month.slice(5)}`
          setMonth(next < data.firstDate.slice(0, 7) ? data.firstDate.slice(0, 7) : next > data.today.slice(0, 7) ? data.today.slice(0, 7) : next)
        }}>{years.map(year => <option key={year} value={year}>{year}</option>)}</select>
        <button type="button" aria-label="Следующий месяц" disabled={month >= data.today.slice(0, 7)} onClick={() => changeMonth(1)}><ArrowRight size={16} /></button>
      </div>
      <div className="study-calendar-grid">
        {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => <span key={day} className="study-calendar-weekday">{day}</span>)}
        {days.map(date => <button type="button" key={date} data-date={date} aria-label={new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00`))}
          aria-pressed={date === value} aria-current={date === data.today ? 'date' : undefined}
          disabled={date < data.firstDate || date > data.today}
          className={`${date === value ? 'selected' : ''} ${date.slice(0, 7) !== month ? 'outside-month' : ''} ${activity.has(date) ? 'has-answers' : ''}`}
          onClick={() => pick(date)}>{Number(date.slice(-2))}</button>)}
      </div>
      <button type="button" className="study-calendar-today" onClick={() => pick(data.today)}>Сегодня</button>
    </div>}
  </div>
}

function DailyStudyStatistics({ pending = 0 }) {
  const [data, setData] = useState(null)
  const [selectedDate, setSelectedDate] = useState(() => studyDateKey())
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const requestRef = useRef(0)
  const todayRef = useRef(studyDateKey())
  const load = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      const query = `?timeZone=${encodeURIComponent(timeZone)}`
      const next = REMOTE_STUDY
        ? await remoteApi(`/api/vocabulary/statistics${query}`)
        : await learningBridgeGet(`/learning/statistics${query}`)
      if (!Array.isArray(next.days) || !next.startedAt || !next.firstDate || !next.today) throw new Error('Сервер не вернул статистику')
      if (request !== requestRef.current) return
      setData(next)
      setError('')
      setSelectedDate(current => current === todayRef.current ? next.today : current < next.firstDate ? next.firstDate : current > next.today ? next.today : current)
      todayRef.current = next.today
    } catch (cause) {
      if (request === requestRef.current) setError(cause?.message || 'Не удалось загрузить статистику')
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let timer
    const refresh = () => {
      if (document.visibilityState === 'hidden') return
      clearTimeout(timer)
      timer = setTimeout(load, 80)
    }
    const unsubscribe = store.subscribe(refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const midnight = setInterval(() => { if (studyDateKey() !== todayRef.current) refresh() }, 60_000)
    load()
    return () => {
      requestRef.current += 1
      clearTimeout(timer)
      clearInterval(midnight)
      unsubscribe()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [load])

  const day = data?.days.find(day => day.date === selectedDate)
  const today = selectedDate === (data?.today || studyDateKey())
  const dateLabel = today ? 'Сегодня' : new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${selectedDate}T12:00:00`))
  const words = day?.words || 0
  const answers = day?.answers || 0

  return <section className="study-daily-statistics" aria-label="Статистика за день" aria-busy={loading}>
    <div className="study-daily-header">
      <h3>Статистика</h3>
      <div className="study-date-controls">
        <button type="button" aria-label="Предыдущий день" disabled={!data || selectedDate <= data.firstDate}
          onClick={() => setSelectedDate(date => shiftStudyDate(date, -1))}><ArrowLeft size={16} /></button>
        <StudyDatePicker value={selectedDate} onChange={setSelectedDate} data={data} label={dateLabel} />
        <button type="button" aria-label="Следующий день" disabled={!data || selectedDate >= data.today}
          onClick={() => setSelectedDate(date => shiftStudyDate(date, 1))}><ArrowRight size={16} /></button>
      </div>
    </div>
    {error && <div className="study-daily-error" role="alert">
      <span>{data ? 'Статистика не обновилась.' : 'Не удалось загрузить статистику.'}</span>
      <button type="button" disabled={loading} onClick={load}>Повторить</button>
    </div>}
    {!data && !error && <p className="study-daily-empty">Загружаю статистику…</p>}
    {data && <>
      <div className="study-daily-total"><strong>{words} {studyCountLabel(words, ['слово', 'слова', 'слов'])}</strong>
        <span>· {answers} {studyCountLabel(answers, ['ответ', 'ответа', 'ответов'])}</span></div>
      {answers > 0 ? <dl className="study-daily-results">
        <div><dt>Сразу вспомнил</dt><dd>{day.firstRemembered}<small> · {day.firstRememberedPercent}%</small></dd></div>
        {day.firstPartial > 0 && <div><dt>Сначала вспомнил частично</dt><dd>{day.firstPartial}</dd></div>}
        <div><dt>Сначала не вспомнил</dt><dd>{day.firstForgotten}</dd></div>
        {day.firstForgotten > 0 && <div><dt>Из них позже вспомнил</dt><dd>{day.recovered}<small> из {day.firstForgotten}</small></dd></div>}
        {day.partialRecovered > 0 && <div><dt>После частичного вспомнил полностью</dt><dd>{day.partialRecovered}<small> из {day.firstPartial}</small></dd></div>}
      </dl> : <p className="study-daily-empty">{today ? 'Сегодня ещё нет ответов' : 'В этот день ответов не было'}</p>}
      {selectedDate <= data.startedDate && <p className="study-daily-note">Учёт начат {new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(data.startedAt)}. Более ранние ответы могут отсутствовать.</p>}
      {pending > 0 && <p className="study-daily-note">Ответы офлайн появятся после синхронизации.</p>}
    </>}
  </section>
}

function DeckOverview({ entries, stats, onStart, onOpenArchive, refresh, addRequest, resuming = false }) {
  const savedEntries = useMemo(() => entries.filter((entry) => entry.state === 'saved'), [entries])
  const archivedCount = useMemo(() => entries.filter((entry) => entry.state === 'archived').length, [entries])
  const dueCount = useMemo(
    () => savedEntries.filter((entry) => StudyModel.isAvailable(entry)).length,
    [savedEntries],
  )
  const newCount = useMemo(
    () => savedEntries.filter((entry) => Number(entry.reviewCount || 0) === 0).length,
    [savedEntries],
  )
  const firstEntry = useMemo(() => {
    const firstUnitKey = StudyModel.buildRound(savedEntries, {})[0]
    const firstUnit = StudyModel.buildReviewUnits(savedEntries).find((unit) => unit.key === firstUnitKey)
    return savedEntries.find((entry) => entry.key === firstUnit?.entryKey) || null
  }, [savedEntries])
  const [autoplay, setAutoplay] = useState(() => HOSTED_STUDY && readRemoteYoutubePreferences().learning_card_autoplay)

  useEffect(() => {
    let active = true
    readYoutubePreferences().then((preferences) => {
      if (active) setAutoplay(preferences.learning_card_autoplay === true)
    }).catch(() => {})
    const update = event => setAutoplay(event.detail?.learning_card_autoplay === true)
    window.addEventListener('sc-study-preferences', update)
    return () => { active = false; window.removeEventListener('sc-study-preferences', update) }
  }, [])

  const startMixedMode = () => {
    if (!resuming && autoplay && firstEntry?.sourceText) speakLearningText(firstEntry.sourceText)
    onStart()
  }

  return (
    <section className="deck-overview workspace" aria-label="Карточки">
      <div className="deck-overview-stats has-archive" aria-label="Статистика карточек">
        <div><span>Всего</span><strong>{stats?.saved ?? savedEntries.length}</strong></div>
        <div><span>К повторению</span><strong>{dueCount}</strong></div>
        <div><span>Новых</span><strong>{newCount}</strong></div>
        <button type="button" className="archive-stat" onClick={onOpenArchive} aria-label={`В архиве ${archivedCount}`}>
          <span>В архиве</span><strong>{archivedCount}</strong>
        </button>
      </div>
      <button
        type="button"
        className="mixed-mode-card"
        onClick={startMixedMode}
        disabled={!savedEntries.length}
      >
        <span className="mixed-mode-icon"><Sparkles size={22} /></span>
        <span className="mixed-mode-copy">
          <strong>Начать практику</strong>
          <small>{savedEntries.length
            ? `Новые слова и повторение · ${savedEntries.length} карточек`
            : 'Сначала добавьте слова в словарь'}</small>
        </span>
        <ArrowRight size={20} />
      </button>
      <AddEntry key={addRequest?.id || 'manual'} onChanged={refresh} home request={addRequest} />
      <DailyStudyStatistics pending={stats?.pending || 0} />
    </section>
  )
}

function ArchiveView({ entries, refresh, onExit }) {
  const [query, setQuery] = useState('')
  const [busyKey, setBusyKey] = useState('')
  const [error, setError] = useState('')
  const archivedEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en-US')
    return entries
      .filter((entry) => entry.state === 'archived')
      .filter((entry) => !needle
        || entry.sourceText.toLocaleLowerCase('en-US').includes(needle)
        || entry.translation.toLocaleLowerCase('en-US').includes(needle))
      .sort((a, b) => b.stateUpdatedAt - a.stateUpdatedAt || a.sourceText.localeCompare(b.sourceText))
  }, [entries, query])

  const restore = async (entry) => {
    if (busyKey) return
    setBusyKey(entry.key)
    setError('')
    try {
      await store.setState({ ...entry, state: 'saved', toggle: false })
      await refresh({ sync: true })
    } catch (restoreError) {
      setError(restoreError?.message || String(restoreError))
    } finally {
      setBusyKey('')
    }
  }

  return (
    <section className="archive-view workspace" aria-label="Архив слов">
      <div className="archive-heading">
        <button type="button" className="secondary-button" onClick={onExit}><ArrowLeft size={16} />Карточки</button>
        <div><span>Не участвуют в повторениях</span><h2>Архив</h2></div>
      </div>
      {entries.some((entry) => entry.state === 'archived') && (
        <label className="search-box archive-search"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти слово в архиве" /></label>
      )}
      {error && <div className="error-banner" role="alert">{error}<button type="button" onClick={() => setError('')}><X size={16} /></button></div>}
      <div className="archive-list">
        {archivedEntries.map((entry) => {
          const meanings = StudyModel.buildSenseOverview(entry).senses.map((sense) => sense.shortMeaning).filter(Boolean)
          return (
            <article className="archive-entry" key={entry.key}>
              <div><h3>{entry.sourceText}</h3><p>{meanings.join(' / ') || entry.translation || 'Без перевода'}</p></div>
              <button type="button" className="secondary-button" onClick={() => restore(entry)} disabled={!!busyKey} aria-label={`Вернуть в обучение: ${entry.sourceText}`}>
                {busyKey === entry.key ? <RefreshCw size={15} className="spin" /> : <ArrowRight size={15} />}Вернуть
              </button>
            </article>
          )
        })}
        {!archivedEntries.length && <div className="empty-state archive-empty"><Archive size={38} /><h2>{query.trim() ? 'Ничего не найдено' : 'В архиве пока пусто'}</h2><p>{query.trim() ? 'Попробуйте другой запрос.' : 'Сложные слова можно отправить сюда из меню карточки.'}</p></div>}
      </div>
    </section>
  )
}

function alternativeDictionaryEntry(entries, term) {
  const key = store.normalizeTerm(term)
  const candidates = (entries || []).filter(entry => entry.state !== 'none')
  const exact = candidates.find(entry => [entry.sourceText, entry.lemma]
    .some(value => value && store.normalizeTerm(value) === key))
  if (exact || key.includes(' ')) return exact || null
  const observed = candidates.find(entry => entry.observedForms?.some(form => store.normalizeTerm(form) === key))
  if (observed) return observed
  return candidates.find(entry => entry.kind === 'word' && (entry.partsOfSpeech?.length ? entry.partsOfSpeech : [entry.partOfSpeech])
    .some(partOfSpeech => Lexeme.formsForLexeme({ ...entry, partOfSpeech, partsOfSpeech: [] })
      .some(form => store.normalizeTerm(form) === key))) || null
}

function SharedEnglishChoices({ ownerRef, anchor, model, onClose, onChoice, onRetry, isSaved }) {
  const instance = useRef(null)
  useLayoutEffect(() => {
    instance.current = window.__scLearningChoicesPopover.create({ owner: ownerRef.current, anchor, model,
      onClose, onChoice, onRetry, isSaved,
      bottomLimit: () => NATIVE_STUDY && Number.isFinite(window.__scStudyAvailableBottom)
        ? window.__scStudyAvailableBottom : window.innerHeight })
    return () => { instance.current?.close({ notify: false }); instance.current = null }
  }, [])
  useLayoutEffect(() => { instance.current?.update({ anchor, model, onClose, onChoice, onRetry, isSaved }) },
    [anchor, model, onClose, onChoice, onRetry, isSaved])
  return null
}

function StudyMeaningSummary({ senses, support: supportSenses = [], catalogue, revealed, revealedParts = null, entries, onAlternative, portal = false, choiceContext = null, selection = null, recalled = {} }) {
  const { showSupport } = React.useContext(StudyPreferencesContext)
  const support = useMemo(() => (showSupport ? supportSenses : []).map(sense => {
    const raw = catalogue?.supportGroups?.find(group => group.id === sense.id)
    return raw ? { ...sense, alternatives: preferredTranslationValues(raw).filter(value => value !== sense.shortMeaning) } : sense
  }), [supportSenses, catalogue, showSupport])
  const rootRef = useRef(null)
  const [openSenseId, setOpenSenseId] = useState('')
  const selectedSense = [...senses, ...support].find((sense) => sense.id === openSenseId) || null
  const choiceInput = choiceContext && selectedSense ? { ...choiceContext,
    meaning: selectedSense.meaning || selectedSense.shortMeaning, partOfSpeech: selectedSense.partOfSpeech || '' } : null
  const choiceKey = choiceInput ? JSON.stringify(choiceInput) : ''
  const [choiceResult, setChoiceResult] = useState(null)
  const [choiceAttempt, setChoiceAttempt] = useState(0)
  const choice = choiceResult?.key === choiceKey ? choiceResult : { phase: 'loading' }
  const activeSense = selectedSense && choiceKey && choice.phase === 'ready' ? { ...selectedSense, ...choice.value } : selectedSense
  const isSenseRevealed = sense => revealed || !!sense && revealedParts?.has(StudyState.meaningKey(sense))
  const activeSenseVisible = !!activeSense && isSenseRevealed(activeSense)
  const anyMeaningRevealed = revealed || [...senses, ...support].some(isSenseRevealed)
  useEffect(() => {
    if (!choiceKey) return undefined
    let active = true
    setChoiceResult({ key: choiceKey, phase: 'loading' })
    practiceWordRequest(`alternatives:${choiceKey}`, () => learningBridgeJson('/learning/catalogue',
      { ...JSON.parse(choiceKey), action: 'alternatives' }, 45_000))
      .then(value => { if (active) setChoiceResult({ key: choiceKey, phase: 'ready', value }) })
      .catch(error => { if (active) setChoiceResult({ key: choiceKey, phase: 'error', error: error.message }) })
    return () => { active = false }
  }, [choiceKey, choiceAttempt])



  useEffect(() => {
    if (!isSenseRevealed(selectedSense)) setOpenSenseId('')
  }, [revealed, revealedParts, selectedSense])



  const meaningClass = (sense, base) => `${base} ${isSenseRevealed(sense) ? '' : 'masked'} ${recalled[StudyState.meaningKey(sense)]?.remembered && !sense.support ? 'meaning-recalled' : ''} ${selection?.enabled && selection.keys.has(StudyState.meaningKey(sense)) ? 'meaning-selected' : ''}`
  const chooseMeaning = sense => {
    if (!isSenseRevealed(sense)) return
    if (selection?.enabled) { setOpenSenseId(''); selection.toggle(sense); return }
    setOpenSenseId(current => current === sense.id ? '' : sense.id)
  }
  useEffect(() => { setOpenSenseId('') }, [selection?.enabled, showSupport])
  return (
    <div className={`study-meaning-bar ${revealed ? '' : 'masked'}`} ref={rootRef}
      aria-hidden={!anyMeaningRevealed} inert={!anyMeaningRevealed ? '' : undefined}>
      <p className="study-meaning-line" data-selectable-text={anyMeaningRevealed ? true : undefined}>
        {senses.map((sense, index) => (
          <React.Fragment key={sense.id}>
            {index > 0 && <span className="study-meaning-slash" aria-hidden="true">/</span>}
            <button
              type="button"
              className={meaningClass(sense, 'study-meaning-trigger')}
              aria-hidden={!isSenseRevealed(sense)} inert={!isSenseRevealed(sense) ? '' : undefined}
              aria-pressed={selection?.enabled ? selection.keys.has(StudyState.meaningKey(sense)) : undefined}
              aria-expanded={openSenseId === sense.id}
              onClick={() => chooseMeaning(sense)}
            >{sense.shortMeaning}</button>
          </React.Fragment>
        ))}
        {support.length > 0 && <>
          <span className="study-support-first">
            <span className="study-support-divider" aria-hidden="true">│</span>
            <button type="button" className={meaningClass(support[0], 'study-support-meaning')} aria-pressed={selection?.enabled ? selection.keys.has(StudyState.meaningKey(support[0])) : undefined} aria-expanded={openSenseId === support[0].id}
              aria-hidden={!isSenseRevealed(support[0])} inert={!isSenseRevealed(support[0]) ? '' : undefined}
              onClick={() => chooseMeaning(support[0])}>
              {support[0].shortMeaning}
            </button>
          </span>
          {support.slice(1).map((sense) => <React.Fragment key={sense.id}>
            <span className="study-support-slash" aria-hidden="true">/</span>
            <button type="button" className={meaningClass(sense, 'study-support-meaning')} aria-pressed={selection?.enabled ? selection.keys.has(StudyState.meaningKey(sense)) : undefined} aria-expanded={openSenseId === sense.id}
              aria-hidden={!isSenseRevealed(sense)} inert={!isSenseRevealed(sense) ? '' : undefined}
              onClick={() => chooseMeaning(sense)}>
              {sense.shortMeaning}
            </button>
          </React.Fragment>)}
        </>}
        {selection && <button type="button" role="switch" aria-checked={selection.enabled}
          aria-label="Отметить вспомненные значения" title="Отметить вспомненные значения"
          className={`study-meaning-select-switch settings-switch ${selection.enabled ? 'on' : ''}`}
          onClick={selection.toggleMode}><span /></button>}
      </p>
      {activeSenseVisible && <SharedEnglishChoices ownerRef={rootRef}
        anchor={() => rootRef.current?.querySelector('[aria-expanded="true"]') || rootRef.current}
        model={{ title: activeSense.shortMeaning,
          russianAlternatives: !choiceKey ? (activeSense.alternatives.length ? activeSense.alternatives.join(', ')
            : activeSense.support ? activeSense.description || 'Дополнительное употребление этого слова' : 'Дополнительных вариантов перевода нет') : '',
          description: activeSense.support && activeSense.alternatives.length ? activeSense.description : '',
          phase: choiceKey ? choice.phase : 'ready', error: choice.error,
          headwordChoice: activeSense.headwordChoice, englishAlternatives: activeSense.englishAlternatives }}
        onClose={() => setOpenSenseId('')}
        onRetry={() => setChoiceAttempt(value => value + 1)}
        isSaved={term => !!alternativeDictionaryEntry(entries, term)}
        onChoice={onAlternative ? value => { setOpenSenseId(''); onAlternative(value.term, alternativeDictionaryEntry(entries, value.term)) } : undefined} />}

    </div>
  )
}

function focusedExampleSegments(text, focus, fallback) {
  const start = focus ? text.indexOf(focus) : -1
  if (start < 0) return fallback
  return [{ text: text.slice(0, start) }, { text: focus, active: true }, { text: text.slice(start + focus.length) }]
}

function studyExampleTargetSegments(entry, sense, targetText) {
  return focusedExampleSegments(targetText, sense.example?.focusRu,
    LearningUtils.learningExamplePresentation({ sourceText: sense.example?.sourceText || '', targetText,
      sourceTerms: entrySourceTerms(entry), targetTerms: [sense.shortMeaning, sense.meaning, ...sense.alternatives].filter(Boolean),
      sourceLanguage: entry?.sourceLang || 'en', targetLanguage: entry?.targetLang || 'ru' }).targetSegments)
}

function studyExampleRevealKey(sense) { return `example:${sense.id}` }

function studyContextMeaning(entry, meanings, context) {
  const rawSenses = entry?.senses || []
  const ownerForRaw = raw => meanings.filter(sense => sense.id === String(raw.id || '')
    || raw.catalogGroupId && (sense.catalogGroupId || sense.id) === raw.catalogGroupId)
  if (context.senseId) {
    const direct = meanings.filter(sense => sense.id === String(context.senseId))
    if (direct.length === 1) return direct[0]
    const raw = rawSenses.find(sense => String(sense.id || '') === String(context.senseId))
    const candidates = raw ? ownerForRaw(raw) : []
    if (candidates.length === 1) return candidates[0]
    // A real foreign owner must not be replaced by a coincidentally equal label.
    // The historical unknown placeholder is unassigned, not a fourth meaning.
    if (!/^sense:unknown(?::|$)/.test(String(context.senseId))) return null
  }
  if (context.catalogGroupId) {
    const candidates = meanings.filter(sense => (sense.catalogGroupId || sense.id) === context.catalogGroupId)
    return candidates.length === 1 ? candidates[0] : null
  }
  const owners = rawSenses.filter(sense => sense.contextIds?.includes(context.id))
  if (owners.length) {
    if (owners.length !== 1) return null
    const candidates = ownerForRaw(owners[0])
    return candidates.length === 1 ? candidates[0] : null
  }
  const label = String(context.meaning || context.focusRu || '').trim().toLocaleLowerCase('ru-RU')
  if (!label) return null
  const candidates = meanings.filter(sense => [sense.meaning, sense.shortMeaning, ...sense.alternatives]
    .some(value => value?.trim().toLocaleLowerCase('ru-RU') === label))
  return candidates.length === 1 ? candidates[0] : null
}

function studyCatalogueExampleRows(entry, overview, showSupport) {
  const supportMeanings = overview.support || []
  const meanings = [...overview.senses, ...supportMeanings]
  const visibleMeanings = meanings.filter(sense => showSupport || !supportMeanings.includes(sense))
  const buckets = new Map(meanings.map(sense => [sense, [{ sense, meaningSense: sense, support: supportMeanings.includes(sense) }]]))
  const shown = new Map(meanings.map(sense => [sense, new Set([sense.example?.sourceText].filter(Boolean))]))
  const anyShown = new Set(visibleMeanings.map(sense => sense.example?.sourceText).filter(Boolean))
  for (const context of entry?.contexts || []) {
    if (!context.sourceText) continue
    const meaningSense = studyContextMeaning(entry, meanings, context)
    if (!meaningSense) continue
    // The catalogue owns its generated samples. Retained old dictionary text
    // must not return merely because it still has an old senseId.
    if (context.origin === 'dictionary' && (!meaningSense || !(entry?.senses || []).some(raw =>
      raw.contextIds?.includes(context.id) && (String(raw.id || '') === meaningSense.id
        || raw.catalogGroupId && raw.catalogGroupId === (meaningSense.catalogGroupId || meaningSense.id))))) continue
    const support = supportMeanings.includes(meaningSense)
    if (support && !showSupport) continue
    if (meaningSense ? shown.get(meaningSense).has(context.sourceText) : anyShown.has(context.sourceText)) continue
    anyShown.add(context.sourceText)
    const row = { sense: { ...(meaningSense || { shortMeaning: '', meaning: '', alternatives: [] }),
      id: `context:${context.id || context.sourceText}`, catalogGroupId: meaningSense?.catalogGroupId || meaningSense?.id,
      example: context }, meaningSense, support, contextExample: true }
    if (meaningSense) {
      shown.get(meaningSense).add(context.sourceText)
      buckets.get(meaningSense).push(row)
    }
  }
  return visibleMeanings.flatMap(sense => buckets.get(sense))
}

function StudySenseExample({ entry, sense, revealed, translationVisible = revealed, onToggleTranslation = null, onRevealAnswer = null, support = false, recalled = false, exampleNumber = null, contextExample = false }) {
  const { maskExampleAnswer } = React.useContext(StudyPreferencesContext)
  const words = React.useContext(WordCardContext)
  const [loadedTranslation, setLoadedTranslation] = useState(null)
  const [translationError, setTranslationError] = useState('')
  const [translationBusy, setTranslationBusy] = useState(false)
  const [translationAttempt, setTranslationAttempt] = useState(0)
  const sourceText = sense.example?.sourceText || ''
  const translationKey = `${entry?.remoteId || entry?.id || entry?.key}:${sourceText}`
  const targetText = sense.example?.translation || (loadedTranslation?.key === translationKey ? loadedTranslation.text : '')
  useEffect(() => {
    if (!translationVisible || !sourceText || targetText) return undefined
    let active = true
    setTranslationBusy(true); setTranslationError('')
    learningBridgeJson('/learning/catalogue', { action: 'context-translation',
      entryId: entry?.remoteId || entry?.id || entry?.key, sourceText }, 60_000).then(result => {
      if (!active) return
      if (!result?.translation) throw new Error('Перевод примера не получен')
      setLoadedTranslation({ key: translationKey, text: result.translation })
      void words?.refresh?.({ sync: true })
    }).catch(error => { if (active) setTranslationError(error.message) })
      .finally(() => { if (active) setTranslationBusy(false) })
    return () => { active = false }
  }, [translationVisible, translationKey, translationAttempt, targetText])
  if (!sense.example) {
    if (!revealed) return null
    return (
      <section className="study-sense-example">
        <div className="study-sense-heading">{sense.shortMeaning}</div>
        <div className="study-example-empty">Пример для этого значения ещё не сохранён</div>
      </section>
    )
  }
  const presentation = LearningUtils.learningExamplePresentation({
    sourceText: sense.example.sourceText,
    ...StudyModel.exampleTranslation(sense.example),
    sourceTerms: entrySourceTerms(entry),
    targetTerms: [sense.shortMeaning, sense.meaning, ...sense.alternatives].filter(Boolean),
    sourceLanguage: entry?.sourceLang || 'en',
    targetLanguage: entry?.targetLang || 'ru',
  })
  const source = <InteractiveEnglishText text={sense.example.sourceText}
    lookup={words?.lookup || new Map()} highlights={focusedExampleSegments(sense.example.sourceText, sense.example.focusEn, presentation.sourceSegments)}
    onWord={selection => words?.open({ ...selection, context: sense.example.sourceText, contextTranslation: targetText,
      observation: StudyModel.observedWordContext(sense.example, selection.word, targetText) })} />
  const toggleTranslation = (event) => {
    const selection = window.getSelection?.()
    if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return
    onToggleTranslation?.()
  }
  const revealedHeading = sense.shortMeaning || ''
  const heading = exampleNumber !== null && (!revealed || !revealedHeading) ? `example-${exampleNumber}` : revealed ? revealedHeading : ''
  const headingLabel = exampleNumber !== null
    ? <span className="study-example-heading-label"><span aria-hidden="true" className="study-example-heading-size">{revealedHeading || heading}</span><span>{heading}</span></span>
    : heading
  return (
    <section className={`study-sense-example ${support ? 'support' : 'core'} ${recalled && !support ? 'meaning-recalled' : ''} ${onToggleTranslation ? 'toggleable' : ''} ${translationVisible ? 'translation-expanded' : ''}`}>
      {heading && (onToggleTranslation
        ? <button type="button" className="study-sense-heading study-sense-heading-toggle"
            aria-expanded={translationVisible} onClick={toggleTranslation}
            aria-label={`${translationVisible ? 'Скрыть' : 'Показать'} перевод примера «${heading}»`}>{headingLabel}</button>
        : <div className="study-sense-heading">{headingLabel}</div>)}
      <div className="study-example-source-row">
        {onToggleTranslation
          ? <div className="study-example-source-toggle" role="button" tabIndex={0} aria-expanded={translationVisible}
              aria-label={`${translationVisible ? 'Скрыть' : 'Показать'} перевод примера: ${sense.example.sourceText}`}
              onClick={toggleTranslation}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return
                if (!['Enter', ' '].includes(event.key)) return
                event.preventDefault()
                onToggleTranslation()
              }}>
              <ChevronDown size={15} className={translationVisible ? 'expanded' : ''} />
              <span className="study-example-source"><span className="study-example-source-text" data-selectable-text>{source}</span></span>
            </div>
          : <p className="study-example-source" data-selectable-text>{source}</p>}
        <button
          type="button"
          className="study-example-play"
          onClick={() => speakLearningText(sense.example.sourceText)}
          title="Произнести пример"
          aria-label="Произнести пример"
        ><Play size={18} /></button>
      </div>
      {translationVisible && <div className={`study-example-target ${!revealed && maskExampleAnswer ? 'mask-answer' : ''}`} data-selectable-text>
        {targetText ? <HighlightedExampleText segments={studyExampleTargetSegments(entry, sense, targetText)}
          onReveal={!revealed && maskExampleAnswer ? onRevealAnswer : null}
          revealLabel={exampleNumber !== null ? `Показать скрытый перевод в примере ${exampleNumber}` : undefined} />
          : translationError ? <span role="status">{translationError} <button type="button" className="study-example-retry" onClick={() => setTranslationAttempt(value => value + 1)}>Повторить</button></span>
            : <span role="status" aria-busy={translationBusy}><RefreshCw size={14} className="spin" /> Перевожу пример…</span>}
      </div>}
    </section>
  )
}

function StudyCatalogueExamples({ entry, overview, revealed, revealedParts = null, onRevealExample = null, examplesToggleable = false, defaultTranslationsVisible = revealed, numberedHeadings = false }) {
  const { showSupport } = React.useContext(StudyPreferencesContext)
  const [translationOverrides, setTranslationOverrides] = useState({})
  const examples = studyCatalogueExampleRows(entry, overview, showSupport)
  return <>
    {examples.map(({ sense, meaningSense, support, contextExample }, index) => {
      const translationVisible = Object.prototype.hasOwnProperty.call(translationOverrides, sense.id)
        ? translationOverrides[sense.id]
        : defaultTranslationsVisible
      return <React.Fragment key={sense.id}>
      <StudySenseExample entry={entry} sense={sense} revealed={revealed || revealedParts?.has(studyExampleRevealKey(sense))} translationVisible={translationVisible}
        onRevealAnswer={onRevealExample ? () => onRevealExample(sense, meaningSense) : null}
        exampleNumber={numberedHeadings ? index + 1 : null}
        contextExample={contextExample}
        support={support} recalled={entry?.reviewSchedule?.queue?.meaningRecall?.[StudyState.meaningKey(meaningSense || sense)]?.remembered === true}
        onToggleTranslation={examplesToggleable ? () => setTranslationOverrides(previous => ({
          ...previous,
          [sense.id]: !translationVisible,
        })) : null} />
    </React.Fragment>})}
  </>
}

function SenseSourceAttribution({ catalog }) {
  const source = catalog?.source
  if (source?.provider === 'user-expression') return <div className="study-sense-source">Пример составлен для выражения</div>
  const webLink = (value) => {
    try {
      const url = new URL(value)
      return ['https:', 'http:'].includes(url.protocol) ? url.href : ''
    } catch { return '' }
  }
  const articleUrl = webLink(source?.url)
  if (!articleUrl) return null
  const licenseUrl = webLink(source?.license?.url)
  return (
    <div className="study-sense-source">
      <span>По материалам <a href={articleUrl} target="_blank" rel="noreferrer">{source.provider === 'wiktionary' ? 'Wiktionary' : 'словарной статьи'}</a></span>
      {source.license?.name && <>
        <span aria-hidden="true">·</span>
        {licenseUrl
          ? <a href={licenseUrl} target="_blank" rel="noreferrer">{source.license.name}</a>
          : <span>{source.license.name}</span>}
      </>}
    </div>
  )
}

function useFloatingStudyPanel(open, panelRef, anchorRef, heightLimit = 260) {
  useLayoutEffect(() => {
    if (!open) return undefined
    const panel = panelRef.current, anchor = anchorRef.current
    if (!panel || !anchor) return undefined
    const place = () => LearningUtils.fitFloatingElement(panel, anchor, { preferBelow: true, heightLimit,
      bottomLimit: NATIVE_STUDY ? window.__scStudyAvailableBottom : undefined })
    place()
    const observer = new ResizeObserver(place); observer.observe(panel)
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place); document.removeEventListener('scroll', place, true) }
  }, [open, panelRef, anchorRef, heightLimit])
}

const reviewLabels = { remembered: 'Вспомнил', partial: 'Частично', forgotten: 'Не вспомнил', known: 'Знаю' }
function formatReviewDate(at) {
  const date = new Date(at)
  const year = date.getFullYear() === new Date().getFullYear() ? '' : ` ${date.getFullYear()}`
  return `${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}${year}, ${date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
}

function ReviewTrail({ entry, currentRef = null }) {
  const [open, setOpen] = useState(false)
  const panelRef = useRef(null), anchorRef = useRef(null), trailRef = useRef(null)
  useLayoutEffect(() => { if (trailRef.current) trailRef.current.open = false; setOpen(false) }, [entry.key])
  useEffect(() => {
    const outside = event => {
      const trail = trailRef.current
      if (!trail?.open || trail.contains(event.target)) return
      // The dismissing gesture belongs to this popup, not the grade/eye behind it.
      event.preventDefault(); event.stopPropagation()
      if (event.type === 'click') { trail.open = false; setOpen(false) }
    }
    const escape = event => {
      if (event.key !== 'Escape' || !trailRef.current?.open) return
      event.preventDefault(); event.stopPropagation()
      trailRef.current.open = false; setOpen(false); anchorRef.current?.focus()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('click', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('click', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [])
  useFloatingStudyPanel(open, panelRef, anchorRef)
  const rows = StudyState.history(entry?.reviewSchedule?.queue?.recent || [], currentRef)
  const caption = event => {
    const values = [event.distance, event.rememberedMeanings].filter(value => Number.isSafeInteger(value) && value >= 0)
    return `${reviewLabels[event.result] || event.result}${values.length ? ` [${values.join(' · ')}]` : ''}`
  }
  if (!rows.length) return null
  return <details ref={trailRef} className="study-review-trail" key={entry.key} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary ref={anchorRef} className={`study-review-outcome ${rows[0].result}`} title="История ответов">{caption(rows[0])}<ChevronDown size={12} /></summary>
    <div ref={panelRef} className="study-review-history" aria-label="История ответов">
      {rows.map(event => <div key={event.id} className={`study-review-outcome ${event.result}`}>
        <span>{caption(event)}</span><time>{formatReviewDate(event.at)}</time>
      </div>)}
    </div>
  </details>
}

function TodayWordCount({ entries, now }) {
  const [data, setData] = useState(null)
  const day = studyDateKey(now)
  const signature = entries.map(entry => `${entry.remoteId || entry.key}:${entry.lastReviewedAt || ''}:${entry.reviewCount}`).join('|')
  useEffect(() => {
    let live = true, request = 0
    const load = async () => {
      const serial = ++request
      const query = `?timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}`
      try {
        const next = REMOTE_STUDY ? await remoteApi(`/api/vocabulary/statistics${query}`) : await learningBridgeGet(`/learning/statistics${query}`)
        if (live && serial === request && Array.isArray(next.days)) setData(next)
      } catch {}
    }
    load()
    const stop = store.subscribe(event => { if (event.type === 'sync-complete' || event.type === 'remote-changed') void load() })
    return () => { live = false; stop() }
  }, [signature, day])
  const row = data?.days?.find(value => value.date === day)
  const ids = new Set(row?.wordIds || [])
  for (const entry of entries) {
    if (entry.lastReviewedAt && studyDateKey(Number(entry.lastReviewedAt) || Date.parse(entry.lastReviewedAt)) === day) ids.add(entry.remoteId || entry.key)
  }
  // Older servers provide only an aggregate. Never add local counts to it and double-count words.
  const count = !data ? null : row && !row.wordIds ? Math.max(row.words, ids.size) : ids.size
  return <span className="study-today-words" title="Уникальные слова, на которые вы ответили сегодня">Сегодня {count ?? '—'}</span>
}

function FeedProgress({ entries, now, currentKey }) {
  const rows = StudyFeed.progress(entries, now)
  const showing = entries.find(entry => entry.key === currentKey && entry.state === 'saved')
  if (showing && !rows.some(entry => entry.key === currentKey)) rows.unshift({ ...showing, firstShowing: true })
  const due = rows.filter(entry => !entry.waitingForSync && StudyModel.isAvailable(entry, now)).length
  return <details className="study-feed-progress">
    <summary><span>В работе <strong>{rows.length}</strong></span><TodayWordCount entries={entries} now={now} /><span>Сейчас {due}<ChevronDown size={15} /></span></summary>
    <div className="study-feed-list" role="region" aria-label="Слова в работе">
      {!rows.length && <p>Слова появятся здесь после первого ответа.</p>}
      {rows.map(entry => <div className={`study-feed-row ${entry.key === currentKey ? 'current' : ''}`} key={entry.key}>
        <div><strong>{entry.sourceText}</strong><span>{entry.firstShowing ? 'Первый показ' : entry.waitingForSync ? 'Расчёт после синхронизации' : formatDue(new Date(StudyModel.availableAt(entry, now)).toISOString())}</span></div>
        <ReviewTrail entry={entry} />
      </div>)}
    </div>
  </details>
}

function cardVerticalScrollOwner(target) {
  for (let node = target; node instanceof Element; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((/(auto|scroll|overlay)/.test(overflow) || node === document.scrollingElement && overflow === 'visible')
      && node.scrollHeight > node.clientHeight + 1) return node
  }
  return null
}

function DeckView({ entries, refresh, onExit, onAddTerm, active = true, resumeAttempt = null }) {
  const savedEntries = useMemo(() => entries.filter((entry) => entry.state === 'saved'), [entries])
  const entriesByKey = useMemo(() => new Map(savedEntries.map((entry) => [entry.key, entry])), [savedEntries])
  const reviewUnits = useMemo(() => StudyModel.buildReviewUnits(savedEntries), [savedEntries])
  const unitsByKey = useMemo(() => new Map(reviewUnits.map((unit) => [unit.key, unit])), [reviewUnits])
  const initialPlan = useMemo(() => {
    const plan = StudyFeed.plan(savedEntries)
    const prior = savedEntries.find(entry => entry.key === resumeAttempt?.wordKey)
    const attempt = prior ? `${prior.key}:${prior.reviewCount}:${prior.dueAt || ''}:${prior.reviewSchedule?.queue?.skip?.operationId || ''}` : ''
    return prior && resumeAttempt.attempt === attempt && plan.keys.includes(prior.key)
      ? { ...plan, keys: [prior.key, ...plan.keys.filter(key => key !== prior.key)] } : plan
  }, [])
  const initialRound = initialPlan.keys
  const [feedPlan, setFeedPlan] = useState(initialPlan)
  const [queue, setQueue] = useState(initialRound)
  const [round, setRound] = useState(1)
  const [roundTotal, setRoundTotal] = useState(initialRound.length)
  const [sessionStats, setSessionStats] = useState({})
  const [queueClock, setQueueClock] = useState(() => Date.now())
  // Reveal belongs to a card within this opening, including Back/undo visits.
  const [revealedKeys, setRevealedKeys] = useState(() => new Set())
  const [revealedPartsByAttempt, setRevealedPartsByAttempt] = useState(() => new Map())
  const [busy, setBusy] = useState(false)
  // Store notifications may contain the newly graded attempt before we advance.
  // Keep the displayed question intact until the next card is ready.
  const [gradingCard, setGradingCard] = useState(null)
  const preferences = React.useContext(StudyPreferencesContext)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedMeanings, setSelectedMeanings] = useState(() => new Set())
  const [traceRef, setTraceRef] = useState(null)
  const tracePromise = useRef(Promise.resolve(null))
  const [dragX, setDragX] = useState(0)
  const [dragY, setDragY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [exiting, setExiting] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const cardMenuRef = useRef(null), cardMenuAnchorRef = useRef(null)
  useFloatingStudyPanel(menuOpen, cardMenuRef, cardMenuAnchorRef, 460)
  const [editingEntry, setEditingEntry] = useState(null)
  const actionBusyRef = useRef(false)
  const [actionNotice, setActionNotice] = useState(null)
  const copyingRef = useRef(false)
  const [autoplay, setAutoplay] = useState(false)
  const [actionHistory, setActionHistory] = useState([])
  const [browsedKey, setBrowsedKey] = useState('')
  const lastKeyRef = useRef('')
  const autoplayRef = useRef(false)
  const autoplayAfterActionRef = useRef(false)
  const lastAutoplayCardKeyRef = useRef('')
  const dragRef = useRef({ pointerId: null, startX: 0, startY: 0, deltaX: 0, dragging: false })
  const contextScrollRef = useRef(null), revealScrollRef = useRef(null)
  const suppressClickRef = useRef(false)
  const durationRef = useRef({ key: '', total: 0, start: null })
  const unitSignature = reviewUnits
    .map((unit) => `${unit.key}:${unit.reviewCount}:${unit.dueAt || ''}:${unit.reviewSchedule?.queue?.cohort || ''}:${unit.reviewSchedule?.queue?.skip?.operationId || ''}`)
    .sort()
    .join('\u0000')
  const browsedEntry = entries.find(entry => entry.key === browsedKey && entry.state !== 'none') || null
  const currentUnit = gradingCard?.unit || (browsedEntry
    ? StudyModel.buildReviewUnits([{ ...browsedEntry, state: 'saved' }])[0]
    : unitsByKey.get(queue[0]) || null)
  const current = gradingCard?.entry || browsedEntry || (currentUnit ? entriesByKey.get(currentUnit.entryKey) || null : null)
  // A repeat is a new recall attempt. Back/undo restores its earlier attempt,
  // including whether the answer was revealed, without exposing future repeats.
  const attemptKey = currentUnit ? `${currentUnit.key}:${currentUnit.reviewCount}:${currentUnit.dueAt || ''}:${currentUnit.reviewSchedule?.queue?.skip?.operationId || ''}` : ''
  const senseOverview = useMemo(() => StudyModel.buildSenseOverview(current), [current])
  const visibleMeaningKeys = [...senseOverview.senses, ...(preferences.showSupport ? senseOverview.support || [] : [])].map(StudyState.meaningKey)
  const revealedParts = revealedPartsByAttempt.get(attemptKey)
  const revealKeys = [...visibleMeaningKeys,
    ...studyCatalogueExampleRows(current, senseOverview, preferences.showSupport)
      .filter(({ sense }) => sense.example?.translation && studyExampleTargetSegments(current, sense, sense.example.translation).some(segment => segment.active))
      .map(({ sense }) => studyExampleRevealKey(sense))]
  const revealed = revealedKeys.has(attemptKey) || revealKeys.length > 0 && revealKeys.every(key => revealedParts?.has(key))
  useLayoutEffect(() => {
    const context = contextScrollRef.current, card = context?.closest('.study-card')
    if (!card) return undefined
    const update = () => {
      for (const surface of card.querySelectorAll('[data-card-swipe-surface], [data-card-scroll-y]')) {
        surface.style.touchAction = cardVerticalScrollOwner(surface) ? 'pan-y' : 'none'
      }
    }
    update()
    const observer = new ResizeObserver(update)
    for (const node of [card, context, context.firstElementChild, document.body]) if (node) observer.observe(node)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [currentUnit?.key])
  const recordTrace = action => {
    const payload = { ...action, client: NATIVE_STUDY ? 'ios' : REMOTE_STUDY ? 'web' : 'extension', at: Date.now() }
    return store.studyAction(payload).then(value => {
      if (value?.changed) notifyNativeStudyDebug(`queue ${JSON.stringify({ kind: payload.kind, at: payload.at,
        word: payload.word, position: value.ref?.position, stream: value.ref?.stream, event: value.event?.id,
        reason: payload.data?.reason, due: payload.data?.dueAt, nextDue: payload.data?.nextDue,
        result: payload.data?.result, operation: payload.data?.operationId,
        dueBefore: payload.data?.dueBefore, dueAfter: payload.data?.dueAfter, forecast: payload.data?.forecast })}`)
      return value
    }).catch(error => { notifyNativeStudyDebug(`queue trace-error ${error.message}`); return null })
  }
  useEffect(() => { setSelectionMode(false); setSelectedMeanings(new Set()); setTraceRef(null) }, [attemptKey])
  useEffect(() => {
    if (!active || busy || editingEntry || browsedKey || document.visibilityState === 'hidden') return
    const details = { reason: feedPlan.reason, selected: current?.key, proposed: feedPlan.keys?.[0],
      dueAt: current?.dueAt, phase: current?.reviewSchedule?.card?.state,
      queue: current?.reviewSchedule?.queue, forecast: { allowed: feedPlan.allowed, workMs: feedPlan.workMs, extraLatenessMs: feedPlan.extraLatenessMs },
      profile: StudyFeed.profile(savedEntries, Date.now()),
      priority: queue.slice(0, 20).map(key => { const e = entriesByKey.get(key); return { key, word: e?.sourceText, dueAt: e?.dueAt, phase: e?.reviewSchedule?.card?.state, lastReviewedAt: e?.lastReviewedAt, cohort: e?.reviewSchedule?.queue?.cohort } }),
      nextDue: feedPlan.nextDue, reserveCount: feedPlan.reserveCount,
      eligible: queue.slice(0, 20), activeCount: savedEntries.filter(e => e.reviewSchedule?.queue?.cohort === 'active').length }
    if (current && attemptKey) {
      let live = true
      tracePromise.current = recordTrace({ kind: 'show', wordKey: current.key, word: current.sourceText, attempt: attemptKey, data: details })
        .then(value => { if (live && value?.ref) setTraceRef(value.ref); return value?.ref || null })
      return () => { live = false }
    }
    void recordTrace({ kind: 'wait', waitKey: `${feedPlan.reason}:${feedPlan.nextDue}`, data: details })
      .then(value => { if (value?.changed) void store.sync({}).catch(() => {}) })
  }, [attemptKey, active, busy, editingEntry, browsedKey, queueClock, feedPlan.reason])
  useEffect(() => {
    if (durationRef.current.key !== attemptKey) durationRef.current = { key: attemptKey, total: 0, start: null }
    const stop = () => {
      const clock = durationRef.current
      if (clock.start !== null) clock.total += performance.now() - clock.start
      clock.start = null
    }
    const update = () => {
      stop()
      if (attemptKey && active && !busy && !editingEntry && document.visibilityState !== 'hidden') durationRef.current.start = performance.now()
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => { stop(); document.removeEventListener('visibilitychange', update) }
  }, [attemptKey, active, busy, editingEntry])
  const captureRevealAnchor = () => {
    const scroll = contextScrollRef.current
    if (scroll && !revealed) {
      const top = scroll.getBoundingClientRect().top
      const anchor = [...scroll.querySelectorAll('.study-example-source-row,.study-example-target')]
        .find(node => node.getBoundingClientRect().bottom > top + 1)
      if (anchor) revealScrollRef.current = { anchor, top: anchor.getBoundingClientRect().top, attemptKey }
    }
  }
  const revealCurrent = () => {
    captureRevealAnchor()
    if (currentUnit) setRevealedKeys((keys) => new Set(keys).add(attemptKey))
  }
  const revealExample = (sense, meaningSense) => {
    if (!currentUnit || revealed) return
    captureRevealAnchor()
    setRevealedPartsByAttempt(previous => {
      const next = new Map(previous), parts = new Set(previous.get(attemptKey))
      parts.add(studyExampleRevealKey(sense))
      if (meaningSense) parts.add(StudyState.meaningKey(meaningSense))
      next.set(attemptKey, parts)
      return next
    })
  }
  useLayoutEffect(() => {
    const saved = revealScrollRef.current, scroll = contextScrollRef.current
    if (!saved || !scroll) return
    revealScrollRef.current = null
    if (saved.attemptKey === attemptKey && saved.anchor.isConnected) scroll.scrollTop += saved.anchor.getBoundingClientRect().top - saved.top
  }, [revealed, revealedParts, attemptKey])
  const sessionAnswerCount = Object.values(sessionStats).reduce((sum, stats) => sum + stats.total, 0)
  const selectedVisible = visibleMeaningKeys.filter(key => selectedMeanings.has(key))
  const meaningSelection = { enabled: selectionMode, keys: selectedMeanings,
    toggleMode: () => setSelectionMode(value => !value),
    toggle: sense => setSelectedMeanings(previous => { const next = new Set(previous), key = StudyState.meaningKey(sense); next.has(key) ? next.delete(key) : next.add(key); return next }) }

  useEffect(() => {
    if (!active || busy || editingEntry) return undefined
    const now = Date.now()
    const plan = StudyFeed.plan(savedEntries, now)
    const eligible = plan.keys
    setFeedPlan(plan)
    setQueue((previous) => {
      // Do not pull away the card being read when another repeat becomes due.
      // Priority is reconsidered at every answer boundary, never append-only.
      const reading = previous[0]
      const readingEntry = entriesByKey.get(reading)
      const next = readingEntry && !readingEntry.reviewSchedule?.pending && StudyModel.isDue(readingEntry, now)
        ? [reading, ...eligible.filter(key => key !== reading)] : eligible
      return previous.length === next.length && previous.every((key, i) => key === next[i]) ? previous : next
    })
    const nextDue = plan.nextDue
    if (!Number.isFinite(nextDue) && queue.length) return undefined
    const timer = setTimeout(() => setQueueClock(Date.now()), Math.min(queue.length ? 2_147_483_647 : 5000, nextDue - now + 20 || 5000))
    return () => clearTimeout(timer)
  }, [unitSignature, queueClock, active, busy, editingEntry, queue.length === 0])

  useEffect(() => {
    const resume = () => { if (document.visibilityState !== 'hidden') setQueueClock(Date.now()) }
    window.addEventListener('focus', resume)
    window.addEventListener('pageshow', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('focus', resume)
      window.removeEventListener('pageshow', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [])

  useEffect(() => {
    dragRef.current = { pointerId: null, startX: 0, startY: 0, deltaX: 0, dragging: false }
    suppressClickRef.current = false
    setDragX(0); setDragY(0)
    setDragging(false)
    setExiting('')
    setMenuOpen(false)
  }, [currentUnit?.key])

  useEffect(() => {
    if (!actionNotice) return undefined
    const timer = setTimeout(() => setActionNotice(null), actionNotice.error ? 5000 : 2200)
    return () => clearTimeout(timer)
  }, [actionNotice])
  const notice = actionNotice && <div className={`study-action-notice ${actionNotice.error ? 'error' : ''}`} role="status">
    {!actionNotice.error && <Check size={16} />}{actionNotice.text}
  </div>

  useEffect(() => {
    let active = true
    readYoutubePreferences().then((preferences) => {
      if (active) setAutoplay(preferences.learning_card_autoplay === true)
    }).catch(() => {})
    const update = event => setAutoplay(event.detail?.learning_card_autoplay === true)
    window.addEventListener('sc-study-preferences', update)
    return () => { active = false; window.removeEventListener('sc-study-preferences', update) }
  }, [])

  useEffect(() => {
    autoplayRef.current = autoplay
  }, [autoplay])

  useEffect(() => {
    const nextKey = currentUnit?.key || ''
    if (!nextKey || !active) return
    const shouldSpeak = LearningUtils?.shouldAutoplayCard?.(lastAutoplayCardKeyRef.current, nextKey)
    lastAutoplayCardKeyRef.current = nextKey
    if (autoplayAfterActionRef.current && autoplayRef.current && shouldSpeak && current?.sourceText) speakLearningText(current.sourceText)
  }, [currentUnit?.key])

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
    if (!current || !currentUnit || current.state !== 'saved' || actionBusyRef.current || busy || editingEntry) return
    actionBusyRef.current = true
    setGradingCard({ entry: current, unit: currentUnit })
    setBusy(true)
    setMenuOpen(false)
    const snapshot = {
      queue: [...queue],
      round,
      roundTotal,
      sessionStats: { ...sessionStats },
      lastKey: lastKeyRef.current,
      entryBefore: current,
      browsedKey, traceRef,
    }
    const mode = StudyModel.reviewMode({ ...currentUnit, state: 'saved' })
    const nextStats = StudyModel.nextSessionStats(sessionStats, currentUnit.key, result)
    // Following a dictionary alternative deliberately leaves its parent card.
    // Advance beyond that navigation chain once; Back still restores its exact
    // snapshot. This is not a cooldown or a change to the parents' schedules.
    const navigationParents = new Set(browsedKey
      ? actionHistory.filter(action => action.type === 'navigate').map(action => action.entryBefore?.key) : [])
    const nextQueue = updated => StudyFeed.plan(savedEntries.map(entry => entry.key === current.key ? updated || entry : entry)
      .filter(entry => !navigationParents.has(entry.key)), Date.now()).keys
    notifyNativeStudyDebug(`review start key=${currentUnit.key} result=${result} queue=${queue.length} visibility=${document.visibilityState}`)
    const reviewPromise = tracePromise.current.then(trace => store.queueReview({
      key: current.key,
      result,
      mode,
      durationMs: Math.round(durationRef.current.total + (durationRef.current.start === null ? 0 : performance.now() - durationRef.current.start)),
      recallVersion: 2,
      trace: !browsedKey && trace ? { stream: trace.stream, position: trace.position, id: trace.id } : undefined,
      meaningRecall: result === 'partial' && selectionMode ? { assessed: visibleMeaningKeys, remembered: selectedVisible } : undefined,
    })).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    )
    let transitionReason = 'none'
    if (animate) {
      setDragging(false)
      setExiting(result)
      transitionReason = await waitForStudyCardExit()
    }
    lastKeyRef.current = currentUnit.key
    let remaining = []
    const advance = updated => {
      remaining = nextQueue(updated)
      autoplayAfterActionRef.current = true
      setGradingCard(null)
      setSelectionMode(false)
      setSelectedMeanings(new Set())
      setTraceRef(null)
      setQueueClock(Date.now())
      setSessionStats(nextStats)
      setQueue(remaining)
      setBrowsedKey('')
      setDragX(0); setDragY(0)
      setDragging(false)
      setExiting('')
    }
    try {
      const outcome = await reviewPromise
      if (outcome.error) throw outcome.error
      const reviewResult = outcome.value
      await recordTrace({ kind: 'review', wordKey: current.key, word: current.sourceText,
        data: { result, operationId: reviewResult?.operation?.id, before: current.reviewSchedule,
          after: reviewResult?.entry?.reviewSchedule, dueBefore: current.dueAt, dueAfter: reviewResult?.entry?.dueAt,
          rememberedMeanings: result === 'partial' && selectionMode ? selectedVisible : undefined } })
      // Only committed answers change the visible progress or admit a new word.
      // Offline storage commits the card and outbox together; no network wait.
      if (animate && transitionReason !== 'timer') flushSync(() => advance(reviewResult?.entry))
      else advance(reviewResult?.entry)
      notifyNativeStudyDebug(`review advance key=${currentUnit.key} result=${result} transition=${transitionReason} next=${remaining[0] || '-'} queue=${remaining.length}`)
      setActionHistory((history) => [...history, {
        type: 'review',
        snapshot,
        operation: reviewResult?.operation,
        entryBefore: reviewResult?.entryBefore || current,
      }].slice(-200))
      if (result === 'known') setActionNotice({ text: `«${current.sourceText}» — повторим позже` })
      notifyNativeStudyDebug(`review settled key=${currentUnit.key} result=${result} ok=true`)
      refresh({ sync: false }).catch(() => {})
      store.sync({}).catch(error => setActionNotice({ text: `Ответ сохранён, но синхронизация не завершена. ${error.message || ''}`, error: true }))
    } catch (error) {
      setQueue(snapshot.queue)
      setBrowsedKey(snapshot.browsedKey)
      setRound(snapshot.round)
      setRoundTotal(snapshot.roundTotal)
      setSessionStats(snapshot.sessionStats)
      lastKeyRef.current = snapshot.lastKey
      setActionNotice({ text: `Не удалось сохранить ответ. ${error.message || 'Попробуйте ещё раз.'}`, error: true })
      notifyNativeStudyDebug(`review settled key=${currentUnit.key} result=${result} ok=false error=${error.message || 'unknown'}`)
      void recordTrace({ kind: 'review-error', wordKey: current.key, word: current.sourceText, data: { result, error: error.message } })
      console.error('[Study] review failed', error)
    } finally {
      actionBusyRef.current = false
      setGradingCard(null)
      setBusy(false)
      setDragX(0); setDragY(0)
      setDragging(false)
      setExiting('')
    }
  }, [busy, current, currentUnit, queue, refresh, round, roundTotal, sessionStats, savedEntries, browsedKey, editingEntry, actionHistory, traceRef, selectionMode, selectedMeanings, preferences.showSupport])

  useEffect(() => {
    if (!active || editingEntry) return undefined
    const onKeyDown = (event) => {
      const target = event.target
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if (target?.closest?.('button, a, summary, .study-feed-list') && !target.closest('.reveal-button')) return
      const revealKey = event.key === 'Enter' || event.key === ' ' || event.code === 'Space'
      if (revealKey && !revealed && current) {
        event.preventDefault()
        if (!event.repeat) revealCurrent()
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
  }, [busy, current, revealed, review, active, editingEntry])

  const onPointerDown = (event) => {
    if (busy || editingEntry || event.button !== 0 || event.isPrimary === false) return
    if (event.target?.closest?.('.study-synonym-popover, .study-card-menu, .study-review-trail, button, a, input, textarea, select, summary')) return
    if (event.target?.closest?.('[data-selectable-text]')) {
      dragRef.current = { pointerId: null, startX: 0, startY: 0, deltaX: 0, dragging: false }
      return
    }
    const scrollNode = cardVerticalScrollOwner(event.target)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      deltaX: 0,
      deltaY: 0,
      dragging: false,
      axis: null,
      scrollNode,
      startScrollTop: scrollNode?.scrollTop || 0,
      canScrollY: !!scrollNode && scrollNode.scrollHeight > scrollNode.clientHeight + 1,
    }
    setExiting('')
  }

  const onPointerMove = (event) => {
    const pointer = dragRef.current
    if (pointer.pointerId !== event.pointerId) return
    const rawDeltaX = event.clientX - pointer.startX
    const rawDeltaY = event.clientY - pointer.startY
    if (!pointer.axis) {
      pointer.axis = StudyModel.cardGestureAxis(rawDeltaX, rawDeltaY, pointer.canScrollY)
      if (!pointer.axis) return
      pointer.dragging = pointer.axis === 'swipe' || pointer.axis === 'partial'
      suppressClickRef.current = true
      if (pointer.dragging) {
        try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch {}
        try { window.getSelection?.()?.removeAllRanges?.() } catch {}
      }
      setDragging(pointer.dragging)
    }
    // A scrollable ancestor owns vertical motion even at its top/bottom edge.
    if (pointer.axis === 'scroll' || pointer.axis === 'vertical') return
    event.preventDefault()
    if (pointer.axis === 'partial') {
      pointer.deltaY = Math.max(0, Math.min(360, rawDeltaY))
      setDragY(pointer.deltaY)
    } else {
      pointer.deltaX = Math.max(-360, Math.min(360, rawDeltaX))
      setDragX(pointer.deltaX)
    }
  }

  const finishPointer = (event, cancelled = false) => {
    const pointer = dragRef.current
    if (pointer.pointerId !== event.pointerId) return
    if (pointer.dragging) {
      try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch {}
    }
    const result = !cancelled && pointer.dragging ? pointer.axis === 'partial'
      ? pointer.deltaY >= SWIPE_THRESHOLD ? 'partial' : null
      : StudyModel.swipeResult(pointer.deltaX, SWIPE_THRESHOLD) : null
    dragRef.current = { pointerId: null, startX: 0, startY: 0, deltaX: 0, dragging: false }
    setDragging(false)
    if (result) review(result)
    else { setDragX(0); setDragY(0) }
    if (pointer.axis) window.setTimeout(() => { suppressClickRef.current = false }, 0)
  }

  const suppressClickAfterDrag = (event) => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  const restoreDeckSnapshot = (snapshot) => {
    setQueue(snapshot.queue)
    setBrowsedKey(snapshot.browsedKey || '')
    setRound(snapshot.round)
    setRoundTotal(snapshot.roundTotal)
    setSessionStats(snapshot.sessionStats)
    lastKeyRef.current = snapshot.lastKey
    if (snapshot.traceRef) {
      setTraceRef(snapshot.traceRef)
      void recordTrace({ kind: 'restore', ref: snapshot.traceRef, data: { navigation: 'back' } })
    }
    setDragX(0); setDragY(0)
    setDragging(false)
    setExiting('')
  }

  const skipCurrent = async () => {
    if (!current || !currentUnit || current.state !== 'saved' || busy || actionBusyRef.current || editingEntry) return
    actionBusyRef.current = true
    setGradingCard({ entry: current, unit: currentUnit }); setBusy(true); setMenuOpen(false)
    const snapshot = { queue: [...queue], round, roundTotal, sessionStats: { ...sessionStats },
      lastKey: lastKeyRef.current, entryBefore: current, browsedKey, traceRef }
    try {
      const result = await store.queueSkip({ key: current.key })
      await recordTrace({ kind: 'skip', wordKey: current.key, word: current.sourceText,
        data: { operationId: result.operation?.id, until: result.entry?.reviewSchedule?.queue?.skip?.until,
          dueBefore: current.dueAt, dueAfter: result.entry?.dueAt } })
      const parents = new Set(browsedKey ? actionHistory.filter(action => action.type === 'navigate').map(action => action.entryBefore?.key) : [])
      const plan = StudyFeed.plan(savedEntries.map(entry => entry.key === current.key ? result.entry : entry)
        .filter(entry => !parents.has(entry.key)), Date.now())
      autoplayAfterActionRef.current = true
      setActionHistory(history => [...history, { type: 'skip', snapshot, operation: result.operation, entryBefore: result.entryBefore || current }].slice(-200))
      setGradingCard(null); setSelectionMode(false); setSelectedMeanings(new Set()); setTraceRef(null)
      setFeedPlan(plan); setQueue(plan.keys); setBrowsedKey(''); setQueueClock(Date.now())
      lastKeyRef.current = currentUnit.key
      void refresh({ sync: false }).catch(() => {})
      void store.sync({}).catch(error => setActionNotice({ text: `Пропуск сохранён, но синхронизация не завершена. ${error.message || ''}`, error: true }))
    } catch (error) {
      restoreDeckSnapshot(snapshot)
      setActionNotice({ text: `Не удалось пропустить слово. ${error.message || ''}`, error: true })
    } finally { actionBusyRef.current = false; setGradingCard(null); setBusy(false) }
  }

  const undoLastAction = async () => {
    const lastAction = actionHistory[actionHistory.length - 1]
    if (!lastAction || busy || actionBusyRef.current || editingEntry) return
    actionBusyRef.current = true
    setBusy(true)
    try {
      if (lastAction.type === 'skip') {
        await store.undoSkip({ key: lastAction.entryBefore.key, entryBefore: lastAction.entryBefore, operation: lastAction.operation })
      } else if (lastAction.type === 'review') {
        await store.undoReview({
          key: lastAction.entryBefore.key,
          entryBefore: lastAction.entryBefore,
          operation: lastAction.operation,
        })
      } else if (lastAction.type === 'delete' || lastAction.type === 'archive') {
        await store.setState({ key: lastAction.entryBefore.key, state: lastAction.entryBefore.state, toggle: false })
      }
      await recordTrace({ kind: 'undo', wordKey: lastAction.entryBefore.key, word: lastAction.entryBefore.sourceText,
        data: { operationId: lastAction.operation?.id, type: lastAction.type } })
      autoplayAfterActionRef.current = true
      restoreDeckSnapshot(lastAction.snapshot)
      setActionHistory((history) => history.slice(0, -1))
      await refresh({ sync: false })
      store.sync({ fresh: true }).then(result => {
        if (result?.online === false) setActionNotice({ text: 'Отмена сохранена на устройстве. Сервер её пока не подтвердил.', error: true })
      }).catch(error => setActionNotice({ text: `Сервер не подтвердил отмену. ${error.message || ''}`, error: true }))
    } catch (error) {
      setActionNotice({ text: `Не удалось отменить действие. ${error.message || 'Попробуйте ещё раз.'}`, error: true })
    } finally {
      actionBusyRef.current = false
      setBusy(false)
    }
  }

  const moveCurrentOut = async (state, type) => {
    if (!current || busy || actionBusyRef.current || editingEntry) return
    actionBusyRef.current = true
    const snapshot = {
      queue: [...queue],
      round,
      roundTotal,
      sessionStats: { ...sessionStats },
      lastKey: lastKeyRef.current,
      entryBefore: current,
      browsedKey,
    }
    setBusy(true)
    setMenuOpen(false)
    try {
      await store.setState({ ...current, state, toggle: false })
      setActionNotice({ text: type === 'archive' ? `«${current.sourceText}» — в архиве` : `«${current.sourceText}» — удалено` })
      setActionHistory((history) => [...history, { type, snapshot, entryBefore: current }])
      setQueue((previous) => previous.filter((key) => unitsByKey.get(key)?.entryKey !== current.key))
      setBrowsedKey('')
      await refresh({ sync: false }).catch(error => console.warn('[Study] refresh after card action failed', error))
      store.sync({}).catch(() => {})
    } catch (error) {
      setActionNotice({ text: type === 'archive' ? 'Не удалось перенести в архив' : 'Не удалось удалить слово', error: true })
      console.error('[Study] card action failed', error)
    } finally {
      actionBusyRef.current = false
      setBusy(false)
    }
  }
  const archiveCurrent = () => moveCurrentOut('archived', 'archive')
  const removeCurrent = () => moveCurrentOut('none', 'delete')
  const copyCurrent = async () => {
    setMenuOpen(false)
    if (copyingRef.current) return
    copyingRef.current = true
    try {
      const copied = await copyPlainText(StudyModel.cardDebugText(current))
      setActionNotice({ text: copied ? 'Скопировано' : 'Не удалось скопировать', error: !copied })
    } catch {
      setActionNotice({ text: 'Не удалось скопировать', error: true })
    } finally { copyingRef.current = false }
  }

  const openAlternative = (term, saved) => {
    if (busy || actionBusyRef.current || editingEntry) return
    if (!saved) { onAddTerm(term); return }
    if (saved.key === current?.key) return
    autoplayAfterActionRef.current = true
    setActionHistory(history => [...history, { type: 'navigate', entryBefore: current,
      snapshot: { queue: [...queue], round, roundTotal, sessionStats: { ...sessionStats }, lastKey: lastKeyRef.current, browsedKey } }])
    setQueue(previous => previous.filter(key => key !== currentUnit?.key))
    setBrowsedKey(saved.key)
  }

  if (!savedEntries.length && !current) {
    return (
      <section className="deck workspace">
        {notice}
        <div className="deck-empty"><BookOpen size={58} /><h2>Добавьте карточки</h2><p>Сохраните слова из YouTube или добавьте их вручную в словаре.</p></div>
        {actionHistory.length > 0 && <button type="button" className="secondary-button" onClick={undoLastAction} disabled={busy}><ArrowLeft size={16} />Назад</button>}
      </section>
    )
  }

  if (!current) {
    const nextDue = reviewUnits
      .filter(unit => StudyModel.availableAt(unit) > Date.now())
      .sort((a, b) => StudyModel.availableAt(a) - StudyModel.availableAt(b))[0]
    return (
      <section className="deck workspace">
        {notice}
        <FeedProgress entries={savedEntries} now={queueClock} />
        <div className="deck-empty">
          <CheckCircle2 size={58} />
          <h2>{feedPlan.reason === 'sync' || feedPlan.reason === 'schedule' ? 'Уточняем расписание' : nextDue ? 'Сейчас повторять нечего' : 'На сегодня всё'}</h2>
          {feedPlan.reserveCount > 0 && <p>Новые слова пока не добавляем, чтобы успеть повторить начатые.</p>}
          <p>{feedPlan.reason === 'sync' || feedPlan.reason === 'schedule' ? 'Ответы сохранены. Расписание уточнится после синхронизации.'
            : nextDue ? `Следующее повторение ${formatDue(new Date(StudyModel.availableAt(nextDue)).toISOString())}` : 'Новые карточки появятся после добавления слов.'}</p>
          <div className="deck-complete-actions">
            <button type="button" className="secondary-button" onClick={undoLastAction} disabled={!actionHistory.length || busy}><ArrowLeft size={16} />Назад</button>
            <button type="button" className="primary-button" onClick={onExit}>К карточкам</button>
          </div>
        </div>
      </section>
    )
  }

  const dragProgress = Math.min(1, Math.abs(dragX) / SWIPE_THRESHOLD)
  const rememberedProgress = dragX < 0 ? dragProgress : 0
  const forgottenProgress = dragX > 0 ? dragProgress : 0
  const partialProgress = Math.min(1, dragY / SWIPE_THRESHOLD)
  const transform = exiting
    ? exiting === 'partial' ? 'translate3d(0,115%,0)'
      : `translate3d(${exiting === 'remembered' ? '-115%' : '115%'},0,0) rotate(${exiting === 'remembered' ? '-5deg' : '5deg'})`
    : `translate3d(${dragX}px,${dragY}px,0) rotate(${dragX / 90}deg)`
  return (
    <section className="deck workspace" aria-label="Карточки">
      {notice}
      <FeedProgress entries={savedEntries} now={queueClock} currentKey={current?.key} />
      <div className="study-card-stage">
        {busy && <div className="study-card-saving" role="status">Сохраняю…</div>}
        <div
          key={currentUnit.key}
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
          onLostPointerCapture={(event) => {
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) return
            finishPointer(event, true)
            notifyNativeStudyCardGesture(false)
          }}
        >
          <div className="study-card-header" data-card-swipe-surface>
            <span className="study-card-progress">
              {!!senseOverview.support?.length && <>
              <button type="button" role="switch" aria-checked={preferences.showSupport} aria-label="Показывать дополнительные значения"
                className={`settings-switch study-support-switch ${preferences.showSupport ? 'on' : ''}`}
                disabled={preferences.saving} onClick={preferences.toggleSupport}><span /></button>
              <span title="Скрыто дополнительных значений">[{preferences.showSupport ? 0 : senseOverview.support?.length || 0}]</span>
              </>}
            </span>
            <div className="study-card-header-actions">
              <button type="button" className="undo-button" onClick={undoLastAction} disabled={!actionHistory.length || busy} title="Отменить последнее действие">
                <ArrowLeft size={15} />Back
              </button>
              <button type="button" className="skip-button" onClick={skipCurrent}
                disabled={busy || current.state !== 'saved'} title="Пропустить на 10 минут" aria-label="Skip">
                <SkipForward size={15} />Skip
              </button>
              <button type="button" className="study-card-tool" onClick={copyCurrent} title="Скопировать карточку" aria-label="Скопировать карточку"><Copy size={17} /></button>
              <div className="study-card-menu-shell">
                <button type="button" ref={cardMenuAnchorRef} className="study-card-tool" disabled={busy} onClick={() => setMenuOpen((value) => !value)} title="Действия со словом" aria-label="Действия со словом" aria-expanded={menuOpen}>
                  <MoreHorizontal size={20} />
                </button>
                {menuOpen && (
                  <div ref={cardMenuRef} className="study-card-menu">
                    <button type="button" disabled={busy || current.state !== 'saved'} onClick={() => review('known', { animate: false })}><CheckCircle2 size={16} />Я знаю</button>
                    <button type="button" onClick={() => { setMenuOpen(false); setEditingEntry(current) }}><Pencil size={16} />Редактировать перевод</button>
                    {current.state !== 'archived' && <button type="button" onClick={archiveCurrent}><Archive size={16} />В архив</button>}
                    <button type="button" className="danger" onClick={removeCurrent}><Trash2 size={16} />Удалить из словаря</button>
                    {current.senseCatalog?.source?.url && <details className="study-card-source-details">
                      <summary>Источник</summary><SenseSourceAttribution catalog={current.senseCatalog} />
                    </details>}
                  </div>
                )}
              </div>
            </div>
          </div>
          {!!current.reviewSchedule?.queue?.recent?.length && <div className="study-card-history"><ReviewTrail entry={current} currentRef={traceRef} /></div>}
          <div
            className={`study-question-slot ${revealed ? '' : 'revealable'}`}
            data-card-swipe-surface
            onClick={(event) => {
              if (revealed || event.target?.closest?.('.study-card-speak')) return
              revealCurrent()
            }}
          >
            <div className="study-term-heading">
              <h2 data-selectable-text>{current.sourceText}</h2>
              <ExpressionBadge entry={current} />
            </div>
            <button type="button" className="study-card-tool study-card-speak" onClick={() => speakLearningText(current.sourceText)} title="Произнести слово" aria-label="Произнести слово">
              <Volume2 size={20} />
            </button>
          </div>
          <div className={`study-answer-slot study-sense-slot ${revealed ? 'revealed' : ''}`} data-card-swipe-surface>
            <StudyMeaningSummary key={currentUnit.key} senses={senseOverview.senses} support={senseOverview.support} catalogue={current.senseCatalog} revealed={revealed} revealedParts={revealedParts} entries={entries} onAlternative={openAlternative} selection={meaningSelection} recalled={current.reviewSchedule?.queue?.meaningRecall || {}} />
          </div>
          <div ref={contextScrollRef} className="study-context-slot visible" data-card-scroll-y tabIndex={0} role="region" aria-label="Примеры значений">
            <div className="study-context-content">
              <StudyCatalogueExamples key={attemptKey} entry={current} overview={senseOverview} revealed={revealed} revealedParts={revealedParts} onRevealExample={revealExample} examplesToggleable defaultTranslationsVisible={false} numberedHeadings />
            </div>
          </div>
          {!revealed && (
            <button
              type="button"
              className="study-reveal-eye"
              onClick={revealCurrent}
              aria-label="Показать перевод"
              title="Показать перевод"
            ><Eye /></button>
          )}
          <div className="review-actions" data-card-swipe-surface>
            <button
              type="button"
              className="remembered"
              style={{
                '--review-fill-alpha': String(rememberedProgress * 0.58),
                '--review-ring-alpha': String(rememberedProgress * 0.42),
              }}
              onClick={() => review('remembered')}
              disabled={busy || current.state !== 'saved'}
            >
              <ArrowLeft size={18} /><span>Я вспомнил</span>
            </button>
            <button type="button" className="partial" onClick={() => review('partial', { animate: false })}
              style={{ background: partialProgress ? `rgba(88,28,135,${partialProgress * .58})` : undefined }}
              disabled={busy || current.state !== 'saved'} title="Вспомнил частично" aria-label="Частично">
              <span>Частично{selectionMode ? ` [${selectedVisible.length}]` : ''}</span>
            </button>
            <button
              type="button"
              className="forgotten"
              style={{
                '--review-fill-alpha': String(forgottenProgress * 0.58),
                '--review-ring-alpha': String(forgottenProgress * 0.42),
              }}
              onClick={() => review('forgotten')}
              disabled={busy || current.state !== 'saved'}
            >
              <span>Я не вспомнил</span><ArrowRight size={18} />
            </button>
          </div>
        </div>
      </div>
      {editingEntry && <TranslationEditor key={editingEntry.key} entry={editingEntry} onChanged={refresh}
        onClose={() => setEditingEntry(null)} onSaved={() => { setEditingEntry(null); setActionNotice({ text: 'Перевод обновлён' }) }} />}
    </section>
  )
}

function practiceVocabularyPack(entries, limit = 12) {
  const candidates = entries.filter((entry) => entry.state === 'saved' && entry.kind === 'word')
  const byKey = new Map(candidates.map((entry) => [entry.key, entry]))
  const units = new Map(StudyModel.buildReviewUnits(candidates).map((unit) => [unit.key, unit]))
  const seen = new Set()
  return StudyModel.buildRound(candidates, {})
    .map((key) => byKey.get(units.get(key)?.entryKey))
    .filter(Boolean)
    .filter((entry) => !seen.has(entry.key) && seen.add(entry.key))
    .slice(0, limit)
}

function vocabularyFormLookup(entries) {
  const lookup = new Map()
  for (const entry of entries.filter((item) => item.state === 'saved' || item.state === 'known')) {
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

function InteractiveEnglishText({ text, lookup, onWord, onWordHover, onWordLeave, highlights = [] }) {
  useVocabularySaveState()
  const pointerTypeRef = useRef('')
  // A saved phrase owns only its complete occurrence, not every occurrence
  // of its component words. Keep individual word clicks/range selection.
  const phraseStates = new Map([...lookup].filter(([form]) => form.includes(' '))
    .map(([form, entry]) => [form, { entry, operation: vocabularySaves.get(form, entry.lemma) }]))
  for (const operation of vocabularySaves.all()) {
    if (!vocabularySaves.pending(operation) && operation.phase !== 'error') continue
    for (const form of [operation.key, operation.term, ...(operation.observedForms || [])]) {
      const key = vocabularySaves.keyFor(form)
      if (key.includes(' ')) phraseStates.set(key, { ...phraseStates.get(key), operation })
    }
  }
  const phraseRanges = []
  for (const [form, state] of phraseStates) {
    const escaped = form.split(' ').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}'’_-])${escaped}(?![\\p{L}\\p{N}'’_-])`, 'giu')
    for (const match of text.matchAll(pattern)) phraseRanges.push({ start: match.index, end: match.index + match[0].length, ...state })
  }
  const [range, setRange] = useState(null)
  const callbacks = useRef({ text, onWord }); callbacks.current = { text, onWord }
  const gesture = useMemo(() => window.__scCreateWordGesture({ getText: () => callbacks.current.text,
    onSelect: selection => callbacks.current.onWord?.(selection), onRange: setRange }), [])
  useEffect(() => { gesture.reset({ keepPending: true }); return () => gesture.reset({ keepPending: true }) }, [text, gesture])
  useEffect(() => {
    const cancel = event => { if (event.key === 'Escape') gesture.reset() }
    document.addEventListener('keydown', cancel)
    return () => document.removeEventListener('keydown', cancel)
  }, [gesture])
  const parts = LearningUtils?.segmentWords?.(text, 'en') || [{ text, word: false }]
  const savingIndexes = new Set(LearningUtils.pendingSaveWordIndexes([{ text }], 0, vocabularySaves.all(), 'en'))
  let highlightOffset = 0, offset = 0, wordIndex = 0
  const ranges = highlights.map(part => {
    const start = highlightOffset; highlightOffset += part.text.length
    return part.active ? { start, end: highlightOffset } : null
  }).filter(Boolean)
  return parts.map((part, index) => {
    const start = offset; offset += part.text.length
    const end = offset
    const indexInText = part.word ? wordIndex++ : null
    if (!part.word || !/[a-z]/i.test(part.text) || /[\u0400-\u04ff]/.test(part.text)) return <React.Fragment key={`${part.index ?? index}-text`}>{part.text}</React.Fragment>
    const entry = lookup.get(part.normalized)
    const phrase = phraseRanges.filter(range => start >= range.start && end <= range.end)
      .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]
    const wordOperation = vocabularySaves.get(part.normalized, entry?.lemma,
      Lexeme?.canonicalIdentity?.({ kind: 'word', sourceLang: 'en', targetLang: 'ru', sourceText: part.text, context: text })?.lemma)
    const operation = vocabularySaves.pending(phrase?.operation) ? phrase.operation : wordOperation || phrase?.operation
    return (
      <button
        type="button"
        key={`${part.index ?? index}-${part.text}`}
        className="practice-word"
        data-word={part.normalized}
        data-vocabulary-state={phrase?.entry?.state || entry?.state || ''}
        data-focus-term={ranges.some(range => start < range.end && offset > range.start) ? '1' : undefined}
        data-saving={savingIndexes.has(indexInText) || vocabularySaves.pending(operation) ? '1' : undefined}
        data-save-error={operation?.phase === 'error' ? '1' : undefined}
        data-phrase-selected={range && start < range.end && end > range.start ? '1' : undefined}
        onPointerDown={event => { pointerTypeRef.current = event.pointerType }}
        onPointerEnter={(event) => { gesture.hover({ start, end }); onWordHover?.({ word: part.text, entry, anchor: event.currentTarget }) }}
        onPointerLeave={() => onWordLeave?.()}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}
        onClick={event => {
          event.stopPropagation()
          const pointerType = pointerTypeRef.current; pointerTypeRef.current = ''
          const selectedText = window.getSelection?.()
          if (selectedText && !selectedText.isCollapsed && !event.shiftKey && pointerType !== 'touch') return
          if (pointerType === 'touch') selectedText?.removeAllRanges()
          const rect = event.currentTarget.getBoundingClientRect()
          const owner = event.currentTarget.closest('.practice-word-card')
          gesture.click({ ...part, start, end, entry, anchor: event.currentTarget,
            owner, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } },
            { detail: event.detail, shiftKey: event.shiftKey, immediate: !owner, pointerType, timeStamp: event.timeStamp })
        }}
        onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); window.getSelection()?.removeAllRanges(); gesture.doubleClick({ start, end }) }}
      >{part.text}</button>
    )
  })
}

function PracticeQuickWordPopover({ selection, revision }) {
  const popoverRef = useRef(null)
  const [position, setPosition] = useState(null)
  const rows = selection ? practiceQuickRows(selection.word, selection.entry) : []
  const key = selection ? practiceQuickTranslationKey(selection.word) : ''
  const value = rows[0]?.value || (practiceQuickTranslationPending.has(key) ? 'Перевожу…' : selection?.word || '')

  useLayoutEffect(() => {
    if (!selection?.rect || !popoverRef.current) {
      setPosition(null)
      return
    }
    const rect = popoverRef.current.getBoundingClientRect()
    const margin = 10
    const gap = 7
    const left = LearningUtils?.quickWordPopoverLeft?.({
      anchorLeft: selection.rect.left,
      anchorWidth: selection.rect.width,
      popoverWidth: rect.width,
      viewportWidth: window.innerWidth,
      margin,
    }) ?? Math.max(margin, selection.rect.left)
    const above = selection.rect.top - rect.height - gap
    const top = above >= margin
      ? above
      : Math.min(window.innerHeight - rect.height - margin, selection.rect.bottom + gap)
    setPosition({ left: Math.round(left), top: Math.round(Math.max(margin, top)) })
  }, [revision, selection?.rect, selection?.word, value])

  if (!selection || !value) return null
  return (
    <aside
      ref={popoverRef}
      className={`practice-quick-word-popover ${rows.length ? '' : 'loading'}`}
      style={{
        left: position?.left ?? selection.rect.left,
        top: position?.top ?? selection.rect.top,
        visibility: position ? 'visible' : 'hidden',
      }}
      role="tooltip"
    >{value}</aside>
  )
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

const practiceWordRequests = new Map()
function practiceWordRequest(key, request) {
  if (practiceWordRequests.has(key)) return practiceWordRequests.get(key)
  const pending = request().catch(error => { practiceWordRequests.delete(key); throw error })
  practiceWordRequests.set(key, pending)
  if (practiceWordRequests.size > 200) practiceWordRequests.delete(practiceWordRequests.keys().next().value)
  return pending
}

// Position from the live selected line and measured contents. The body scrolls
// within the available side; it can never grow across the selected sentence.
function usePracticeWordPosition(selection, popoverRef) {
  const [position, setPosition] = useState(null)
  useLayoutEffect(() => {
    const popover = popoverRef.current
    if (!popover || !selection) return undefined
    const update = () => {
      const viewport = window.visualViewport
      const viewportTop = viewport?.offsetTop || 0
      const viewportLeft = viewport?.offsetLeft || 0
      const viewportWidth = viewport?.width || window.innerWidth
      const viewportBottom = Math.min(viewportTop + (viewport?.height || window.innerHeight),
        NATIVE_STUDY && Number.isFinite(window.__scStudyAvailableBottom) ? window.__scStudyAvailableBottom : Infinity)
      const viewportHeight = Math.max(1, viewportBottom - viewportTop)
      const margin = 10
      const gap = 9
      const anchor = selection.anchor?.isConnected ? selection.anchor.getBoundingClientRect() : selection.rect
      if (!anchor) return
      const message = selection.anchor?.closest('.practice-message-english,.practice-correction')?.getBoundingClientRect()
      const rawProtected = message && message.height < viewportHeight * .45 ? message : anchor
      const edge = value => Math.max(viewportTop + margin, Math.min(viewportBottom - margin, value))
      const protectedRect = { top: edge(rawProtected.top), bottom: edge(rawProtected.bottom) }
      const above = Math.max(0, protectedRect.top - viewportTop - margin - gap)
      const below = Math.max(0, viewportTop + viewportHeight - protectedRect.bottom - margin - gap)
      const placeAbove = above > below
      const width = Math.max(1, Math.min(380, viewportWidth - margin * 2))
      const maxHeight = Math.max(0, placeAbove ? above : below)
      popover.style.width = `${width}px`
      popover.style.maxHeight = `${maxHeight}px`
      popover.style.minHeight = '0'
      popover.style.overflowY = maxHeight < 180 ? 'auto' : 'hidden'
      const left = Math.max(viewportLeft + margin, Math.min(viewportLeft + viewportWidth - width - margin, anchor.left + anchor.width / 2 - width / 2))
      // Anchor the near edge in CSS. A response can grow the card between
      // ResizeObserver and React's next paint; a measured top would leave one
      // frame at the old height's position before jumping back above the word.
      const next = { left: Math.round(left), width, maxHeight,
        top: placeAbove ? 'auto' : Math.round(protectedRect.bottom + gap),
        bottom: placeAbove ? Math.round(window.innerHeight - protectedRect.top + gap) : 'auto' }
      setPosition(previous => previous && Object.keys(next).every(key => previous[key] === next[key]) ? previous : next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(popover)
    if (selection.anchor?.isConnected) observer.observe(selection.anchor)
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.addEventListener('sc-study-viewport', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.removeEventListener('sc-study-viewport', update)
    }
  }, [selection, popoverRef])
  return position
}

function PracticeWordCard({ selection, onClose, onChanged, entries, onAlternative, onBack }) {
  useEffect(() => () => selection.clearRange?.(), [selection.clearRange])
  const isPhrase = selection?.kind === 'phrase' || String(selection?.word || '').trim().includes(' ')
  const [expressionType, setExpressionType] = useState(selection?.entry?.expressionType || '')
  const [entry, setEntry] = useState(selection?.entry || null)
  const [identity, setIdentity] = useState(null)
  const [primary, setPrimary] = useState(selection?.entry?.translation || '')
  const [quickSenses, setQuickSenses] = useState([])
  const [catalogue, setCatalogue] = useState(() => selection?.entry?.senseCatalog?.groups?.length ? selection.entry.senseCatalog : null)
  const [explanation, setExplanation] = useState('')
  const [composition, setComposition] = useState(null)
  const [meaningMode, setMeaningMode] = useState('')
  const [contextualMeaning, setContextualMeaning] = useState('')
  const [loading, setLoading] = useState(true)
  const [explanationLoading, setExplanationLoading] = useState(false)
  const [localBusy, setBusy] = useState(false)
  const saveOperation = useVocabularySaveState(selection?.word, identity?.lemma)
  const busy = localBusy || vocabularySaves.pending(saveOperation)
  const [error, setError] = useState('')
  const saveError = saveOperation?.phase === 'error' ? saveOperation.error || 'Не удалось сохранить слово' : ''
  const rawError = error || saveError
  const visibleError = /shortMeaning must be|group\.shortMeaning|Invalid catalogue group label/.test(rawError)
    ? 'Не удалось проверить перевод карточки. Повторите добавление.' : rawError
  useEffect(() => { if (rawError) notifyNativeStudyDebug(`word-card-error word=${selection?.word} error=${rawError}`) }, [rawError])
  const [examplesLoading, setExamplesLoading] = useState(false)
  const [lookupAttempt, setLookupAttempt] = useState(0)
  const [canRetryLookup, setCanRetryLookup] = useState(false)
  const [actionLabel, setActionLabel] = useState('')
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  const checkedRef = useRef(false)
  const popoverRef = useRef(null)
  const position = usePracticeWordPosition(selection, popoverRef)
  useEffect(() => () => { mountedRef.current = false }, [])
  const catalogueEntry = useMemo(() => StudyModel.catalogueDisplayEntry({
    ...(entry || {}), sourceText: entry?.sourceText || selection?.word || '', sourceLang: 'en', targetLang: 'ru',
  }, catalogue), [entry, catalogue, selection?.word])
  const catalogueOverview = useMemo(() => StudyModel.buildSenseOverview(catalogueEntry), [catalogueEntry])
  useEffect(() => {
    if (!['ready', 'reconciled'].includes(saveOperation?.phase) || !saveOperation.itemId) return
    let active = true
    ;(async () => {
      // Completion is a refresh signal, not a replacement record: a later
      // archive/unsave/edit may already have changed this same word.
      await store.sync({ fresh: true })
      const current = await store.getEntry({ remoteId: saveOperation.itemId })
      if (!active || !current) return
      checkedRef.current = true; setEntry(current); setPrimary(current.translation || '')
      if (current.senseCatalog?.groups?.length) setCatalogue(current.senseCatalog)
      setLoading(false); setExamplesLoading(false); setError('')
    })().catch(cause => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [saveOperation?.phase, saveOperation?.itemId, saveOperation?.updatedAt])

  useEffect(() => {
    if (!selection) return undefined
    let active = true
    const initialIdentity = Lexeme?.canonicalIdentity?.({
      kind: isPhrase ? 'phrase' : 'word', sourceLang: 'en', targetLang: 'ru', sourceText: selection.word, context: selection.context,
    }) || { lemma: store.normalizeTerm(selection.word), partOfSpeech: 'unknown', confidence: 'low' }
    setIdentity(initialIdentity)
    setExplanation('')
    setComposition(null)
    setMeaningMode('')
    setContextualMeaning('')
    setLoading(true)
    setError('')
    setCanRetryLookup(false)
    ;(async () => {
      try {
        const [savedEntry, preferences] = await Promise.all([
          store.getEntry({
            kind: isPhrase ? 'phrase' : 'word', sourceLang: 'en', targetLang: 'ru', sourceText: selection.word,
            lemma: initialIdentity.lemma, partOfSpeech: initialIdentity.partOfSpeech, analysisConfidence: initialIdentity.confidence,
          }).catch(() => null),
          readYoutubePreferences().catch(() => ({ learning_ai_explanation: true })),
        ])
        if (!active) return
        const resolvedEntry = savedEntry || selection.entry || null
        setEntry(resolvedEntry)
        const cachedCatalogue = resolvedEntry?.senseCatalog?.groups?.length ? resolvedEntry.senseCatalog
          : selection.entry?.senseCatalog?.groups?.length ? selection.entry.senseCatalog : null
        const saved = resolvedEntry && resolvedEntry.state !== 'none'
        let overview = StudyModel.buildSenseOverview(resolvedEntry)
        let resolvedPrimary = overview.translation || resolvedEntry?.translation || ''
        let classifiedPhrase = null
        const phrasePayload = { action: 'classify', selectedText: selection.word,
          context: selection.context || selection.word, contextTranslation: selection.contextTranslation || '',
          meaningModeVersion: 1, ...(preferences.learning_ai_explanation !== false ? { compositionVersion: 1 } : {}) }
        let phraseAnalysisPromise
        const classifyPhrase = () => phraseAnalysisPromise ||= (async () => {
          const key = `phrase-classify:${JSON.stringify(phrasePayload)}`
          const value = await practiceWordRequest(key, () => learningBridgeJson('/learning/catalogue', phrasePayload, 60_000))
          if (phrasePayload.compositionVersion && !PhraseComposition.normalize(value?.composition, selection.word, { requireMeaningMode: true })) practiceWordRequests.delete(key)
          if (!PhraseComposition.meaningLabel(value) && !PhraseComposition.meaningLabel(value?.composition)) practiceWordRequests.delete(key)
          if (active) setMeaningMode(value?.meaningMode || value?.composition?.meaningMode || '')
          return value
        })()
        if (isPhrase) void classifyPhrase().catch(() => {})
        if (saved && (cachedCatalogue || resolvedEntry.senseCatalog?.validatedAt || overview.senses.length)) {
          checkedRef.current = true
          setPrimary(resolvedPrimary)
          setLoading(false)
          if (cachedCatalogue) {
            setCatalogue(cachedCatalogue)
            overview = StudyModel.buildSenseOverview(StudyModel.catalogueDisplayEntry(resolvedEntry, cachedCatalogue))
          } else if (resolvedEntry.senseCatalog?.validatedAt && resolvedEntry.remoteId) {
            const result = await practiceWordRequest(`saved:${resolvedEntry.remoteId}:${resolvedEntry.updatedAt}`, () =>
              learningBridgeJson('/learning/catalogue', { action: 'read', entryId: resolvedEntry.remoteId }, 20_000))
            if (!active) return
            setCatalogue(result.catalogue)
            overview = StudyModel.buildSenseOverview(StudyModel.catalogueDisplayEntry(resolvedEntry, result.catalogue))
          }
          resolvedPrimary = overview.translation || resolvedPrimary
          setPrimary(resolvedPrimary)
        } else if (isPhrase) {
          const [translated, classified] = await Promise.allSettled([
            practiceWordRequest(`phrase-translation:${selection.word}`, () => learningBridgeJson('/translator/translate',
              { texts: [selection.word], from: 'en', to: 'ru' }, 20_000)),
            classifyPhrase(),
          ])
          if (!active) return
          if (classified.status === 'fulfilled') {
            const value = classified.value
            classifiedPhrase = value
            setExpressionType(resolvedEntry?.expressionType || value.expressionType || '')
            setIdentity({ lemma: value.canonicalText || selection.word, partOfSpeech: 'phrase', confidence: value.confidence || 'low' })
            resolvedPrimary = value.translation || ''
          }
          if (!resolvedPrimary && translated.status === 'fulfilled') resolvedPrimary = translated.value.translations?.[0]?.translated_text || ''
          if (!resolvedPrimary) throw new Error('Не удалось загрузить перевод фразы. Повторите попытку.')
          setPrimary(resolvedPrimary); setLoading(false)
          setQuickSenses([{ id: 'quick-phrase', meaning: resolvedPrimary, shortMeaning: resolvedPrimary, partOfSpeech: 'phrase', alternatives: [], englishAlternatives: [] }])
        } else {
          const word = initialIdentity.lemma || selection.word
          const payload = await practiceWordRequest(`dictionary:${word}`, () =>
            learningBridgeJson('/translator/dictionary', { text: word, from: 'en', to: 'ru' }, 15_000))
          if (!active || checkedRef.current) return
          const pairs = LearningUtils.mergeDictionaryMeaningPairs(payload.dictionary).slice(0, 5)
          resolvedPrimary = pairs.map(pair => pair.translation).join(' / ') || payload.fallback_translation || ''
          setPrimary(resolvedPrimary)
          setQuickSenses(pairs.length ? pairs.map((pair, index) => ({ id: `quick-${index}`, meaning: pair.translation,
            shortMeaning: pair.translation, partOfSpeech: pair.posTag || pair.partOfSpeech || pair.pos || '', alternatives: [], englishAlternatives: [] }))
            : resolvedPrimary ? [{ id: 'quick-word', meaning: resolvedPrimary, shortMeaning: resolvedPrimary, alternatives: [], englishAlternatives: [] }] : [])
          setLoading(false)
          if (pairs.length) {
            setExamplesLoading(true)
            // Examples arrive independently; quick translation and Save are already usable.
            practiceWordRequest(`examples:${word}`, () => learningBridgeJson('/translator/examples', { pairs, from: 'en', to: 'ru' }, 15_000))
              .then(examples => {
                if (!active || checkedRef.current) return
                const rows = LearningUtils.dictionaryExampleRows(examples, pairs, 'en', 'ru')
                setCatalogue({ groups: rows.map((row, index) => ({ id: `preview-${index}`,
                  shortMeaning: row.meaning, meaning: row.meaning, alternatives: [], partOfSpeech: row.partOfSpeech,
                  example: row.sourceText, exampleTranslation: row.targetText, focusEn: row.sourceTerm, focusRu: row.targetTerm,
                })) })
              }).catch(cause => { if (active && !checkedRef.current) { setError(`Примеры не загрузились. ${cause.message}`); setCanRetryLookup(true) } })
              .finally(() => { if (active && !checkedRef.current) setExamplesLoading(false) })
          }
        }
        if (preferences.learning_ai_explanation === false) return
        if (isPhrase) {
          setExplanationLoading(true)
          const value = classifiedPhrase || await classifyPhrase().catch(() => null)
          if (!active) return
          const details = PhraseComposition.normalize(value?.composition, selection.word)
          if (details) { setComposition(details); return }
        }
        if (!selection.context) return
        setExplanationLoading(true)
        const explainPayload = {
          contextOnly: true,
          word: selection.word,
          wordTranslation: resolvedPrimary,
          context: selection.context,
          contextTranslation: selection.contextTranslation || '',
          sourceLang: 'en',
          targetLang: 'ru',
          knownMeanings: overview.senses.map((sense) => sense.meaning),
          dictionaryTranslations: overview.senses.map((sense) => ({ value: sense.meaning, partOfSpeech: sense.partOfSpeech })),
        }
        const explained = await practiceWordRequest(`explain:${JSON.stringify(explainPayload)}`,
          () => learningBridgeJson('/learning/catalogue', { ...explainPayload, action: 'explain' }, 100_000)).catch(() => null)
        if (!active) return
        setExplanation(explained?.explanation || '')
        setContextualMeaning(String(explained?.matchedMeaning || '').trim())
        if (explained?.lemma && explained?.analysisConfidence === 'high') {
          setIdentity({
            lemma: explained.lemma,
            partOfSpeech: explained.partOfSpeech || initialIdentity.partOfSpeech || 'unknown',
            confidence: explained.analysisConfidence,
          })
        }
      } catch (loadError) {
        if (active) { setError(loadError?.message || String(loadError)); setCanRetryLookup(true) }
      } finally {
        if (active) { setLoading(false); setExplanationLoading(false) }
      }
    })()
    return () => { active = false }
  }, [selection, lookupAttempt])

  useEffect(() => {
    const close = (event) => {
      if (!event.target?.closest?.('.practice-word-card,.practice-word,.practice-synonyms')) onClose()
    }
    const keydown = event => { if (event.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', keydown) }
  }, [onClose])

  if (!selection) return null

  const contextsForSaving = () => {
    const contexts = [...(entry?.contexts || [])]
    if (catalogue?.groups?.length) contexts.push(...catalogueEntry.contexts)
    const meaning = StudyModel.displaySenseMeaning(contextualMeaning).toLocaleLowerCase('ru-RU')
    const matches = catalogueOverview.senses.filter((sense) => sense.meaning.toLocaleLowerCase('ru-RU') === meaning)
    // The joined header represents the whole word; it must not become a new
    // single sense attached to the dialogue. Only an explicitly matched meaning
    // can own that extra example; the catalogue already supplies all study examples.
    if (String(selection.context || '').trim()) {
      const matched = meaning && matches.length === 1 ? matches[0] : null
      contexts.push({
        ...(selection.observation || {}),
        sourceText: selection.context.trim(),
        translation: String(selection.contextTranslation || '').trim(),
        surfaceForm: store.normalizeTerm(selection.word),
        origin: selection.observation?.origin || 'manual',
        ...(matched ? { senseId: matched.id, meaning: matched.meaning, partOfSpeech: matched.partOfSpeech } : {}),
      })
    }
    return contexts
  }

  const checkedEntryForSaving = async () => {
    // Existing checked cards keep the durable local state/review path on iOS
    // and in the extension. Restoring one must not require fresh generation.
    if (entry?.senseCatalog?.validatedAt) return store.setState({ key: entry.key, remoteId: entry.remoteId, state: 'saved', toggle: false })
    setActionLabel('Проверяю…')
    const saved = await vocabularySaves.save({ word: identity?.lemma || selection.word,
      contexts: contextsForSaving(), observedForms: [selection.word] })
    await store.sync({ fresh: true })
    const canonical = await store.getEntry({ remoteId: saved.item.id })
    if (!canonical) throw new Error('Сохранённая карточка недоступна. Откройте её снова.')
    const fullCatalogue = canonical.senseCatalog?.groups?.length ? canonical.senseCatalog
      : (await learningBridgeJson('/learning/catalogue', { action: 'read', entryId: saved.item.id }, 20_000)).catalogue
    checkedRef.current = true
    if (mountedRef.current) {
      setEntry(canonical)
      if (fullCatalogue?.groups?.length) setCatalogue(fullCatalogue)
      setPrimary(StudyModel.buildSenseOverview(StudyModel.catalogueDisplayEntry(canonical, fullCatalogue)).translation || canonical.translation)
      setLoading(false)
      setExamplesLoading(false)
    }
    return canonical
  }

  const toggleState = async (state) => {
    if (busyRef.current || vocabularySaves.pending(saveOperation)) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setCanRetryLookup(false)
    try {
      const fallbackIdentity = Lexeme?.canonicalIdentity?.({
        kind: isPhrase ? 'phrase' : 'word', sourceLang: 'en', targetLang: 'ru', sourceText: selection.word, context: selection.context,
      }) || {}
      const resolvedIdentity = identity || fallbackIdentity
      const wasSaved = entry?.state === 'saved'
      const base = state === 'saved' && !wasSaved ? await checkedEntryForSaving() : entry
      if (state === 'saved' && !wasSaved) {
        if (mountedRef.current) setEntry(base)
        await onChanged?.({ sync: true })
        return
      }
      const next = await store.setState(base ? {
        key: base.key, remoteId: base.remoteId, state, toggle: state === 'saved' ? wasSaved : true,
        contextAdditions: contextsForSaving().filter(context => context.sourceText === selection.context),
        observedFormAdditions: [store.normalizeTerm(selection.word)],
      } : {
        kind: base?.kind || (isPhrase ? 'phrase' : 'word'), expressionType, state, toggle: state === 'saved' ? wasSaved : true, sourceLang: 'en', targetLang: 'ru',
        sourceText: base?.sourceText || selection.word, normalizedText: base?.normalizedText || resolvedIdentity.lemma || store.normalizeTerm(selection.word),
        lemma: base?.lemma || resolvedIdentity.lemma, partOfSpeech: base?.partOfSpeech || resolvedIdentity.partOfSpeech || 'unknown',
        analysisConfidence: base?.analysisConfidence || resolvedIdentity.confidence || 'low',
        observedForms: [...(base?.observedForms || []), store.normalizeTerm(selection.word)],
        translation: base?.translation || primary || '', translationSource: base?.translationSource || (primary ? 'machine' : ''),
        contexts: base?.senseCatalog?.validatedAt ? base.contexts : contextsForSaving(),
        senseCatalog: base?.senseCatalog?.validatedAt ? base.senseCatalog : null,
      })
      if (mountedRef.current) setEntry(next)
      await onChanged?.({ sync: true })
    } catch (cause) {
      if (mountedRef.current) setError(`Не удалось выполнить действие. ${cause.message}`)
    } finally {
      busyRef.current = false
      if (mountedRef.current) { setBusy(false); setActionLabel('') }
    }
  }

  const markKnown = async () => {
    if (busyRef.current || vocabularySaves.pending(saveOperation)) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setCanRetryLookup(false)
    try {
      const activeEntry = entry?.state === 'saved' ? entry : await checkedEntryForSaving()
      if (activeEntry?.state !== 'saved') throw new Error('Состояние слова изменилось в другом окне. Откройте карточку снова.')
      const next = await scheduleKnownEntry(activeEntry)
      if (next && mountedRef.current) setEntry(next)
      await onChanged?.({ sync: false })
    } catch (cause) {
      if (mountedRef.current) setError(`Не удалось отметить слово. ${cause.message}`)
    } finally {
      busyRef.current = false
      if (mountedRef.current) { setBusy(false); setActionLabel('') }
    }
  }

  const meaningSenses = entry?.senseCatalog?.validatedAt ? catalogueOverview.senses
    : quickSenses.length ? quickSenses : catalogueOverview.senses
  return createPortal(
    <aside ref={popoverRef} className="practice-word-card" style={{ ...position, visibility: position ? 'visible' : 'hidden' }} aria-label={`Перевод ${selection.word}`}>
      <header>
        <div><strong>{selection.word}</strong><div className="practice-word-primary">{!loading && meaningSenses.length > 0
          ? <StudyMeaningSummary senses={meaningSenses}
              support={catalogueOverview.support} catalogue={catalogue} revealed entries={entries} onAlternative={onAlternative} portal
              choiceContext={entry?.senseCatalog?.validatedAt ? null : { word: identity?.lemma || selection.word,
                context: selection.context || '', contextTranslation: selection.contextTranslation || '' }} />
          : <span>{loading ? 'Перевожу…' : primary || (visibleError ? 'Не удалось загрузить перевод' : 'Перевод не найден')}</span>}</div></div>
        <div className="practice-word-card-actions">
          {isPhrase && <button type="button" className="icon-button" onClick={() => copyPlainText(selection.word)} aria-label="Копировать фразу"><Copy size={17} /></button>}
          {onBack && <button type="button" className="icon-button" onClick={onBack} aria-label="К предыдущему слову"><ArrowLeft size={17} /></button>}
          <button type="button" className="icon-button" onClick={() => speakLearningText(selection.word)} aria-label="Произнести слово" title="Произнести слово"><Volume2 size={17} /></button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={17} /></button>
        </div>
      </header>
      <div className="practice-word-body">
        {isPhrase && !loading && <div className="practice-expression-type">{expressionType
          ? <ExpressionBadge entry={{ kind: 'phrase', expressionType }} /> : <small>Обычная фраза</small>}{PhraseComposition.meaningLabel({ meaningMode }) && <small> ({PhraseComposition.meaningLabel({ meaningMode })})</small>}</div>}
        {composition && <div className="practice-phrase-composition">
          <div>{composition.parts.map((part, index) => <span className="phrase-composition-part" key={index}>
            <strong>{part.en}</strong> — {part.ru}{index + 1 < composition.parts.length ? ' ·' : ''}
          </span>)}</div>
          <p>{composition.explanation}</p>
        </div>}
        {visibleError && <div className="practice-word-error" role="status">{visibleError}
          {!busy && canRetryLookup && <button type="button" className="secondary-button" onClick={() => setLookupAttempt(value => value + 1)}>Повторить загрузку</button>}
        </div>}
        {(loading || examplesLoading) && <div className="practice-word-skeleton" aria-label="Загружаю словарные примеры"><span /><span /><span /></div>}
        {(explanationLoading || explanation) && (
          <div className={`practice-word-explanation ${explanationLoading ? 'loading' : ''}`}>
            <Sparkles size={14} />
            <span>{explanationLoading ? 'Уточняю значение в этом диалоге…' : <>
              <strong className="practice-word-context-label">Контекст {selection.word}:</strong>{' '}{explanation}
            </>}</span>
          </div>
        )}
        {!loading && (catalogue?.groups?.length || entry) && (catalogueOverview.senses.length > 0 || catalogueOverview.support?.length > 0) && <div className="practice-word-overview">
          <StudyCatalogueExamples key={catalogue?.validatedAt || 'preview'} entry={catalogueEntry} overview={catalogueOverview} revealed examplesToggleable defaultTranslationsVisible={false} />
        </div>}
      </div>
      <footer>
        <StateButton active={false} tone="known" icon={CheckCircle2} onClick={markKnown} disabled={busy}>Знаю</StateButton>
        <button type="button" className={`state-button saved ${entry?.state === 'saved' ? 'active' : ''}`} onClick={() => toggleState('saved')} disabled={busy} aria-busy={busy}
          aria-label={!busy && entry?.state !== 'saved' && saveError ? 'Повторить добавление' : undefined}>
          {busy ? <RefreshCw size={16} className="spin" /> : <BookOpen size={16} />}{busy ? actionLabel || (saveOperation?.phase === 'saving' ? 'Сохраняю…' : 'Проверяю…') : entry?.state === 'saved' ? 'В словаре' : saveError ? 'Повторить' : 'В словарь'}
        </button>
        <StateButton active={entry?.state === 'known'} tone="known" icon={X} onClick={() => toggleState('known')} disabled={busy}>Не учить</StateButton>
      </footer>
    </aside>, document.body
  )
}

function WordCardProvider({ entries, refresh, route, children }) {
  const nativeDocumentRevision = useNativeDocumentRevision()
  const [selectedWord, setSelectedWord] = useState(null)
  const [wordHistory, setWordHistory] = useState([])
  const lookup = useMemo(() => vocabularyFormLookup(entries), [entries])
  const close = () => { setSelectedWord(null); setWordHistory([]) }
  const open = selection => {
    const anchorRect = selection.anchor?.isConnected ? selection.anchor.getBoundingClientRect?.() : null
    const rect = anchorRect?.width > 0 && anchorRect?.height > 0 ? { left: anchorRect.left, top: anchorRect.top, right: anchorRect.right,
      bottom: anchorRect.bottom, width: anchorRect.width, height: anchorRect.height } : selection.rect
    if (selectedWord) setWordHistory(history => [...history, selectedWord])
    setSelectedWord({ ...selection, rect })
  }
  useEffect(close, [route])
  useEffect(() => {
    if (!NATIVE_STUDY) return undefined
    postNativeStudyMessage('studyOverlay', { active: !!selectedWord })
    return () => postNativeStudyMessage('studyOverlay', { active: false })
  }, [!!selectedWord, nativeDocumentRevision])
  return <WordCardContext.Provider value={{ entries, lookup, refresh, open, selectedWord, setSelectedWord, wordHistory, setWordHistory }}>
    {children}
    {selectedWord && <PracticeWordCard key={`${selectedWord.word}:${selectedWord.context || ''}`} selection={selectedWord}
      entries={entries} onClose={close} onChanged={refresh}
      onBack={wordHistory.length ? () => { setSelectedWord(wordHistory.at(-1)); setWordHistory(history => history.slice(0, -1)) } : null}
      onAlternative={(word, entry) => open({ word, entry, kind: entry?.kind || (word.trim().includes(' ') ? 'phrase' : 'word'),
        rect: selectedWord.rect, context: '', contextTranslation: '' })} />}
  </WordCardContext.Provider>
}

const BASIC_MARKDOWN_INLINE = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*|\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))/g

function basicMarkdownInline(text, keyPrefix) {
  const source = String(text || '')
  const nodes = []
  let offset = 0
  let index = 0
  for (const match of source.matchAll(BASIC_MARKDOWN_INLINE)) {
    if (match.index > offset) nodes.push(source.slice(offset, match.index))
    const token = match[0]
    const key = `${keyPrefix}-inline-${index++}`
    if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{basicMarkdownInline(token.slice(2, -2), key)}</strong>)
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{basicMarkdownInline(token.slice(1, -1), key)}</em>)
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      nodes.push(link
        ? <a key={key} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>
        : token)
    }
    offset = match.index + token.length
  }
  if (offset < source.length) nodes.push(source.slice(offset))
  return nodes
}

function basicMarkdownLines(lines, keyPrefix) {
  return lines.flatMap((line, index) => [
    ...(index ? [<br key={`${keyPrefix}-break-${index}`} />] : []),
    ...basicMarkdownInline(line, `${keyPrefix}-${index}`),
  ])
}

function isBasicMarkdownBlockStart(line) {
  return /^\s*(?:```|#{1,4}\s+|[-+*•]\s+|\d+[.)]\s+|>\s?)/.test(line)
}

function BasicMarkdown({ text }) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let lineIndex = 0
  while (lineIndex < lines.length) {
    if (!lines[lineIndex].trim()) { lineIndex += 1; continue }
    const blockKey = `markdown-${lineIndex}`
    const fence = lines[lineIndex].match(/^\s*```([^\s`]*)\s*$/)
    if (fence) {
      const body = []
      lineIndex += 1
      while (lineIndex < lines.length && !/^\s*```\s*$/.test(lines[lineIndex])) body.push(lines[lineIndex++])
      if (lineIndex < lines.length) lineIndex += 1
      blocks.push(<pre key={blockKey}><code className={fence[1] ? `language-${fence[1]}` : undefined}>{body.join('\n')}</code></pre>)
      continue
    }
    const heading = lines[lineIndex].match(/^\s*(#{1,4})\s+(.+)$/)
    if (heading) {
      blocks.push(<h4 key={blockKey}>{basicMarkdownInline(heading[2], blockKey)}</h4>)
      lineIndex += 1
      continue
    }
    const list = lines[lineIndex].match(/^\s*([-+*•]|\d+[.)])\s+(.+)$/)
    if (list) {
      const ordered = /^\d/.test(list[1])
      const items = []
      while (lineIndex < lines.length) {
        const item = lines[lineIndex].match(/^\s*([-+*•]|\d+[.)])\s+(.+)$/)
        if (!item || /^\d/.test(item[1]) !== ordered) break
        items.push(item[2])
        lineIndex += 1
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(<List key={blockKey}>{items.map((item, index) => <li key={`${blockKey}-${index}`}>{basicMarkdownInline(item, `${blockKey}-${index}`)}</li>)}</List>)
      continue
    }
    if (/^\s*>/.test(lines[lineIndex])) {
      const quote = []
      while (lineIndex < lines.length && /^\s*>/.test(lines[lineIndex])) {
        quote.push(lines[lineIndex].replace(/^\s*>\s?/, ''))
        lineIndex += 1
      }
      blocks.push(<blockquote key={blockKey}>{basicMarkdownLines(quote, blockKey)}</blockquote>)
      continue
    }
    const paragraph = []
    while (lineIndex < lines.length && lines[lineIndex].trim() && !isBasicMarkdownBlockStart(lines[lineIndex])) {
      paragraph.push(lines[lineIndex])
      lineIndex += 1
    }
    // A malformed marker should remain visible rather than stalling the parser.
    if (!paragraph.length) paragraph.push(lines[lineIndex++])
    blocks.push(<p key={blockKey}>{basicMarkdownLines(paragraph, blockKey)}</p>)
  }
  return <div className="practice-feedback-markdown">{blocks}</div>
}

function practiceMessageCopyText(message, includeRole = false) {
  const role = message?.role === 'user' ? 'Пользователь' : 'Собеседник'
  const lines = includeRole ? [`${role}:`] : []
  if (message?.english) lines.push(String(message.english).trim())
  if (message?.role !== 'user' && message?.russian) lines.push('', `Перевод:\n${String(message.russian).trim()}`)
  if (message?.feedbackRussian) lines.push('', `Разбор:\n${String(message.feedbackRussian).trim()}`)
  if (message?.correctedEnglish) lines.push('', `Лучше сказать:\n${String(message.correctedEnglish).trim()}`)
  if (message?.role === 'user' && message?.status === 'failed' && message?.error) {
    lines.push('', `Статус: ${String(message.error).trim()}`)
  }
  return lines.join('\n').trim()
}

function practiceConversationCopyText(session) {
  if (!session) return ''
  const header = [
    `Разговорная практика · ${practiceThemeLabel(session.theme)}`,
    `Модель: ${practiceModelLabel(session.model)} · разбор HIGH`,
  ]
  const messages = (session.messages || []).map((message) => practiceMessageCopyText(message, true)).filter(Boolean)
  return [...header, ...messages].join('\n\n')
}

function resizePracticeComposer(element) {
  if (!element) return null
  element.style.height = '0px'
  const style = getComputedStyle(element)
  const minHeight = Number.parseFloat(style.minHeight) || 0
  const maxHeight = Number.parseFloat(style.maxHeight) || Number.POSITIVE_INFINITY
  const naturalHeight = element.scrollHeight
  const height = Math.ceil(Math.min(maxHeight, Math.max(minHeight, naturalHeight)))
  element.style.height = `${height}px`
  element.style.overflowY = naturalHeight > maxHeight + 1 ? 'auto' : 'hidden'
  return { height, minHeight, maxHeight, naturalHeight }
}

function practiceDictationText(final, partial) {
  const committed = String(final || '')
  const live = String(partial || '')
  return committed && live && !/\s$/.test(committed) && !/^[\s,.;:!?…]/.test(live)
    ? `${committed} ${live}` : committed + live
}

function practiceDictationWordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length
}

function PracticeMessage({
  message,
  entries,
  lookup,
  onWord,
  onWordHover,
  onWordLeave,
  hideTranslations,
  metaKeyDown,
  onRetry,
}) {
  const [hovered, setHovered] = useState(false)
  const [touchReveal, setTouchReveal] = useState(null)
  const [textExpanded, setTextExpanded] = useState(false)
  const [textOverflowing, setTextOverflowing] = useState(false)
  const [copyState, setCopyState] = useState('')
  const messageRef = useRef(null)
  const messageTextRef = useRef(null)
  const translationRef = useRef(null)
  const translationInputRef = useRef({ serial: 0, type: '', at: 0, pending: false, visible: false })
  const copyResetRef = useRef(null)

  useLayoutEffect(() => {
    const text = messageTextRef.current
    if (message.role !== 'user' || !text) return undefined
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight) || 25
      setTextOverflowing(text.getBoundingClientRect().height > lineHeight * 6 + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(text)
    return () => observer.disconnect()
  }, [message.english, message.role])

  const toggleLongText = () => {
    const bubble = messageRef.current
    const scroller = bubble?.closest('.practice-messages')
    const oldTop = bubble?.getBoundingClientRect().top
    flushSync(() => setTextExpanded(value => !value))
    if (scroller && oldTop !== undefined) {
      const viewport = scroller.getBoundingClientRect()
      const targetTop = Math.max(viewport.top + 13, Math.min(oldTop, viewport.bottom - bubble.getBoundingClientRect().height - 13))
      scroller.scrollTo({ top: scroller.scrollTop + bubble.getBoundingClientRect().top - targetTop, behavior: 'instant' })
    }
  }

  useEffect(() => {
    setTouchReveal(null)
  }, [hideTranslations, message.id])

  useEffect(() => {
    // An explicit hide wins over the current modifier reveal, but a new Cmd
    // gesture can reveal the message again. A tap-pinned visible translation
    // survives modifier changes until the user taps it to hide.
    setTouchReveal(value => value === false ? null : value)
  }, [metaKeyDown])

  useEffect(() => () => window.clearTimeout(copyResetRef.current), [])

  const copyMessage = async () => {
    const copied = await copyPlainText(practiceMessageCopyText(message))
    setCopyState(copied ? 'copied' : 'error')
    window.clearTimeout(copyResetRef.current)
    copyResetRef.current = window.setTimeout(() => setCopyState(''), 1600)
  }

  const translationVisible = !hideTranslations || (touchReveal ?? (hovered && metaKeyDown))

  useEffect(() => {
    if (!NATIVE_STUDY || message.role === 'user' || !message.russian) return
    try {
      window.webkit?.messageHandlers?.studyDebug?.postMessage({ message:
        `practice translation state id=${message.id} visible=${translationVisible} override=${touchReveal ?? 'auto'} hide=${hideTranslations} meta=${metaKeyDown} hovered=${hovered}` })
    } catch {}
  }, [message.id, message.role, message.russian, translationVisible, touchReveal, hideTranslations, metaKeyDown, hovered])

  useEffect(() => {
    if (!NATIVE_STUDY || !message.russian || message.role === 'user') return undefined
    const snapshot = phase => {
      const button = translationRef.current
      const text = button?.querySelector('.practice-message-russian-text')
      if (!button?.isConnected || !text) return
      const style = getComputedStyle(text)
      const rect = text.getBoundingClientRect()
      const instances = [...document.querySelectorAll('[data-practice-translation-id]')]
        .filter(node => node.dataset.practiceTranslationId === message.id).length
      try {
        window.webkit?.messageHandlers?.studyDebug?.postMessage({ message:
          `practice translation render id=${message.id} phase=${phase} expected=${translationVisible} expanded=${button.getAttribute('aria-expanded')} hidden=${text.getAttribute('aria-hidden')} visibility=${style.visibility} opacity=${style.opacity} display=${style.display} concealed=${button.classList.contains('concealed')} instances=${instances} size=${Math.round(rect.width)}x${Math.round(rect.height)} chars=${text.textContent.length}` })
      } catch {}
    }
    const frame = requestAnimationFrame(() => snapshot('frame'))
    const timer = window.setTimeout(() => snapshot('settled'), 200)
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer) }
  }, [message.id, message.role, message.russian, translationVisible])

  return (
    <div className={`practice-message-row ${message.role}`}>
      <article
        ref={messageRef}
        className={`practice-message ${message.role} ${textOverflowing ? 'has-edge-controls' : ''}`}
        data-role={message.role}
        data-expanded={textExpanded ? 'true' : 'false'}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
      {(message.feedbackRussian || message.correctedEnglish) && <div className="practice-feedback">{!NATIVE_STUDY && <Sparkles size={15} />}<div>
        {message.feedbackRussian && <BasicMarkdown text={message.feedbackRussian} />}
        {message.correctedEnglish && <p className="practice-correction"><InteractiveEnglishText text={message.correctedEnglish} lookup={lookup}
          onWord={selection => onWord({ ...selection, context: message.correctedEnglish, contextTranslation: '' })} /></p>}
      </div></div>}
      {textOverflowing && textExpanded && <button type="button" className="practice-message-edge top" onClick={toggleLongText} aria-expanded="true">Скрыть полностью</button>}
      <div className={`practice-message-text-clip ${message.role === 'user' && !textExpanded ? 'collapsed' : ''}`}
        onFocusCapture={event => {
          if (textOverflowing && !textExpanded && event.target.getBoundingClientRect().bottom > event.currentTarget.getBoundingClientRect().bottom) setTextExpanded(true)
        }}>
      <div className="practice-message-english" ref={messageTextRef}>
        <InteractiveEnglishText
          text={message.english}
          lookup={lookup}
          onWord={selection => onWord({
            ...selection,
            context: message.english,
            contextTranslation: message.russian || '',
          })}
          onWordHover={({ word, entry, anchor }) => onWordHover?.({ word, entry, anchor })}
          onWordLeave={onWordLeave}
        />
      </div>
      </div>
      {textOverflowing && <button type="button" className="practice-message-edge bottom" onClick={toggleLongText} aria-expanded={textExpanded}>
        {textExpanded ? 'Скрыть полностью' : 'Раскрыть полностью'}
      </button>}
      {message.role !== 'user' && message.russian && (
        <button
          type="button"
          ref={translationRef}
          data-practice-translation-id={message.id}
          className={`practice-message-russian ${translationVisible ? '' : 'concealed'}`}
          onPointerDown={event => {
            translationInputRef.current = { serial: translationInputRef.current.serial + 1,
              type: event.pointerType, at: performance.now(), pending: true, visible: translationVisible }
          }}
          onPointerCancel={() => { translationInputRef.current.pending = false }}
          onClick={event => {
            if (hideTranslations) {
              const input = translationInputRef.current
              try {
                window.webkit?.messageHandlers?.studyDebug?.postMessage({ message:
                  `practice translation tap id=${message.id} visible=${translationVisible} meta=${metaKeyDown} hovered=${hovered} input=${input.serial} type=${input.type || 'keyboard'} detail=${event.detail} ageMs=${Math.round(performance.now() - input.at)} trusted=${event.nativeEvent.isTrusted}` })
              } catch {}
              // Touch leave can remove Cmd-hover before the compatibility click.
              // Toggle what was visible when this press began, not the later hover.
              const visible = input.pending && event.detail > 0 ? input.visible : translationVisible
              input.pending = false
              setTouchReveal(!visible)
            }
          }}
          aria-expanded={translationVisible}
          aria-label={hideTranslations ? 'Перевод сообщения' : undefined}
        >
          <span className="practice-message-russian-text" aria-hidden={!translationVisible}><RussianVocabularyText text={message.russian} entries={entries} /></span>
        </button>
      )}
      {message.role === 'user' && message.status === 'failed' && <div className="practice-message-status" role="status">
        <span>{message.error || 'Ответ не получен'}</span><button type="button" onClick={() => onRetry?.(message)}>Повторить отправку</button>
      </div>}
      </article>
      <button type="button" className={`practice-message-copy ${copyState}`} onClick={copyMessage}
        aria-label={`Копировать сообщение ${message.role === 'user' ? 'пользователя' : 'собеседника'}`}
        title={copyState === 'copied' ? 'Скопировано' : copyState === 'error' ? 'Не удалось скопировать' : 'Копировать'}>
        {copyState === 'copied' ? <Check size={12} /> : copyState === 'error' ? <X size={12} /> : <Copy size={12} />}
      </button>
    </div>
  )
}

const PRACTICE_THEMES = Object.freeze([
  { id: 'general', label: 'Свободный разговор' },
  { id: 'technical_interview', label: 'Техническое интервью' },
])
const PRACTICE_MODEL_FALLBACK = 'gemini-3.8-flash'

function practiceThemeLabel(value) {
  return PRACTICE_THEMES.find((item) => item.id === value)?.label || PRACTICE_THEMES[0].label
}

function practiceModelLabel(value) {
  const model = String(value || PRACTICE_MODEL_FALLBACK).trim().replace(/^models\//, '')
  const match = model.match(/^gemini-([\d.]+)-(.+)$/i)
  if (!match) return model
  const family = match[2].split('-').map((part) => part === 'lite' ? 'Lite' : part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
  return `Gemini ${match[1]} ${family}`
}

function practiceSessionStats(session) {
  const replies = (session?.messages || []).filter((message) => message?.role === 'user')
  const words = replies.reduce((total, message) => {
    const text = String(message?.english || '')
    try {
      const segments = new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)
      return total + Array.from(segments).filter((part) => part.isWordLike).length
    } catch {
      return total + (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length
    }
  }, 0)
  return { replies: replies.length, words }
}

function PracticeView({ entries, refresh, onPracticeStats, active = true }) {
  const nativeDocumentRevision = useNativeDocumentRevision()
  const [session, setSession] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [nativeDraftCommitRevision, setNativeDraftCommitRevision] = useState(0)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { selectedWord, setSelectedWord, wordHistory, setWordHistory } = React.useContext(WordCardContext)
  const [theme, setTheme] = useState('general')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [autoplayCards, setAutoplayCards] = useState(false)
  const [hideTranslations, setHideTranslations] = useState(true)
  const [hoverWordTranslations, setHoverWordTranslations] = useState(false)
  const [metaKeyDown, setMetaKeyDown] = useState(false)
  const [quickWord, setQuickWord] = useState(null)
  const [quickRevision, setQuickRevision] = useState(0)
  const [preferenceBusy, setPreferenceBusy] = useState(false)
  const [chatCopyState, setChatCopyState] = useState('')
  const [dictationPhase, setDictationPhase] = useState('idle')
  const [dictationError, setDictationError] = useState('')
  const messagesEndRef = useRef(null)
  const messagesRef = useRef(null)
  const readingRef = useRef({ sessionId: 0, follow: true, top: 0 })
  const activeRef = useRef(active)
  activeRef.current = active
  const sessionRef = useRef(null)
  const draftRef = useRef('')
  const persistRef = useRef(Promise.resolve())
  const nativeInsertionQueueRef = useRef(Promise.resolve())
  const composerRef = useRef(null)
  const busyRef = useRef(false)
  const operationRef = useRef(0)
  const resumedPendingRef = useRef(new Set())
  const unloadingRef = useRef(false)
  const quickShowTimerRef = useRef(null)
  const quickHideTimerRef = useRef(null)
  const chatCopyResetRef = useRef(null)
  const dictationRef = useRef(null)
  const restoredDictationRef = useRef(null)
  const nativeInputSeqRef = useRef(0)
  const nativeDraftCoverageRef = useRef({ documentId: '', sessionId: 0, draftEpoch: 0, seq: 0 })
  const nativeSessionRef = useRef(0)
  const nativeSendRef = useRef(null)
  const entriesByKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries])
  const lookup = useMemo(() => vocabularyFormLookup(entries), [entries])
  const fallbackPack = useMemo(() => practiceVocabularyPack(entries), [entries])
  const vocabulary = useMemo(() => {
    const restored = (session?.vocabularyKeys || []).map((key) => entriesByKey.get(key)).filter((entry) => entry?.state === 'saved')
    return restored.length ? restored : fallbackPack
  }, [entriesByKey, fallbackPack, session?.vocabularyKeys])
  const sessionStats = useMemo(() => practiceSessionStats(session), [session])

  useEffect(() => {
    if (!active) { setSelectedWord(null); setWordHistory([]); setQuickWord(null); setSettingsOpen(false) }
  }, [active])

  useEffect(() => {
    const update = event => {
      const prefs = event.detail || {}
      setAutoplayCards(prefs.learning_card_autoplay === true)
      setHideTranslations(prefs.learning_practice_hide_translations !== false)
      setHoverWordTranslations(prefs.learning_hover_word_translation === true)
    }
    window.addEventListener('sc-study-preferences', update)
    return () => window.removeEventListener('sc-study-preferences', update)
  }, [])

  useEffect(() => {
    let active = true
    Promise.all([
      store.getPracticeSession(),
      readYoutubePreferences().catch(() => ({ learning_card_autoplay: false, learning_practice_hide_translations: true })),
    ]).then(([saved, preferences]) => {
      if (!active) return
      const restored = saved ? { ...saved, messages: saved.messages.map(message => message.status === 'pending' && !message.request
        ? { ...message, status: 'failed', error: 'Не удалось восстановить исходный запрос. Повторите отправку.' }
        : message.status === 'pending' ? { ...message, error: '' } : message) } : null
      const hasPendingRequest = restored?.messages?.some(message => message.role === 'user'
        && message.status === 'pending' && message.request)
      let restoredDraft = saved?.draft || ''
      if (NATIVE_STUDY && restored) {
        try {
          const cached = JSON.parse(localStorage.getItem(NATIVE_PRACTICE_DRAFT_KEY) || 'null')
          if (cached?.sessionCreatedAt === restored.createdAt) {
            restoredDictationRef.current = cached
            if (Number(cached.updatedAt) > Number(restored.updatedAt || 0)) restoredDraft = String(cached.draft || '')
          }
        } catch {}
      }
      sessionRef.current = restored
      if (NATIVE_STUDY) window.__scStudyPracticeSessionId = Number(restored?.createdAt || 0)
      if (NATIVE_STUDY) window.__scStudyPracticeDraftEpoch = Number(restored?.draftEpoch || 0)
      setSession(restored)
      setBusy(Boolean(hasPendingRequest))
      setDraft(restoredDraft)
      draftRef.current = restoredDraft
      setTheme(saved?.theme === 'technical_interview' ? 'technical_interview' : 'general')
      setAutoplayCards(preferences.learning_card_autoplay === true)
      setHideTranslations(preferences.learning_practice_hide_translations !== false)
      setHoverWordTranslations(preferences.learning_hover_word_translation === true)
    }).catch(cause => { if (active) setError(`Не удалось открыть диалог. ${cause.message}`) })
      .finally(() => { if (active) setLoaded(true) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    unloadingRef.current = false
    const markUnloading = () => { unloadingRef.current = true }
    window.addEventListener('beforeunload', markUnloading)
    window.addEventListener('pagehide', markUnloading)
    return () => {
      unloadingRef.current = true
      window.removeEventListener('beforeunload', markUnloading)
      window.removeEventListener('pagehide', markUnloading)
    }
  }, [])

  useEffect(() => {
    const keyDown = (event) => {
      if (event.key === 'Meta') setMetaKeyDown(true)
    }
    const keyUp = (event) => {
      if (event.key === 'Meta') setMetaKeyDown(false)
    }
    const blur = () => setMetaKeyDown(false)
    document.addEventListener('keydown', keyDown, true)
    document.addEventListener('keyup', keyUp, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('keydown', keyDown, true)
      document.removeEventListener('keyup', keyUp, true)
      window.removeEventListener('blur', blur)
    }
  }, [])

  useEffect(() => {
    if (!hoverWordTranslations || !session?.messages?.length) return undefined
    let active = true
    prefetchPracticeQuickTranslations(session.messages.map((message) => message.english))
      .finally(() => { if (active) setQuickRevision((value) => value + 1) })
    return () => { active = false }
  }, [hoverWordTranslations, session?.messages])

  useEffect(() => {
    if (hoverWordTranslations) return
    window.clearTimeout(quickShowTimerRef.current)
    window.clearTimeout(quickHideTimerRef.current)
    setQuickWord(null)
  }, [hoverWordTranslations])

  useEffect(() => () => {
    window.clearTimeout(quickShowTimerRef.current)
    window.clearTimeout(quickHideTimerRef.current)
    window.clearTimeout(chatCopyResetRef.current)
  }, [])

  useEffect(() => {
    if (!settingsOpen) return undefined
    const close = (event) => {
      if (!event.target?.closest?.('.practice-settings-shell, .practice-native-settings')) setSettingsOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [settingsOpen])

  useLayoutEffect(() => {
    const messages = messagesRef.current
    const sessionId = Number(session?.createdAt || 0)
    if (readingRef.current.sessionId !== sessionId) readingRef.current = { sessionId, follow: true, top: 0 }
    if (!active || !messages) return
    const reading = readingRef.current
    const top = reading.follow ? Math.max(0, messages.scrollHeight - messages.clientHeight) : reading.top
    if (Math.abs(messages.scrollTop - top) > 1) messages.scrollTo({ top, behavior: 'instant' })
    reading.top = messages.scrollTop
  }, [session?.createdAt, session?.messages?.length, busy, active])

  const trackReading = (event) => {
    const messages = event.currentTarget
    if (!activeRef.current || !messages.getClientRects().length) return
    readingRef.current.top = messages.scrollTop
    readingRef.current.follow = messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 48
  }

  useLayoutEffect(() => {
    resizePracticeComposer(composerRef.current)
  }, [draft, session?.createdAt])

  useEffect(() => {
    const resize = () => resizePracticeComposer(composerRef.current)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  const persist = async (next) => {
    sessionRef.current = next
    if (NATIVE_STUDY) window.__scStudyPracticeSessionId = Number(next?.createdAt || 0)
    if (NATIVE_STUDY) window.__scStudyPracticeDraftEpoch = Number(next?.draftEpoch || 0)
    setSession(next)
    const request = persistRef.current.catch(() => {}).then(() => store.savePracticeSession(next))
    persistRef.current = request
    const saved = await request
    if (sessionRef.current === next) { sessionRef.current = saved; setSession(saved) }
    return saved
  }

  const updateDraft = (value) => {
    draftRef.current = value
    setDraft(value)
    if (NATIVE_STUDY && sessionRef.current?.createdAt) {
      try {
        localStorage.setItem(NATIVE_PRACTICE_DRAFT_KEY, JSON.stringify({
          sessionCreatedAt: sessionRef.current.createdAt, draft: value, updatedAt: Date.now(),
          dictationId: dictationRef.current?.id || '', speech: dictationRef.current?.lastSpeech || '',
        }))
      } catch {}
    }
  }

  const markNativeDraftCommitted = (documentId, sessionId, draftEpoch, seq) => {
    if (!NATIVE_STUDY || documentId !== nativeStudyDocumentId() || sessionRef.current?.createdAt !== sessionId
      || Number(sessionRef.current?.draftEpoch || 0) !== draftEpoch || !Number.isSafeInteger(seq) || seq < 0) return
    const previous = nativeDraftCoverageRef.current
    const same = previous.documentId === documentId && previous.sessionId === sessionId && previous.draftEpoch === draftEpoch
    const covered = same ? Math.max(previous.seq, seq) : seq
    nativeDraftCoverageRef.current = { documentId, sessionId, draftEpoch, seq: covered }
    setNativeDraftCommitRevision(value => value + 1)
  }

  useEffect(() => {
    const next = Number(session?.createdAt || 0)
    nativeSessionRef.current = next
    if (NATIVE_STUDY) window.__scStudyPracticeSessionId = Number(sessionRef.current?.createdAt || 0)
    if (NATIVE_STUDY) window.__scStudyPracticeDraftEpoch = Number(sessionRef.current?.draftEpoch || 0)
  }, [session?.createdAt])

  useEffect(() => {
    if (!NATIVE_STUDY || !loaded) return
    const summary = session
      ? `${practiceThemeLabel(session.theme)} · ${practiceModelLabel(session.model)} · разбор HIGH\n${vocabulary.length} ${studyCountLabel(vocabulary.length, ['слово', 'слова', 'слов'])} в наборе · ${sessionStats.replies} ${studyCountLabel(sessionStats.replies, ['реплика', 'реплики', 'реплик'])} · ${sessionStats.words} ${studyCountLabel(sessionStats.words, ['слово', 'слова', 'слов'])} сказано\n${vocabulary.map((entry) => entry.sourceText).join(', ')}`
      : ''
    window.__scStudyPracticeSessionId = Number(sessionRef.current?.createdAt || 0)
    window.__scStudyPracticeDraftEpoch = Number(sessionRef.current?.draftEpoch || 0)
    const coverage = nativeDraftCoverageRef.current
    const covered = coverage.documentId === nativeStudyDocumentId() && coverage.sessionId === session?.createdAt
      && coverage.draftEpoch === Number(session?.draftEpoch || 0) ? coverage.seq : 0
    postNativeStudyMessage('studyPracticeState', {
      active: !!session, sessionId: Number(session?.createdAt || 0),
      draft, busy, dictationPhase, dictationError, summary, seq: nativeInputSeqRef.current,
      draftEpoch: Number(session?.draftEpoch || 0),
      draftSeq: Math.min(covered, nativeInputSeqRef.current),
      stateRevision: ++nativePracticeStateRevision,
    })
  }, [loaded, session?.createdAt, session?.draftEpoch, sessionStats.replies, sessionStats.words, vocabulary, draft, busy, dictationPhase, dictationError, nativeDocumentRevision, nativeDraftCommitRevision])

  useEffect(() => {
    if (!NATIVE_STUDY) return undefined
    const onNativeInput = (event) => {
      const detail = event.detail || {}
      if (!sessionRef.current || detail.version !== 2 || !nativeStudyDocumentId()
        || detail.documentId !== nativeStudyDocumentId() || detail.sessionId !== sessionRef.current.createdAt || !activeRef.current) return
      const seq = Number(detail.seq)
      if (!Number.isSafeInteger(seq) || seq < nativeInputSeqRef.current) return
      if (!['draft', 'send', 'insert'].includes(detail.action)) return
      nativeInputSeqRef.current = seq
      const documentId = detail.documentId, sessionId = detail.sessionId
      const ownsSession = () => nativeStudyDocumentId() === documentId
        && sessionRef.current?.createdAt === sessionId && !unloadingRef.current
      const ownsDelivery = () => ownsSession() && activeRef.current
      if (detail.action === 'insert') {
        const queued = nativeInsertionQueueRef.current.catch(() => {}).then(async () => {
          await persistRef.current.catch(() => {})
          if (!ownsDelivery()) return
          const request = store.applyPracticeInsertion(detail, { readDraft: () => ({
            active: ownsDelivery(), sessionId: Number(sessionRef.current?.createdAt || 0),
            targetKey: detail.targetKey, draft: draftRef.current,
          }) })
          persistRef.current = request
          const result = await request
          if (!ownsSession()) return
          if (!['applied', 'duplicate'].includes(result?.status)) {
            throw new Error(result?.reason === 'draft-too-long' ? 'Вставка не помещается в черновик. Исходный текст сохранён для повтора.'
              : 'Вставку диктовки не удалось подтвердить. Исходный текст сохранён для повтора.')
          }
          if (result.pastDraftEpoch) {
            // The insert belongs to a message already sent. Prove that old
            // operation without touching the current post-Send draft scope.
            if (ownsDelivery()) postNativeStudyMessage('studyPracticeInputAck', { ...detail,
              status: result.status, draftSeq: result.draftSeq,
              draftRevision: result.draftRevision, draftEpoch: result.draftEpoch })
            return
          }
          let next = result.session
          if (!result.pastDraftEpoch && draftRef.current !== result.baseDraft) {
            const draft = result.status === 'applied'
              ? draftRef.current ? `${draftRef.current}\n\n${detail.text}` : detail.text
              : draftRef.current
            if (draft.length > 24000) throw new Error('Не удалось сохранить весь черновик. Исходный текст сохранён для повтора.')
            updateDraft(draft)
            next = await persist({ ...next, draft })
          } else {
            sessionRef.current = next
            setSession(next)
            updateDraft(next.draft)
          }
          if (!ownsDelivery()) return
          // Coverage comes from the committed edit marker, never max observed
          // seq. Native retains the operation when newer optimistic typing exists.
          markNativeDraftCommitted(documentId, sessionId, result.draftEpoch, result.draftSeq)
          postNativeStudyMessage('studyPracticeInputAck', { ...detail,
            status: result.status, draft: next.draft, draftSeq: result.draftSeq,
            draftRevision: result.draftRevision, draftEpoch: result.draftEpoch })
        })
        nativeInsertionQueueRef.current = queued
        queued.catch(cause => { if (ownsSession()) setError(cause?.message || String(cause)) })
        return
      }
      if (detail.draftEpoch !== Number(sessionRef.current?.draftEpoch || 0)) return
      const text = String(detail.text || '')
      if (text !== draftRef.current) changeDraft(text)
      if (detail.action === 'send') nativeSendRef.current?.(null, { nativeIntent: { documentId, sessionId, seq, draftEpoch: detail.draftEpoch } })
      else {
        const request = persistRef.current.catch(() => {}).then(async () => {
          if (!ownsSession() || Number(sessionRef.current?.draftEpoch || 0) !== detail.draftEpoch) return
          const latest = await store.getPracticeSession()
          if (!ownsSession() || !latest || latest.createdAt !== sessionId || latest.draftEpoch !== detail.draftEpoch) return
          await store.savePracticeSession({ ...latest, draft: text })
          markNativeDraftCommitted(documentId, sessionId, detail.draftEpoch, seq)
        })
        persistRef.current = request
        request.catch(cause => { if (ownsSession()) setError(`Не удалось сохранить черновик. ${cause.message}`) })
      }
    }
    window.addEventListener('sc-study-practice-input', onNativeInput)
    return () => window.removeEventListener('sc-study-practice-input', onNativeInput)
  }, [])

  useEffect(() => {
    if (!NATIVE_STUDY) return undefined
    const applyDictation = (event) => {
      const detail = event.detail || {}
      if (detail.version !== 2 || !nativeStudyDocumentId() || detail.documentId !== nativeStudyDocumentId()
        || detail.sessionId !== sessionRef.current?.createdAt) return
      const id = String(detail.id || '')
      if (!id) return
      setDictationPhase(detail.phase || 'idle')
      setDictationError(String(detail.error || ''))
      if (!sessionRef.current) return
      const speech = practiceDictationText(detail.final, detail.partial)
      if (dictationRef.current?.id !== id) {
        const restored = restoredDictationRef.current
        const sameRecording = restored?.sessionCreatedAt === sessionRef.current.createdAt
          && restored?.dictationId === id && speech.startsWith(String(restored.speech || ''))
        if (detail.phase === 'idle' && !sameRecording) return
        const textarea = composerRef.current
        const at = document.activeElement === textarea ? textarea.selectionStart : draftRef.current.length
        const baseline = sameRecording ? String(restored.speech || '') : ''
        dictationRef.current = { id, start: at, rendered: '', baseline,
          baselineWordCount: practiceDictationWordCount(baseline), lastSpeech: baseline }
        restoredDictationRef.current = null
      }
      const voice = dictationRef.current
      if (speech === voice.lastSpeech) return
      const current = draftRef.current
      if (current.slice(voice.start, voice.start + voice.rendered.length) !== voice.rendered) {
        voice.start = composerRef.current?.selectionStart ?? current.length
        voice.rendered = ''
        voice.baseline = voice.lastSpeech
        voice.baselineWordCount = practiceDictationWordCount(voice.baseline)
      }
      const boundary = speech.slice(voice.baseline.length, voice.baseline.length + 1)
      const extendsBaseline = speech.startsWith(voice.baseline)
        && (!boundary || /[\s,.;:!?…]/.test(boundary) || /\s$/.test(voice.baseline))
      const spoken = extendsBaseline ? speech.slice(voice.baseline.length)
        : speech.trim().split(/\s+/).slice(voice.baselineWordCount).join(' ')
      const prefix = spoken && !/^\s/.test(spoken) && voice.start > 0 && !/\s$/.test(current.slice(0, voice.start)) ? ' ' : ''
      const replacement = prefix + spoken
      const next = current.slice(0, voice.start) + replacement + current.slice(voice.start + voice.rendered.length)
      voice.rendered = replacement
      voice.lastSpeech = speech
      if (next !== current) updateDraft(next)
    }
    const handler = (event) => applyDictation(event)
    window.addEventListener('sc-study-dictation', handler)
    postNativeStudyMessage('studyDictation', { action: 'state' })
    return () => window.removeEventListener('sc-study-dictation', handler)
  }, [nativeDocumentRevision])

  useEffect(() => {
    if (!loaded || !session) return undefined
    const timer = window.setTimeout(() => {
      persistRef.current = persistRef.current.catch(() => {}).then(async () => {
        const latest = await store.getPracticeSession()
        if (!latest || !sessionRef.current || latest.createdAt !== sessionRef.current.createdAt || latest.draft === draftRef.current) return
        await store.savePracticeSession({ ...latest, draft: draftRef.current })
      }).catch(() => {})
    }, 250)
    return () => window.clearTimeout(timer)
  }, [draft, loaded, session?.createdAt])

  const changeDraft = (value) => {
    const voice = dictationRef.current
    if (voice && voice.rendered && value !== draftRef.current) {
      const before = draftRef.current
      let prefix = 0
      while (prefix < before.length && prefix < value.length && before[prefix] === value[prefix]) prefix++
      let suffix = 0
      while (suffix < before.length - prefix && suffix < value.length - prefix
        && before[before.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++
      const removedEnd = before.length - suffix
      if (removedEnd <= voice.start) voice.start += value.length - before.length
      else if (prefix < voice.start + voice.rendered.length) {
        // The user corrected the live text itself. Preserve that edit and put
        // subsequent spoken words at the caret instead of overwriting it.
        voice.start = composerRef.current?.selectionStart ?? value.length
        voice.rendered = ''
        voice.baseline = voice.lastSpeech
        voice.baselineWordCount = practiceDictationWordCount(voice.baseline)
      }
    }
    updateDraft(value)
  }

  const copyConversation = async () => {
    const copied = await copyPlainText(practiceConversationCopyText(sessionRef.current))
    setChatCopyState(copied ? 'copied' : 'error')
    window.clearTimeout(chatCopyResetRef.current)
    chatCopyResetRef.current = window.setTimeout(() => setChatCopyState(''), 1600)
  }

  const payloadVocabulary = (items) => items.map((entry) => ({
    id: entry.key,
    term: entry.sourceText,
    translation: entry.translation || '',
    partOfSpeech: entry.partOfSpeech || 'unknown',
  }))

  const changePracticePreference = async (key, value) => {
    if (preferenceBusy) return
    setPreferenceBusy(true)
    try {
      const result = await patchYoutubePreferences({ [key]: value })
      const canonical = result?.settings?.[key]
      const resolved = typeof canonical === 'boolean' ? canonical : value
      if (key === 'learning_card_autoplay') setAutoplayCards(resolved)
      if (key === 'learning_practice_hide_translations') setHideTranslations(resolved)
      if (key === 'learning_hover_word_translation') setHoverWordTranslations(resolved)
    } catch (preferenceError) {
      setError(preferenceError?.message || String(preferenceError))
    } finally {
      setPreferenceBusy(false)
    }
  }

  const start = async () => {
    if (busyRef.current || !fallbackPack.length) return
    const operation = ++operationRef.current
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await learningBridgeJson('/learning/practice', {
        action: 'start', theme, vocabulary: payloadVocabulary(fallbackPack), history: [], answer: '',
      })
      if (operationRef.current !== operation || unloadingRef.current) return
      readingRef.current.follow = true
      await persist({
        theme,
        model: result.model || PRACTICE_MODEL_FALLBACK,
        vocabularyKeys: fallbackPack.map((entry) => entry.key),
        messages: [{
          id: practiceMessageId('assistant'), role: 'assistant', english: result.assistantEnglish,
          russian: result.assistantRussian, feedbackRussian: '', correctedEnglish: '',
          usedVocabularyIds: result.usedVocabularyIds || [], createdAt: Date.now(),
        }],
        createdAt: Date.now(),
      })
      if (!NATIVE_STUDY) requestAnimationFrame(() => {
        if (operationRef.current === operation && !unloadingRef.current && activeRef.current) composerRef.current?.focus()
      })
    } catch (startError) {
      if (operationRef.current === operation && !unloadingRef.current) setError(startError?.message || String(startError))
    } finally {
      if (operationRef.current === operation) { busyRef.current = false; setBusy(false) }
    }
  }

  const send = async (retryMessage = null, { follow = true, nativeIntent = null } = {}) => {
    const answer = retryMessage?.role === 'user' ? retryMessage.english : draftRef.current.trim()
    const current = sessionRef.current
    const retryVocabulary = retryMessage?.request?.vocabulary
    if (!answer || busyRef.current || !current
      || (retryMessage ? !Array.isArray(retryVocabulary) || !retryVocabulary.length : !vocabulary.length)) return
    if (answer.length > 24000) { setError('Ответ слишком длинный: максимум 24 000 символов. Разделите его на два сообщения.'); return }
    const operation = ++operationRef.current
    if (follow) readingRef.current.follow = true
    busyRef.current = true
    setBusy(true)
    if (!retryMessage) updateDraft('')
    setError('')
    const userMessage = { ...(retryMessage || {}), id: retryMessage?.id || practiceMessageId('user'), role: 'user',
      english: answer, russian: '', createdAt: retryMessage?.createdAt || Date.now(), status: 'pending', error: '' }
    const pending = { ...current, createdAt: current.createdAt || Date.now(), draft: draftRef.current,
      draftEpoch: retryMessage ? Number(current.draftEpoch || 0) : Number(current.draftEpoch || 0) + 1, messages: retryMessage
      ? current.messages.map(message => message.id === userMessage.id ? userMessage : message)
      : [...current.messages, userMessage] }
    const ownsOperation = () => operationRef.current === operation && !unloadingRef.current
      && sessionRef.current?.createdAt === pending.createdAt
    let persisted = false
    try {
      const history = []
      let historyChars = 0
      for (const message of current.messages.filter(message => message.id !== userMessage.id && !['pending', 'failed'].includes(message.status)).slice(-16).reverse()) {
        const value = { role: message.role, english: message.english, russian: message.role === 'user' ? '' : message.russian,
          feedbackRussian: message.feedbackRussian || '', correctedEnglish: message.correctedEnglish || '' }
        const size = Object.values(value).reduce((total, text) => total + String(text || '').length, 0)
        if (historyChars + size > 64000) break
        history.unshift(value)
        historyChars += size
      }
      userMessage.request = retryMessage?.request || {
        action: 'turn', requestId: userMessage.id, theme: current.theme || theme, answer, vocabulary: payloadVocabulary(vocabulary),
        history,
      }
      await persist(pending)
      persisted = true
      if (!ownsOperation()) return
      if (nativeIntent) markNativeDraftCommitted(nativeIntent.documentId, nativeIntent.sessionId, pending.draftEpoch, nativeIntent.seq)
      const result = await learningBridgeJson('/learning/practice', userMessage.request, 120_000)
      if (!ownsOperation()) return
      onPracticeStats?.(result.practice)
      const latest = await store.getPracticeSession()
      const replyId = `reply:${userMessage.id}`
      if (!ownsOperation() || !latest || latest.createdAt !== pending.createdAt || !latest.messages.some(message => message.id === userMessage.id)
        || latest.messages.some(message => message.id === replyId)) return
      const now = Date.now()
      await persist({
        ...latest, model: result.model || latest.model || PRACTICE_MODEL_FALLBACK, draft: draftRef.current,
        messages: [
          ...latest.messages.map(message => message.id === userMessage.id ? { ...message, status: 'sent', error: '', request: undefined } : message),
          {
            id: replyId, role: 'assistant', english: result.assistantEnglish,
            russian: result.assistantRussian, feedbackRussian: result.feedbackRussian || '',
            correctedEnglish: result.correctedEnglish || '', usedVocabularyIds: result.usedVocabularyIds || [], createdAt: now + 1,
          },
        ],
      })
      if (!NATIVE_STUDY) requestAnimationFrame(() => {
        if (ownsOperation() && activeRef.current) composerRef.current?.focus()
      })
    } catch (sendError) {
      const failure = sendError?.message || String(sendError)
      // Reload/navigation aborts the old document's fetch. Keep the durable
      // request pending so the next mount can join it by the same requestId.
      if (!ownsOperation()) return
      if (!persisted) {
        sessionRef.current = current
        if (NATIVE_STUDY) window.__scStudyPracticeSessionId = Number(current?.createdAt || 0)
        if (NATIVE_STUDY) window.__scStudyPracticeDraftEpoch = Number(current?.draftEpoch || 0)
        setSession(current)
        updateDraft(answer)
        setError(`Не удалось сохранить сообщение локально. ${failure}`)
        return
      }
      const latest = await store.getPracticeSession().catch(() => pending)
      if (!ownsOperation() || !latest || latest.createdAt !== pending.createdAt || !latest.messages.some(message => message.id === userMessage.id)
        || latest.messages.some(message => message.id === `reply:${userMessage.id}`)) return
      await persist({ ...latest, draft: draftRef.current,
        messages: latest.messages.map(message => message.id === userMessage.id ? { ...message, status: 'failed', error: failure } : message),
      }).catch(() => {
        if (ownsOperation()) { setError(`Не удалось сохранить сообщение локально. ${failure}`); updateDraft(answer) }
      })
    } finally {
      if (operationRef.current === operation) { busyRef.current = false; setBusy(false) }
    }
  }
  nativeSendRef.current = send

  useEffect(() => {
    if (!loaded || busyRef.current || !session) return
    const pendingMessage = session.messages?.find(message => message.role === 'user'
      && message.status === 'pending' && message.request)
    if (!pendingMessage || resumedPendingRef.current.has(pendingMessage.id)) return
    resumedPendingRef.current.add(pendingMessage.id)
    void send(pendingMessage, { follow: false })
  }, [loaded, session])

  const reset = async () => {
    operationRef.current += 1
    sessionRef.current = null
    if (NATIVE_STUDY) window.__scStudyPracticeSessionId = 0
    if (NATIVE_STUDY) window.__scStudyPracticeDraftEpoch = 0
    busyRef.current = false
    setBusy(false)
    await persistRef.current.catch(() => {})
    await store.clearPracticeSession()
    if (NATIVE_STUDY) try { localStorage.removeItem(NATIVE_PRACTICE_DRAFT_KEY) } catch {}
    dictationRef.current = null
    setSession(null)
    updateDraft('')
    setError('')
    setSelectedWord(null)
    setQuickWord(null)
  }

  useEffect(() => {
    if (!NATIVE_STUDY) return undefined
    const onNativeCommand = (event) => {
      const action = event.detail?.action
      if (event.detail?.version !== 2 || !nativeStudyDocumentId() || event.detail?.documentId !== nativeStudyDocumentId()
        || event.detail?.sessionId !== Number(sessionRef.current?.createdAt || 0) || !activeRef.current) return
      if (action === 'new' && sessionRef.current && dictationPhase === 'idle') void reset()
      if (action === 'copy' && sessionRef.current) void copyConversation()
      if (action === 'settings') setSettingsOpen(true)
    }
    window.addEventListener('sc-study-practice-command', onNativeCommand)
    return () => window.removeEventListener('sc-study-practice-command', onNativeCommand)
  }, [dictationPhase])

  const showQuickWord = ({ word, entry, anchor }) => {
    if (!hoverWordTranslations || !anchor) return
    window.clearTimeout(quickShowTimerRef.current)
    window.clearTimeout(quickHideTimerRef.current)
    quickHideTimerRef.current = null
    quickShowTimerRef.current = window.setTimeout(() => {
      quickShowTimerRef.current = null
      if (!anchor.isConnected || !anchor.matches(':hover')) return
      const rect = anchor.getBoundingClientRect()
      setQuickWord({
        word,
        entry,
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
      })
      prefetchPracticeQuickTranslations([word])
        .finally(() => setQuickRevision((value) => value + 1))
    }, 70)
  }

  const hideQuickWord = () => {
    window.clearTimeout(quickShowTimerRef.current)
    window.clearTimeout(quickHideTimerRef.current)
    quickShowTimerRef.current = null
    quickHideTimerRef.current = window.setTimeout(() => {
      quickHideTimerRef.current = null
      setQuickWord(null)
    }, 110)
  }

  const selectWord = ({ word, kind, entry, anchor, rect: suppliedRect, context, contextTranslation, clearRange }) => {
    window.clearTimeout(quickShowTimerRef.current)
    window.clearTimeout(quickHideTimerRef.current)
    setQuickWord(null)
    const rect = suppliedRect || anchor?.getBoundingClientRect?.()
    if (!rect) return
    setWordHistory([])
    setSelectedWord({
      word,
      kind,
      entry,
      context,
      contextTranslation: contextTranslation || '',
      clearRange,
      anchor,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
    })
  }

  if (!loaded) return <section className="workspace practice-workspace"><div className="page-loader"><RefreshCw className="spin" /></div></section>

  const practiceSettingsRows = <>
    <div className="practice-setting-row">
      <span><strong>Автоозвучка карточек</strong><small>Произносить следующую карточку автоматически</small></span>
      <button type="button" role="switch" aria-checked={autoplayCards} className={`settings-switch ${autoplayCards ? 'on' : ''}`} onClick={() => changePracticePreference('learning_card_autoplay', !autoplayCards)} disabled={preferenceBusy}><span /></button>
    </div>
    <div className="practice-setting-row">
      <span><strong>Показывать перевод</strong><small>{NATIVE_STUDY ? 'Если выключено, коснитесь перевода в сообщении' : 'Если выключено: Cmd + наведение; на сенсорном экране — касание'}</small></span>
      <button type="button" role="switch" aria-checked={!hideTranslations} className={`settings-switch ${!hideTranslations ? 'on' : ''}`} onClick={() => changePracticePreference('learning_practice_hide_translations', !hideTranslations)} disabled={preferenceBusy}><span /></button>
    </div>
    <div className="practice-setting-row">
      <span><strong>Перевод слова при наведении</strong><small>Клик по слову открывает полную карточку</small></span>
      <button type="button" role="switch" aria-checked={hoverWordTranslations} className={`settings-switch ${hoverWordTranslations ? 'on' : ''}`} onClick={() => changePracticePreference('learning_hover_word_translation', !hoverWordTranslations)} disabled={preferenceBusy}><span /></button>
    </div>
  </>

  return (
    <section className="workspace practice-workspace" aria-label="Практика английского">
      <div className="practice-chat">
        {!NATIVE_STUDY && <header className="practice-chat-head">
          <div className="practice-chat-identity"><MessageCircle size={20} /><div><strong>Разговорная практика</strong><span data-testid="practice-session-stats">{session
            ? `${practiceThemeLabel(session.theme)} · ${vocabulary.length} ${studyCountLabel(vocabulary.length, ['слово', 'слова', 'слов'])} в наборе · ${sessionStats.replies} ${studyCountLabel(sessionStats.replies, ['реплика', 'реплики', 'реплик'])} · ${sessionStats.words} ${studyCountLabel(sessionStats.words, ['слово', 'слова', 'слов'])} сказано`
            : 'Диалог на основе вашего словаря'}</span></div></div>
          <div className="practice-runtime-meta" aria-label="Параметры разговорной практики">
            <span title="Модель текущего диалога">{practiceModelLabel(session?.model)}</span>
            <span title="Стартовый вопрос использует LOW, подробный разбор ответа — HIGH">Разбор HIGH</span>
          </div>
          <div className="practice-chat-actions">
            {session && <button type="button" className={`icon-button practice-copy-chat ${chatCopyState}`} onClick={copyConversation}
              aria-label="Копировать чат"
              title={chatCopyState === 'copied' ? 'Чат скопирован' : chatCopyState === 'error' ? 'Не удалось скопировать чат' : 'Копировать чат'}>
              {chatCopyState === 'copied' ? <Check size={14} /> : chatCopyState === 'error' ? <X size={14} /> : <Copy size={14} />}
            </button>}
            {session && <button type="button" className="secondary-button" onClick={reset} disabled={dictationPhase !== 'idle'}>Новый диалог</button>}
            <div className="practice-settings-shell">
              <button type="button" className="icon-button" onClick={() => setSettingsOpen((value) => !value)} aria-label="Настройки практики" aria-expanded={settingsOpen}><Settings size={18} /></button>
              {settingsOpen && (
                <div className="practice-settings-popover">
                  {practiceSettingsRows}
                </div>
              )}
            </div>
          </div>
        </header>}
        {!session ? (
          <div className="practice-start">
            <div className="practice-start-icon"><MessageCircle size={34} /></div>
            <h2>Потренируем живой английский</h2>
            <p>AI начнёт короткий двуязычный диалог и будет естественно использовать слова из вашего словаря.</p>
            <label className="practice-theme-picker">
              <span>Тема</span>
              <select value={theme} onChange={(event) => setTheme(event.target.value)}>
                {PRACTICE_THEMES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <button data-testid="practice-start" type="button" className="primary-button" onClick={start} disabled={busy || !fallbackPack.length}>
              {busy ? <RefreshCw size={18} className="spin" /> : <Sparkles size={18} />}{fallbackPack.length ? 'Начать' : 'Сначала добавьте слова'}
            </button>
          </div>
        ) : (
          <>
            {!NATIVE_STUDY && <div className="practice-vocabulary-strip" aria-label="Слова сессии">{vocabulary.map((entry) => <span key={entry.key}>{entry.sourceText}</span>)}</div>}
            <div className="practice-messages" ref={messagesRef} onScroll={trackReading}>
              {(session.messages || []).map((message) => (
                <PracticeMessage
                  key={message.id}
                  message={message}
                  entries={entries}
                  lookup={lookup}
                  onWord={selectWord}
                  onWordHover={showQuickWord}
                  onWordLeave={hideQuickWord}
                  hideTranslations={hideTranslations}
                  metaKeyDown={metaKeyDown}
                  onRetry={send}
                />
              ))}
              {busy && <div className="practice-typing" role="status" aria-label="Готовлю ответ"><span /><span /><span /></div>}
              <div ref={messagesEndRef} />
            </div>
            {!NATIVE_STUDY && <div className="practice-composer">
              <textarea
                ref={composerRef}
                data-testid="practice-composer"
                rows={3}
                value={draft}
                onChange={(event) => changeDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (dictationPhase === 'idle') send() }
                }}
                placeholder="Отвечайте, размышляйте вслух или задавайте вопросы — можно на русском и английском"
              />
              <button data-testid="practice-send" type="button" className="practice-send" onClick={() => send()} disabled={!draft.trim() || busy || dictationPhase !== 'idle'} aria-label="Отправить"><Send size={19} /></button>
            </div>}
            {!NATIVE_STUDY && dictationError && <div className="practice-dictation-error" role="status">Диктовка: {dictationError}</div>}
          </>
        )}
        {error && <div className="practice-error">{error}</div>}
      </div>
      {NATIVE_STUDY && settingsOpen && <div className="practice-native-settings-backdrop" onClick={() => setSettingsOpen(false)}>
        <section className="practice-native-settings" role="dialog" aria-modal="true" aria-label="Настройки практики" onClick={(event) => event.stopPropagation()}>
          <header><strong>Настройки практики</strong><button type="button" className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Закрыть настройки"><X size={18} /></button></header>
          {practiceSettingsRows}
        </section>
      </div>}
      <PracticeQuickWordPopover selection={quickWord} revision={quickRevision} />
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

async function copyPlainText(value) {
  const text = String(value || '')
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {}
  const area = document.createElement('textarea')
  area.value = text
  area.style.cssText = 'position:fixed;left:-99999px;top:0'
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  } finally {
    area.remove()
  }
}

async function translateAllMediaCues(cues, sourceLanguage = 'en', onProgress) {
  const unique = []
  const seen = new Set()
  for (const cue of cues || []) {
    const text = String(cue?.text || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    unique.push({ text })
  }
  const batches = LearningUtils?.batchTexts?.(unique, 25, 5_000) || unique.map(item => [item])
  const normalizedSourceLanguage = /^[a-z]{2,3}$/i.test(String(sourceLanguage || ''))
    ? String(sourceLanguage).toLocaleLowerCase('en-US')
    : 'auto'
  if (normalizedSourceLanguage === 'ru') {
    onProgress?.({ done: unique.length, total: unique.length })
    return unique.map(item => ({ source_text: item.text, translated_text: item.text, alignment: '', cached: true }))
  }
  const translations = []
  let done = 0
  onProgress?.({ done, total: unique.length })
  for (const batch of batches) {
    const payload = await learningBridgeJson('/translator/translate', {
      texts: batch.map(item => item.text),
      from: normalizedSourceLanguage,
      to: 'ru',
    }, 30_000)
    translations.push(...(payload?.translations || []))
    done += batch.length
    onProgress?.({ done, total: unique.length })
  }
  return translations
}

function fallbackMediaGroups(items) {
  const map = new Map()
  for (const item of items || []) {
    const id = `${item.sourceId || 0}:${item.postExternalId || item.sourceUrl || `video:${item.id}`}`
    if (!map.has(id)) {
      map.set(id, {
        id,
        title: item.postTitle || item.title,
        author: item.author,
        sourceUrl: item.sourceUrl,
        description: '',
        descriptionPreview: '',
        outcome: { code: 'unknown', label: 'Итог не указан', evidence: '', explicit: false },
        publishedAt: Number(item.publishedAt || 0),
        videoIds: [],
      })
    }
    map.get(id).videoIds.push(item.id)
  }
  const byId = new Map((items || []).map(item => [Number(item.id), item]))
  return [...map.values()].map(group => {
    group.videoIds.sort((leftId, rightId) => (
      Number(byId.get(Number(leftId))?.position || 0) - Number(byId.get(Number(rightId))?.position || 0)
    ))
    const videos = group.videoIds.map(id => byId.get(Number(id))).filter(Boolean)
    return {
      ...group,
      videoCount: videos.length,
      downloadedCount: videos.filter(video => video.videoReady).length,
      subtitlesCount: videos.filter(video => video.subtitlesReady).length,
      durationSeconds: videos.reduce((sum, video) => sum + Number(video.durationSeconds || 0), 0),
      languageCodes: [...new Set(videos.map(video => video.languageCode).filter(Boolean))],
    }
  })
}

function VideoLanguageBadge({ code = 'unknown', label = '' }) {
  const short = code === 'en' ? 'EN' : code === 'ru' ? 'RU' : code === 'mixed' ? 'EN/RU' : '—'
  const resolvedLabel = label || (code === 'en' ? 'Английский' : code === 'ru' ? 'Русский' : code === 'mixed' ? 'Смешанный' : 'Язык не определён')
  return <span className={`video-language-badge ${code}`} title={resolvedLabel}>{short}</span>
}

function VideoOutcomeBadge({ outcome }) {
  const value = outcome || { code: 'unknown', label: 'Итог не указан' }
  if (!value.code || value.code === 'unknown') return null
  return <span className={`video-outcome-badge ${value.code || 'unknown'}`} title={value.evidence || value.label}>{value.label || 'Итог не указан'}</span>
}

function VideoRoleBadge({ role }) {
  if (!String(role || '').trim()) return null
  return <span className="video-role-badge" title={role}>{role}</span>
}

function VideoReadyBadge({ downloaded = 0, total = 1 }) {
  if (!downloaded) return null
  const label = total > 1 ? `Скачано ${downloaded}/${total}` : 'Скачано'
  return <span className="video-ready-badge"><Check size={10} />{label}</span>
}

function VideoStageBadge({ index, total }) {
  if (!Number.isInteger(index) || Number(total) <= 1) return null
  return <span className="video-stage-badge">Этап {index + 1}/{total}</span>
}

function VideoView() {
  const stageRef = useRef(null)
  const videoRef = useRef(null)
  const videoInputRef = useRef(null)
  const subtitlesInputRef = useRef(null)
  const localObjectUrlRef = useRef('')
  const initialMediaHandledRef = useRef(false)
  const subtitleCopyTimerRef = useRef(null)
  const [items, setItems] = useState([])
  const [groups, setGroups] = useState([])
  const [libraryStats, setLibraryStats] = useState(null)
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState(null)
  const [localVideo, setLocalVideo] = useState(null)
  const [localSubtitles, setLocalSubtitles] = useState(null)
  const [preparing, setPreparing] = useState(null)
  const [downloads, setDownloads] = useState({})
  const [subtitleCopyState, setSubtitleCopyState] = useState('')
  const [error, setError] = useState('')

  const requestedMediaId = Number(new URLSearchParams(window.location.search).get('media') || 0)
  const requestedStartSeconds = Number(new URLSearchParams(window.location.search).get('t') || 0)

  const loadLibrary = useCallback(async () => {
    setLoading(true)
    try {
      const payload = await learningBridgeGet('/learning/media/library')
      const next = Array.isArray(payload?.items) ? payload.items : []
      const nextGroups = Array.isArray(payload?.groups) && payload.groups.length
        ? payload.groups
        : fallbackMediaGroups(next)
      setItems(next)
      setGroups(nextGroups)
      setLibraryStats(payload?.stats || null)
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
      if (!cues.length) throw new Error('В исходной дорожке нет таймкодированных реплик')
      const languageCode = payload?.languageCode || item.languageCode || 'en'
      const languageLabel = item.languageLabel || (languageCode === 'ru' ? 'Русский' : languageCode === 'en' ? 'Английский' : 'Исходный язык')
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
        languageCode,
        languageLabel,
        cues,
      })
      const groupId = `${item.sourceId || 0}:${item.postExternalId || item.sourceUrl || `video:${item.id}`}`
      setExpandedGroups(current => new Set([...current, groupId]))
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
        const translations = await translateAllMediaCues(active.cues, active.languageCode || 'en', progress => {
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
          languageCode: active.languageCode || 'en',
          trackLabel: `${active.languageLabel || 'Исходный язык'} · SRT`,
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
    if (subtitleCopyTimerRef.current) window.clearTimeout(subtitleCopyTimerRef.current)
  }, [])

  async function copyActiveSubtitles() {
    const text = LearningUtils?.subtitleClipboardText?.(active?.cues || []) || ''
    if (!text) {
      setSubtitleCopyState('error')
      return
    }
    const copied = await copyPlainText(text)
    setSubtitleCopyState(copied ? 'copied' : 'error')
    if (subtitleCopyTimerRef.current) window.clearTimeout(subtitleCopyTimerRef.current)
    subtitleCopyTimerRef.current = window.setTimeout(() => {
      subtitleCopyTimerRef.current = null
      setSubtitleCopyState('')
    }, 1600)
  }

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

  const itemsById = useMemo(() => new Map(items.map(item => [Number(item.id), item])), [items])
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru-RU')
    return groups
      .filter(group => {
        if (!needle) return true
        const childText = (group.videoIds || []).map(id => itemsById.get(Number(id))?.title || '').join(' ')
        return `${group.title} ${group.author} ${group.description || ''} ${childText}`.toLocaleLowerCase('ru-RU').includes(needle)
      })
      .sort((left, right) => (
        Number((right.downloadedCount || 0) > 0) - Number((left.downloadedCount || 0) > 0)
        || Number(right.publishedAt || 0) - Number(left.publishedAt || 0)
      ))
  }, [groups, itemsById, query])

  const toggleGroup = (id) => {
    setExpandedGroups(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const renderMediaAction = (item) => {
    const download = downloads[item.id]
    return item.videoReady ? (
      <button type="button" className="primary-button" onClick={() => openLibraryItem(item)} disabled={!item.subtitlesReady}><Play size={15} />Открыть</button>
    ) : (
      <button type="button" className="secondary-button" onClick={() => downloadItem(item)} disabled={(!!download && download.status !== 'error') || !item.subtitlesReady}>
        {download && download.status !== 'error' ? <RefreshCw size={14} className="spin" /> : <Download size={14} />}
        {download && download.status !== 'error' ? `${Math.round(download.percent || 0)}%` : download?.status === 'error' ? 'Повторить' : 'Скачать видео'}
      </button>
    )
  }

  const renderMediaRow = (item, group, stageIndex = null) => (
    <div key={item.id} className={`video-library-row ${active?.mediaId === item.id ? 'active' : ''}`}>
      <div className="video-library-icon">{stageIndex == null ? <Clapperboard size={18} /> : <strong>{stageIndex + 1}</strong>}</div>
      <div className="video-library-copy">
        <div className="video-item-title-line">
          <strong>{item.title}</strong>
          <VideoStageBadge index={stageIndex} total={group?.videoCount} />
          <VideoLanguageBadge code={item.languageCode} label={item.languageLabel} />
          {group?.videoCount === 1 && <VideoOutcomeBadge outcome={group.outcome} />}
          {group?.videoCount === 1 && <VideoRoleBadge role={group?.details?.role} />}
        </div>
        <span>{item.author} · {mediaDuration(item.durationSeconds)}{item.videoBytes ? ` · ${mediaBytes(item.videoBytes)}` : ''}</span>
        <small>{item.subtitlesReady ? `${item.languageLabel || 'Исходный язык'} SRT готов` : 'Нет таймкодированных субтитров'}{!item.videoReady ? ` · ${item.audioReady ? 'есть аудио, видео можно докачать' : 'видео можно скачать'}` : ''}</small>
      </div>
      {renderMediaAction(item)}
    </div>
  )

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
          <div className="video-player-copy">
            <div className="video-player-identity"><strong>{active.title}</strong><span>{active.author}</span></div>
            <button type="button" className="secondary-button video-copy-subtitles" onClick={copyActiveSubtitles}>
              {subtitleCopyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
              {subtitleCopyState === 'copied' ? 'Скопировано' : subtitleCopyState === 'error' ? 'Не скопировано' : 'Копировать субтитры'}
            </button>
          </div>
          <div ref={stageRef} className="video-stage" data-testid="learning-video-stage">
            <video key={active.identity} ref={videoRef} src={active.videoUrl} controls playsInline preload="metadata" crossOrigin="anonymous" />
            {preparationLabel && <div className="video-preparing"><RefreshCw size={18} className="spin" />{preparationLabel}</div>}
          </div>
          <div className="video-player-hint">Space — пауза / воспроизведение · A / D или [ / ] — соседняя реплика · клик по слову — перевод и словарь</div>
        </div>
      )}

      {error && <div className="error-banner">{error}<button type="button" onClick={() => setError('')}><X size={16} /></button></div>}

      <div className="video-library-head">
        <div><strong>Медиатека</strong><span>{libraryStats?.posts ?? groups.length} постов · {libraryStats?.videos ?? items.length} видео · {libraryStats?.downloaded ?? items.filter(item => item.videoReady).length} скачано · {libraryStats?.subtitles ?? items.filter(item => item.subtitlesReady).length} с SRT</span></div>
        <label className="search-box"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти интервью" /></label>
      </div>
      <div className="video-library" data-testid="learning-video-library">
        {loading && !items.length && <div className="page-loader"><RefreshCw className="spin" /><span>Читаю медиатеку…</span></div>}
        {!loading && !visibleGroups.length && <div className="video-library-empty">Видео не найдены.</div>}
        {visibleGroups.map(group => {
          const videos = (group.videoIds || []).map(id => itemsById.get(Number(id))).filter(Boolean)
          if (videos.length === 1) return <div key={group.id} className="video-library-group single">{renderMediaRow(videos[0], group)}</div>
          const expanded = !!query.trim() || expandedGroups.has(group.id)
          const activeGroup = videos.some(item => Number(item.id) === Number(active?.mediaId))
          return (
            <div key={group.id} className={`video-library-group ${expanded ? 'expanded' : ''} ${activeGroup ? 'active' : ''}`}>
              <button type="button" className="video-group-summary" onClick={() => toggleGroup(group.id)} aria-expanded={expanded}>
                <span className="video-group-icon"><Clapperboard size={18} /></span>
                <span className="video-group-copy">
                  <span className="video-group-title-line">
                    <strong>{group.title}</strong>
                    {(group.languageCodes || []).map(code => <VideoLanguageBadge key={code} code={code} />)}
                    <VideoOutcomeBadge outcome={group.outcome} />
                    <VideoRoleBadge role={group?.details?.role} />
                    <VideoReadyBadge downloaded={group.downloadedCount} total={group.videoCount} />
                  </span>
                  <small>{group.videoCount} этапа · {mediaDuration(group.durationSeconds)}</small>
                </span>
                <ChevronDown size={18} className="video-group-chevron" />
              </button>
              {expanded && group?.details?.notes && <p className="video-group-notes">{group.details.notes}</p>}
              {expanded && <div className="video-group-children">{videos.map((item, index) => renderMediaRow(item, group, index))}</div>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function GeminiUsageSettings() {
  const [period, setPeriod] = useState('today')
  const [revision, setRevision] = useState(0)
  const [usage, setUsage] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    learningBridgeGet(`/learning/usage?period=${period}&timeZone=${encodeURIComponent(timeZone)}`)
      .then(value => {
        if (!value?.totals) throw new Error('Сервер не вернул статистику токенов')
        if (active) setUsage(value)
      })
      .catch(cause => { if (active) setError(cause.message || String(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [period, revision])
  const current = usage?.period === period ? usage : null
  const number = value => Number(value || 0).toLocaleString('ru-RU')
  const cost = value => value == null ? 'Цена неполная' : new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4,
  }).format(value)
  return <section className="settings-card usage-settings" aria-label="Потребление токенов Gemini">
    <div className="usage-settings-head">
      <strong>Потребление токенов · Gemini</strong>
      <div className="usage-settings-actions">
        <select aria-label="Период статистики токенов" value={period} onChange={event => setPeriod(event.target.value)}>
          <option value="today">Сегодня</option><option value="all">Всё время</option>
        </select>
        <button type="button" className="icon-button" aria-label="Обновить статистику токенов" onClick={() => setRevision(value => value + 1)} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </button>
      </div>
    </div>
    <p className="usage-settings-note">Запросы Gemini в Voice Record, включая словарь и разговорную практику.</p>
    {error && <p role="status" className="usage-settings-error">{error}</p>}
    {!current && loading && <p className="usage-settings-note">Загружаю статистику…</p>}
    {current && <>
      <div className="usage-settings-tokens">
        <div><span>Вход</span><strong>{number(current.totals.inputTokens)}</strong></div>
        <div><span>Из него кэш</span><strong>{number(current.totals.cachedInputTokens)}</strong></div>
        <div><span>Ответ</span><strong>{number(current.totals.visibleOutputTokens)}</strong></div>
        <div><span>Размышления</span><strong>{number(current.totals.thinkingTokens)}</strong></div>
      </div>
      <div className="usage-settings-total"><span>{number(current.totals.calls)} запросов · примерная цена</span><strong>{cost(current.totals.estimatedUsd)}</strong></div>
      {current.totals.unpricedCalls > 0 && <p className="usage-settings-note">Известная часть: {cost(current.totals.knownEstimatedUsd)}. Для {number(current.totals.unpricedCalls)} запросов нет полной оценки.</p>}
      {(current.byModel || []).map(model => <div key={model.modelId} className="usage-settings-model"><div><strong>{model.modelId}</strong>
        <span>Вход {number(model.inputTokens)} · ответ {number(model.visibleOutputTokens)} · размышления {number(model.thinkingTokens)}</span></div><span>{cost(model.estimatedUsd)}</span></div>)}
      <p className="usage-settings-note">Кэш входит во входные токены. Размышления оплачиваются как выход и уже включены в цену один раз. Это оценка по сохранённым тарифам; поиск Google и хранение кэша сюда не входят.</p>
      {current.totals.cachedPricingUnadjustedCalls > 0 && <p className="usage-settings-note">В старых записях скидка на кэш могла не учитываться.</p>}
    </>}
  </section>
}

function SettingsView() {
  const studyPreferences = React.useContext(StudyPreferencesContext)
  const [enabled, setEnabled] = useState(true)
  const [autoplay, setAutoplay] = useState(false)
  const [hidePracticeTranslations, setHidePracticeTranslations] = useState(true)
  const [hoverWordTranslation, setHoverWordTranslation] = useState(false)
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
        setHidePracticeTranslations(preferences.learning_practice_hide_translations !== false)
        setHoverWordTranslation(preferences.learning_hover_word_translation === true)
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

  const togglePracticeTranslations = async () => {
    if (saving || loading) return
    const next = !hidePracticeTranslations
    setHidePracticeTranslations(next)
    setSaving(true)
    setMessage('')
    try {
      const result = await patchYoutubePreferences({ learning_practice_hide_translations: next })
      const canonical = result?.settings?.learning_practice_hide_translations
      if (typeof canonical === 'boolean') setHidePracticeTranslations(canonical)
      setMessage(preferenceSavedMessage(result))
    } catch (error) {
      setHidePracticeTranslations(!next)
      setMessage(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  const toggleHoverWordTranslation = async () => {
    if (saving || loading) return
    const next = !hoverWordTranslation
    setHoverWordTranslation(next)
    setSaving(true)
    setMessage('')
    try {
      const result = await patchYoutubePreferences({ learning_hover_word_translation: next })
      const canonical = result?.settings?.learning_hover_word_translation
      if (typeof canonical === 'boolean') setHoverWordTranslation(canonical)
      setMessage(preferenceSavedMessage(result))
    } catch (error) {
      setHoverWordTranslation(!next)
      setMessage(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="workspace settings-workspace" aria-label="Настройки словаря">
      <div className="settings-card">
        <div className="settings-copy"><div className="settings-title"><Eye size={19} /><strong>Скрывать изучаемое слово в переводе примера</strong></div>
          <p>До нажатия на глаз русский ответ внутри примера закрыт. Остальной перевод остаётся виден.</p></div>
        <button type="button" role="switch" aria-label="Скрывать изучаемое слово в переводе примера"
          aria-checked={studyPreferences.maskExampleAnswer} disabled={studyPreferences.saving}
          className={`settings-switch ${studyPreferences.maskExampleAnswer ? 'on' : ''}`} onClick={studyPreferences.toggleMask}><span /></button>
      </div>
      {!HOSTED_STUDY && <div className="settings-card">
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
      {!HOSTED_STUDY && <div className="settings-card">
        <div className="settings-copy">
          <div className="settings-title"><Languages size={19} /><strong>Перевод слова при наведении</strong></div>
          <p>Показывать один мгновенный перевод; дополнительные значения открываются кликом по слову.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={hoverWordTranslation}
          className={`settings-switch ${hoverWordTranslation ? 'on' : ''}`}
          onClick={toggleHoverWordTranslation}
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
      <div className="settings-card">
        <div className="settings-copy">
          <div className="settings-title"><Eye size={19} /><strong>Показывать перевод в диалоге</strong></div>
          <p>В скрытом режиме место второй строки сохраняется; Cmd + наведение временно показывает перевод.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={!hidePracticeTranslations}
          className={`settings-switch ${!hidePracticeTranslations ? 'on' : ''}`}
          onClick={togglePracticeTranslations}
          disabled={loading || saving}
        ><span /></button>
      </div>
      <div className="settings-card compact">
        <div className="settings-copy">
          <strong>Модель практики</strong>
          <p>Gemini 3.8 Flash · подробный разбор с размышлением. Один запрос на ответ; инструменты агента не запускаются. Контекстные подсказки и подготовка карточек учитываются отдельно в статистике.</p>
        </div>
      </div>
      {!HOSTED_STUDY && <GeminiUsageSettings />}
      {message && <div className="settings-message">{message}</div>}
    </section>
  )
}

function App() {
  const nativeDocumentRevision = useNativeDocumentRevision()
  const routeFromLocation = () => {
    if (!HOSTED_STUDY && (window.location.hash === '#video' || new URLSearchParams(window.location.search).has('media'))) return 'video'
    if (window.location.hash === '#session') return 'session'
    if (window.location.hash === '#archive') return 'archive'
    if (window.location.hash === '#cards') return 'cards'
    if (window.location.hash === '#dictionary') return 'dictionary'
    if ((!HOSTED_STUDY || NATIVE_STUDY) && window.location.hash === '#practice') return 'practice'
    if (window.location.hash === '#settings') return 'settings'
    try {
      const saved = localStorage.getItem('sc-study-last-route-v1')
      if (['dictionary', 'cards', 'session', 'settings', 'archive'].includes(saved) || saved === 'practice' && (!HOSTED_STUDY || NATIVE_STUDY) || saved === 'video' && !HOSTED_STUDY) return saved
    } catch {}
    return 'cards'
  }
  const [tab, setTab] = useState(() => {
    return routeFromLocation()
  })
  const cardsRouteRef = useRef((() => {
    if (['cards', 'session'].includes(tab)) return tab
    try { return localStorage.getItem('sc-study-cards-route-v1') === 'session' ? 'session' : 'cards' }
    catch { return 'cards' }
  })())
  const rememberCardsRoute = next => {
    if (!['cards', 'session'].includes(next)) return
    cardsRouteRef.current = next
    try { localStorage.setItem('sc-study-cards-route-v1', next) } catch {}
  }
  const [nativePracticeVisited, setNativePracticeVisited] = useState(() => NATIVE_STUDY && routeFromLocation() === 'practice')
  const [entries, setEntries] = useState([])
  const [stats, setStats] = useState(null)
  const [practiceReplies, setPracticeReplies] = useState(() => {
    try { const value = Number(localStorage.getItem('sc-practice-replies-v1')); return localStorage.getItem('sc-practice-replies-v1') !== null && Number.isSafeInteger(value) && value >= 0 ? value : null }
    catch { return null }
  })
  const applyPracticeStats = useCallback(value => {
    const total = value?.totalReplies
    if (!Number.isSafeInteger(total) || total < 0) return
    setPracticeReplies(previous => {
      const next = Math.max(previous ?? 0, total)
      try { localStorage.setItem('sc-practice-replies-v1', String(next)) } catch {}
      return next
    })
  }, [])
  useEffect(() => {
    let active = true
    const load = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const query = `?timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}`
        const result = REMOTE_STUDY ? await remoteApi(`/api/vocabulary/statistics${query}`) : await learningBridgeGet(`/learning/statistics${query}`)
        if (active) applyPracticeStats(result?.practice)
      } catch {}
    }
    const fromOtherTab = event => { if (event.key === 'sc-practice-replies-v1' && event.newValue !== null) applyPracticeStats({ totalReplies: Number(event.newValue) }) }
    load()
    window.addEventListener('focus', load)
    window.addEventListener('storage', fromOtherTab)
    return () => { active = false; window.removeEventListener('focus', load); window.removeEventListener('storage', fromOtherTab) }
  }, [applyPracticeStats])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const learnedPercent = stats?.total ? Math.round((Number(stats.known || 0) / stats.total) * 100) : 0
  const [addRequest, setAddRequest] = useState(null)
  const [suspendedSession, setSuspendedSession] = useState(false)
  const chooseTab = (nextTab) => {
    rememberCardsRoute(nextTab)
    if (!['cards', 'session'].includes(nextTab)) setSuspendedSession(false)
    if (NATIVE_STUDY && nextTab === 'practice') setNativePracticeVisited(true)
    setTab(nextTab)
    window.history.replaceState(null, '', `#${nextTab}`)
  }
  const followTabLink = (event, nextTab) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    // Clicking the active Cards section is its desktop route back to statistics.
    chooseTab(nextTab === 'cards' ? tab === 'session' ? 'cards' : cardsRouteRef.current : nextTab)
  }
  const addAlternative = (term) => {
    // Commit the form inside the original tap so WebKit can open its keyboard.
    flushSync(() => {
      setAddRequest({ term, id: Date.now() })
      setSuspendedSession(true)
      chooseTab('cards')
    })
    const input = document.querySelector('.manual-entry-form input')
    input?.focus({ preventScroll: true })
    input?.scrollIntoView({ block: 'nearest' })
  }

  useEffect(() => {
    const applyHash = () => {
      const next = routeFromLocation()
      rememberCardsRoute(next)
      if (NATIVE_STUDY && next === 'practice') setNativePracticeVisited(true)
      setTab(next)
    }
    window.addEventListener('hashchange', applyHash)
    return () => window.removeEventListener('hashchange', applyHash)
  }, [])

  useEffect(() => {
    const sessionActive = EMBEDDED_STUDY && tab === 'session'
    const nativePracticeActive = NATIVE_STUDY && EMBEDDED_STUDY && tab === 'practice'
    document.documentElement.classList.toggle('study-session-active', sessionActive)
    document.body.classList.toggle('study-session-active', sessionActive)
    document.documentElement.classList.toggle('study-practice-active', nativePracticeActive)
    document.body.classList.toggle('study-practice-active', nativePracticeActive)
    try { localStorage.setItem('sc-study-last-route-v1', tab) } catch {}
    rememberCardsRoute(tab)
    notifyNativeStudyRoute(tab)
    return () => {
      document.documentElement.classList.remove('study-session-active')
      document.body.classList.remove('study-session-active')
      document.documentElement.classList.remove('study-practice-active')
      document.body.classList.remove('study-practice-active')
    }
  }, [tab, nativeDocumentRevision])

  const [studyState, setStudyState] = useState(() => StudyState.normalize(null))
  const [preferenceSaving, setPreferenceSaving] = useState(false)
  const togglePreference = async (field) => {
    if (preferenceSaving) return
    setPreferenceSaving(true)
    try {
      const value = await store.studyAction({ kind: 'preference', field, [field]: !studyState.preferences[field],
        client: NATIVE_STUDY ? 'ios' : REMOTE_STUDY ? 'web' : 'extension' })
      setStudyState(value.state)
      void store.sync({}).then(() => readLocal()).catch(error => setError(`Настройка сохранена на устройстве; синхронизация: ${error.message}`))
    } catch (error) { setError(`Не удалось сохранить настройку: ${error.message}`) }
    finally { setPreferenceSaving(false) }
  }
  const readLocal = useCallback(async () => {
    const [nextEntries, nextStats, nextStudyState] = await Promise.all([
      store.listEntries({}),
      store.stats({}),
      store.getStudyState({}).catch(() => null),
    ])
    if (nextStudyState) setStudyState(nextStudyState)
    setEntries(nextEntries)
    setStats(nextStats)
    setLoading(false)
  }, [])

  useEffect(() => {
    const reload = () => { void readLocal().catch(() => {}) }
    window.addEventListener('sc-study-state-changed', reload)
    return () => window.removeEventListener('sc-study-state-changed', reload)
  }, [readLocal])

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
    if (!NATIVE_STUDY) return undefined
    let running = false
    const syncWhenAvailable = () => {
      if (running || document.visibilityState === 'hidden') return
      running = true
      refresh({ sync: true }).catch(() => {}).finally(() => { running = false })
    }
    window.addEventListener('online', syncWhenAvailable)
    window.addEventListener('focus', syncWhenAvailable)
    document.addEventListener('visibilitychange', syncWhenAvailable)
    return () => {
      window.removeEventListener('online', syncWhenAvailable)
      window.removeEventListener('focus', syncWhenAvailable)
      document.removeEventListener('visibilitychange', syncWhenAvailable)
    }
  }, [refresh])

  useEffect(() => {
    let active = true
    const unsubscribe = store.subscribe(() => {
      if (active) readLocal().catch(() => {})
    })
    ;(async () => {
      try {
        await store.migrateLegacy({})
        if (NATIVE_STUDY) await store.restoreNativeCache({}).catch(error => notifyNativeStudyDebug(`cache restore failed: ${error.message}`))
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
    <StudyPreferencesContext.Provider value={{ ...studyState.preferences, saving: preferenceSaving, toggleSupport: () => togglePreference('showSupport'), toggleMask: () => togglePreference('maskExampleAnswer') }}>
    <WordCardProvider entries={entries} refresh={refresh} route={tab}>
    <div className={`app-shell tab-${tab} ${HOSTED_STUDY ? 'remote-study' : ''} ${NATIVE_STUDY ? 'native-study' : ''} ${EMBEDDED_STUDY ? 'embedded-study' : ''}`}>
      <header className="topbar">
        <div className="brand"><a className="brand-mark" href="#dictionary" onClick={event => followTabLink(event, 'dictionary')} aria-label="Открыть словарь"><Sparkles size={22} /></a><div><h1><a href="#dictionary" onClick={event => followTabLink(event, 'dictionary')}>Словарь</a> / <a href="#cards" onClick={event => followTabLink(event, 'cards')}>Карточки</a></h1><p>{NATIVE_STUDY ? 'Офлайн-копия · синхронизация Voice Record' : REMOTE_STUDY ? 'Общая база Voice Record на Mac' : 'Работает офлайн и синхронизируется через Voice Record'}</p></div></div>
        <SyncBadge stats={stats} syncing={syncing} onSync={() => refresh({ sync: true })} />
      </header>
      {!EMBEDDED_STUDY && <div className="summary">
        <div><span>В словаре</span><strong>{stats?.saved || 0}</strong></div>
        <div><span>Не учу</span><strong>{stats?.known || 0}</strong></div>
        <div><span>К повторению</span><strong>{stats?.due || 0}</strong></div>
        <div><span>Освоено</span><strong>{learnedPercent}%</strong></div>

      </div>}
      {!EMBEDDED_STUDY && <nav className="tabs" aria-label="Разделы">
        <a href="#dictionary" className={tab === 'dictionary' ? 'active' : ''} onClick={event => followTabLink(event, 'dictionary')}><BookOpen size={18} />словарь</a>
        <a href={`#${cardsRouteRef.current}`} className={tab === 'cards' || tab === 'session' || tab === 'archive' ? 'active' : ''} onClick={event => followTabLink(event, 'cards')}><Sparkles size={18} />карточки{(stats?.saved || 0) > 0 && <strong>{stats.saved}</strong>}</a>
        {!HOSTED_STUDY && <a href="#video" className={tab === 'video' ? 'active' : ''} onClick={event => followTabLink(event, 'video')}><Clapperboard size={18} />видео</a>}
        {(!HOSTED_STUDY || NATIVE_STUDY) && <a href="#practice" className={tab === 'practice' ? 'active' : ''} onClick={event => followTabLink(event, 'practice')}><MessageCircle size={18} />ai-чат-практика</a>}
        <a href="#settings" className={tab === 'settings' ? 'active' : ''} onClick={event => followTabLink(event, 'settings')}><Settings size={18} />настройки</a>
      </nav>}

      {error && <div className="error-banner">{error}<button type="button" onClick={() => setError('')}><X size={16} /></button></div>}
      {loading ? <div className="page-loader"><RefreshCw className="spin" /><span>Открываю локальную базу…</span></div> : tab === 'dictionary'
        ? <DictionaryView entries={entries} refresh={refresh} />
        : tab === 'cards'
          ? <DeckOverview entries={entries} stats={stats} onStart={() => chooseTab('session')} onOpenArchive={() => chooseTab('archive')} refresh={refresh} addRequest={addRequest} resuming={suspendedSession} />
          : tab === 'session'
            ? null
          : tab === 'archive'
            ? <ArchiveView entries={entries} refresh={refresh} onExit={() => chooseTab('cards')} />
          : tab === 'video'
            ? <VideoView />
          : tab === 'practice'
            ? NATIVE_STUDY ? null : <PracticeView entries={entries} refresh={refresh} onPracticeStats={applyPracticeStats} />
            : <SettingsView />}
      {!loading && NATIVE_STUDY && nativePracticeVisited && <div className="study-practice-host" hidden={tab !== 'practice'}>
        <PracticeView entries={entries} refresh={refresh} onPracticeStats={applyPracticeStats} active={tab === 'practice'} />
      </div>}
      {!loading && (tab === 'session' || suspendedSession) && <div className="study-deck-host" hidden={tab !== 'session'}>
        <DeckView entries={entries} refresh={refresh} active={tab === 'session'} resumeAttempt={studyState.current} onAddTerm={addAlternative}
          onExit={() => { setSuspendedSession(false); setAddRequest(null); chooseTab('cards') }} />
      </div>}
    </div>
    </WordCardProvider>
    </StudyPreferencesContext.Provider>
  )
}

createRoot(document.getElementById('root')).render(<App />)
