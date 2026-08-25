// AI Studio MCP jobs store — зеркало того что в browser-bridge.js Map.
//
// Канал push: window.api.onAistudioUpdate({jobs}) — main process broadcast'ит
// каждые 1.5с если состояние изменилось.
//
// Канал pull: window.api.aistudioListJobs() — explicit refresh (после mount'а,
// после восстановления сети, после ручного клика «обновить»).
//
// Renderer держит локальный snapshot и subscribes к push'ам. useAistudioJobs()
// hook возвращает текущий список.

import { useSyncExternalStore } from 'react'

let jobs = []           // {jobId, status, stage, modelId, elapsedSec, ...}[]
let lastFetchAt = 0
let summaryRefreshInFlight = null
let fullRefreshInFlight = null
const subs = new Set()

function emit() { subs.forEach(s => s()) }

function setJobs(next, { preserveDetails = false } = {}) {
  if (!Array.isArray(next)) return
  // shallow compare (одинаковая длина + одинаковые updatedAt) — экономим
  // ре-рендер. Stored state не используется как identity-source, useStore'ы
  // дают snapshot по запросу.
  const same = jobs.length === next.length && jobs.every((j, i) =>
    next[i] && j.jobId === next[i].jobId && j.updatedAt === next[i].updatedAt
  )
  if (preserveDetails && same) return
  if (preserveDetails) {
    const previous = new Map(jobs.map(job => [job.jobId, job]))
    // Summary updates deliberately omit responseText/sources/fullPrompt.
    // Merge them over an already-loaded detail object so opening one job does
    // not lose its answer on the next 1.5-second navbar update.
    jobs = next.map(job => previous.has(job.jobId)
      ? { ...previous.get(job.jobId), ...job }
      : job)
  } else {
    jobs = next
  }
  emit()
}

async function refresh(options = {}) {
  if (!window.api?.aistudioListJobs) return
  const full = options?.full === true
  const current = full ? fullRefreshInFlight : summaryRefreshInFlight
  if (current) return current
  const promise = (async () => {
    try {
      const r = await window.api.aistudioListJobs({ full })
      lastFetchAt = Date.now()
      setJobs(r?.jobs || [], { preserveDetails: !full })
      return r
    } catch {
      return null
    }
  })()
  if (full) fullRefreshInFlight = promise
  else summaryRefreshInFlight = promise
  try {
    return await promise
  } finally {
    if (full && fullRefreshInFlight === promise) fullRefreshInFlight = null
    if (!full && summaryRefreshInFlight === promise) summaryRefreshInFlight = null
  }
}

// Wire push-канал на load. Без это renderer не получит свежие jobs при
// background-фоновом обновлении (когда юзер смотрит другую вкладку).
let wired = false
function wirePushOnce() {
  if (wired) return
  wired = true
  if (window.api?.onAistudioUpdate) {
    window.api.onAistudioUpdate(({ jobs: next }) => setJobs(next))
  }
  // Pull при wire — чтобы UI получил state даже если push ещё не пришёл.
  refresh()
}

function subscribe(fn) {
  wirePushOnce()
  subs.add(fn)
  // Если данные старше 10с — обновим.
  if (Date.now() - lastFetchAt > 10000) refresh()
  return () => subs.delete(fn)
}

export function useAistudioJobs(selector = j => j) {
  return useSyncExternalStore(subscribe, () => selector(jobs), () => selector(jobs))
}

export function refreshAistudioJobs(options = {}) { return refresh(options) }

export async function clearAistudioJob(payload) {
  if (!window.api?.aistudioClearJob) return
  await window.api.aistudioClearJob(payload || {})
  await refresh()
}

// Per-job keepTab toggle. Если true — после успешного завершения вкладка
// НЕ закрывается auto. Сохраняется в bridge AISTUDIO_JOBS, расширение
// проверяет флаг перед chrome.tabs.remove.
export async function setAistudioJobKeepTab(jobId, keepTab) {
  if (!window.api?.aistudioSetKeepTab) return
  // Локально обновим snapshot чтобы UI среагировал мгновенно — не ждать
  // round-trip через bridge.
  const idx = jobs.findIndex(j => j.jobId === jobId)
  if (idx >= 0) {
    const next = jobs.slice()
    next[idx] = { ...next[idx], keepTab: !!keepTab, updatedAt: Date.now() }
    setJobs(next)
  }
  await window.api.aistudioSetKeepTab({ jobId, keepTab: !!keepTab })
  await refresh()
}

export function getAistudioJobs() { return jobs }
