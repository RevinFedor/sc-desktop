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
const subs = new Set()

function emit() { subs.forEach(s => s()) }

function setJobs(next) {
  if (!Array.isArray(next)) return
  // shallow compare (одинаковая длина + одинаковые updatedAt) — экономим
  // ре-рендер. Stored state не используется как identity-source, useStore'ы
  // дают snapshot по запросу.
  const same = jobs.length === next.length && jobs.every((j, i) =>
    next[i] && j.jobId === next[i].jobId && j.updatedAt === next[i].updatedAt
  )
  if (same) return
  jobs = next
  emit()
}

async function refresh() {
  if (!window.api?.aistudioListJobs) return
  try {
    const r = await window.api.aistudioListJobs()
    lastFetchAt = Date.now()
    setJobs(r?.jobs || [])
  } catch {}
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

export function refreshAistudioJobs() { return refresh() }

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
