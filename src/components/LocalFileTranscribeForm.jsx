import React, { useState, useEffect, useImperativeHandle, useMemo, forwardRef } from 'react'
import { Mic, Copy } from 'lucide-react'
import { startLocalTranscribe, watchJob, useJobs } from '../lib/jobs'
import { formatCopyToast } from '../lib/formatTokens'

const ENGINES = [
  { id: 'assemblyai', label: 'AssemblyAI',       hint: '🔊 long-form (>2ч), default' },
  { id: 'gemini',     label: 'Gemini 2.5 Flash', hint: '⚡ дёшево, чанки 10мин' },
]

/**
 * Inline form for a pasted local file path. The flow is one-shot:
 *   - mount → show file name + (size if available) + engine selector
 *   - submit → spawn local_transcribe_ndjson, watch job
 *   - done   → clipboard auto-copy, "Скопировать ещё раз" button
 *
 * No cache lookup (each pasted file is treated as fresh — duplicates land
 * in Activity tab, where the user can copy the prior transcript).
 */
const LocalFileTranscribeForm = forwardRef(function LocalFileTranscribeForm({ path, onStarted }, ref) {
  // Stages: 'idle' | 'transcribing' | 'done' | 'error'
  const [stage, setStage] = useState('idle')
  const [engine, setEngine] = useState('assemblyai')
  const [job, setJob] = useState(null)
  const [err, setErr] = useState(null)
  const [toast, setToast] = useState(null)
  const [busy, setBusy] = useState(false)

  const fileName = useMemo(() => {
    if (!path) return ''
    const i = path.lastIndexOf('/')
    return i >= 0 ? path.slice(i + 1) : path
  }, [path])

  // Re-mount restoration: find an existing local_transcribe job for this path
  // and re-attach. Without this the component loses transcribing/error state
  // when the user navigates to Activity and back to Home.
  const allJobs = useJobs()
  useEffect(() => {
    if (!path) return
    const match = allJobs
      .filter(j => j.type === 'local_transcribe' && j.target === path)
      .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0]
    if (match) {
      // Restore from existing job for this path
      setJob(match)
      if (match.local?.engine) {
        setEngine(match.local.engine)
      }
      if (match.status === 'done') {
        setStage('done')
      } else if (match.status === 'error') {
        setErr(match.error || 'Unknown error')
        setStage('error')
      } else if (match.status === 'running') {
        setStage('transcribing')
        const off = watchJob(match.id, snap => {
          setJob(snap)
          if (snap.status === 'done') setStage('done')
          else if (snap.status === 'error') { setErr(snap.error || 'Unknown'); setStage('error') }
          else if (snap.status === 'cancelled') setStage('idle')
        })
        return off
      }
    } else {
      // No existing job for this path — reset to idle state with default engine
      setJob(null)
      setStage('idle')
      setErr(null)
      setEngine('assemblyai')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  async function kickOff() {
    if (!path) {
      setErr('Путь к файлу пустой')
      setStage('error')
      return
    }
    setStage('transcribing'); setErr(null); setBusy(true)
    try {
      const id = await startLocalTranscribe({ path, engine })
      if (id == null) {
        setErr('Электрон-IPC недоступен')
        setStage('error'); return
      }
      onStarted && onStarted(id)
      const off = watchJob(id, snap => {
        setJob(snap)
        if (snap.status === 'done') {
          setStage('done')
          if (snap.local?.copied_bytes) {
            setToast(`Готово · скопировано (${formatBytes(snap.local.copied_bytes)})`)
          }
        } else if (snap.status === 'error') {
          setErr(snap.error || 'Unknown error')
          setStage('error')
        } else if (snap.status === 'cancelled') {
          setStage('idle')
        }
      })
      void off
    } finally {
      setBusy(false)
    }
  }

  async function copyAgain() {
    const fp = job?.file_path
    if (!fp || !window.api?.copyFile) return
    setBusy(true)
    try {
      const r = await window.api.copyFile(fp)
      if (r?.ok) setToast(formatCopyToast({ bytes: r.bytes }))
    } finally {
      setBusy(false)
      setTimeout(() => setToast(null), 2200)
    }
  }

  useImperativeHandle(ref, () => ({
    trigger() {
      if (busy) return true
      if (stage === 'idle')  { kickOff(); return true }
      if (stage === 'error') { kickOff(); return true }
      if (stage === 'done')  { copyAgain(); return true }
      // 'transcribing' — busy, no-op
      return true
    },
  }), [stage, busy, engine, job?.file_path])

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
      <Header fileName={fileName} job={job} stage={stage} />

      {(stage === 'idle' || stage === 'error') && (
        <ConfigPanel
          engine={engine}
          setEngine={setEngine}
          onStart={kickOff}
          busy={busy}
          err={stage === 'error' ? err : null}
        />
      )}

      {stage === 'transcribing' && (
        <TranscribingPanel job={job} engine={engine} />
      )}

      {stage === 'done' && (
        <DonePanel job={job} onCopyAgain={copyAgain} busy={busy} />
      )}

      {toast && (
        <div className="text-zinc-400 mt-3" style={{ fontSize: '14px' }}>{toast}</div>
      )}
    </div>
  )
})

export default LocalFileTranscribeForm

// ─── Sub-panels ─────────────────────────────────────────────────────────

function Header({ fileName, job, stage }) {
  const local = job?.local || {}
  const dur = local.duration_sec
  const size = local.size_bytes
  return (
    <div className="flex items-start gap-3 mb-4">
      <FileIcon />
      <div className="flex-1 min-w-0">
        <div className="text-zinc-100 font-medium truncate">{fileName || '—'}</div>
        <div className="text-zinc-500 truncate" style={{ fontSize: '14px' }}>
          {size ? formatBytes(size) : 'локальный файл'}
          {dur ? <> · {fmtDur(dur)}</> : null}
        </div>
      </div>
    </div>
  )
}

function FileIcon() {
  return (
    <div className="w-16 h-10 rounded bg-zinc-900 border border-zinc-800 shrink-0 flex items-center justify-center text-zinc-500">
      🎬
    </div>
  )
}

function ConfigPanel({ engine, setEngine, onStart, busy, err }) {
  return (
    <div className={`rounded-md border ${err ? 'border-red-800/50 bg-red-900/10' : 'border-zinc-800 bg-zinc-900'} px-4 py-3 mb-3`}>
      {err && (
        <div className="flex items-center gap-2 mb-3">
          <span className="text-red-400">✗</span>
          <span className="text-zinc-300 break-words" style={{ fontSize: '14px' }}>{err}</span>
        </div>
      )}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <div className="text-zinc-200">
            Жми <kbd className="px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-200 text-xs">Enter</kbd>,
            чтобы транскрибировать
          </div>
        </div>
        <Btn primary onClick={onStart} busy={busy}>
          <Mic className="w-4 h-4" /> {err ? 'Повторить' : 'Транскрибировать'}
        </Btn>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {ENGINES.map(e => (
          <button
            key={e.id}
            type="button"
            onClick={() => setEngine(e.id)}
            className={`text-left px-3 py-2 rounded-md border ${
              engine === e.id
                ? 'bg-zinc-800 border-zinc-500'
                : 'bg-zinc-900 border-zinc-800 hover:border-zinc-600'
            }`}
          >
            <div className="text-zinc-100">{e.label}</div>
            <div className="text-zinc-500" style={{ fontSize: '14px' }}>{e.hint}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function TranscribingPanel({ job, engine }) {
  const eng = job?.local?.engine || engine
  const local = job?.local || {}
  // AAI sub-stage progression: uploading → queued → transcribing → completed.
  // For Gemini there's no fine-grained progress (chunked pipeline runs
  // internally), so we keep the legacy "Файл уходит в API…" hint.
  const aaiStage = eng === 'assemblyai' ? local.aai_stage : null
  const stageLabel =
    aaiStage === 'uploading'    ? 'Заливаем файл на сервер AssemblyAI…' :
    aaiStage === 'queued'       ? 'В очереди обработки…' :
    aaiStage === 'transcribing' ? buildAAILabel(local) :
    aaiStage === 'completed'    ? 'Получаем результат…' :
    null

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 mb-3">
      <div className="flex items-center gap-2 mb-1">
        <Spinner />
        <span className="text-zinc-200">Транскрибация ({eng})…</span>
      </div>
      <div className="text-zinc-500" style={{ fontSize: '14px' }}>
        {stageLabel || 'Файл уходит в API. Длинные ролики могут занять несколько минут.'}
      </div>
    </div>
  )
}

function buildAAILabel(local) {
  const el = Number(local.aai_elapsed_sec || 0)
  const dur = Number(local.aai_audio_dur_sec || 0)
  const elFmt = mmssLocal(el)
  if (dur > 0) {
    // ETA = audio_duration × 0.2 (universal-2 ~5x realtime; rough)
    const etaSec = Math.max(30, Math.round(dur * 0.2))
    return `Транскрибируем · ${elFmt} / ~${humanShortLocal(etaSec)}`
  }
  return `Транскрибируем · ${elFmt}`
}

function mmssLocal(sec) {
  const s = Math.max(0, Math.floor(sec || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

function humanShortLocal(sec) {
  if (sec < 60) return `${sec} сек`
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} мин`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm ? `${h} ч ${mm} мин` : `${h} ч`
}

function DonePanel({ job, onCopyAgain, busy }) {
  const local = job?.local || {}
  return (
    <div className="rounded-md border border-emerald-800/50 bg-emerald-900/10 px-4 py-3 mb-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-emerald-400">✓</span>
          <span className="text-zinc-200">Готово — текст в буфере</span>
        </div>
        <div className="text-zinc-400" style={{ fontSize: '14px' }}>
          AI · {local.engine || ''}
          {local.chars ? <> · {local.chars.toLocaleString('ru-RU')} символов</> : null}
          {local.cost_usd ? <> · ${local.cost_usd.toFixed(4)}</> : null}
        </div>
      </div>
      <Btn primary onClick={onCopyAgain} busy={busy}><Copy className="w-4 h-4" /> Скопировать ещё раз</Btn>
    </div>
  )
}

// ─── helpers ────────────────────────────────────────────────────────────

function Btn({ children, onClick, busy, primary }) {
  const base = 'px-3 py-1.5 rounded-md transition-colors min-w-[180px] text-center inline-flex items-center justify-center gap-1.5'
  const styles = primary
    ? 'bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500'
    : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
  return (
    <button onClick={onClick} disabled={busy} className={`${base} ${styles}`}>
      {busy ? '…' : children}
    </button>
  )
}

function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-zinc-600 border-t-zinc-200 animate-spin" />
  )
}

function fmtDur(secs) {
  if (!secs) return '—'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024)        return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
