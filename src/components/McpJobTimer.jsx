import React, { useEffect, useState } from 'react'

// mm:ss or h:mm:ss. 0 sec -> "0:00".
export function formatMcpClock(secs) {
  if (!Number.isFinite(secs) || secs < 0) secs = 0
  secs = Math.floor(secs)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

export function hasMcpTimer(job) {
  return !!job && (Boolean(job.createdAt) || job.elapsedSec != null)
}

// Live timer for MCP jobs. Running/pending jobs tick from createdAt on the
// client; terminal jobs stay fixed at doneAt - createdAt, falling back to
// server elapsedSec when older snapshots do not have timestamps.
export default function McpJobTimer({ job, className = '' }) {
  const terminal = !job || job.status === 'done' || job.status === 'error' || job.status === 'tab_closed'
  const [, tick] = useState(0)

  useEffect(() => {
    if (terminal || !hasMcpTimer(job)) return
    const id = setInterval(() => tick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [terminal, job?.jobId, job?.createdAt, job?.elapsedSec])

  if (!hasMcpTimer(job)) return null

  let secs
  if (terminal) {
    secs = (job.doneAt && job.createdAt)
      ? (job.doneAt - job.createdAt) / 1000
      : (job.elapsedSec ?? 0)
  } else {
    secs = job.createdAt ? (Date.now() - job.createdAt) / 1000 : (job.elapsedSec ?? 0)
  }

  return <span className={className}>{formatMcpClock(secs)}</span>
}
