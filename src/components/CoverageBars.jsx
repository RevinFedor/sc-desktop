import React, { useState, useEffect } from 'react'
import { FolderOpen, Brain } from 'lucide-react'
import { useInvalidator } from '../lib/dataBus'

// Compact distribution chart for content types in the source.
// Replaces the previous date×depth bars (which read as bogus progress bars).
// Just a horizontal stacked bar showing share of types + a count legend.

// Single source of truth for Telegram message-type labels in the SourceDetail
// distribution chart. Keep aligned with JobDetail::TG_TYPE_LABEL — same buckets,
// same wording. Older fetches (before classify() learned about sticker/gif/
// service) wrote rows with `type='other'`; those keep showing as «Прочее»
// until the chat is re-fetched.
const TYPE_LABELS = {
  text:     'Текст',
  voice:    'Голос',
  video:    'Видео',
  photo:    'Фото',
  audio:    'Аудио',
  sticker:  'Стикеры',
  gif:      'GIF',
  document: 'Документы',
  poll:     'Опросы',
  service:  'Системные',
  other:    'Прочее',
}

const TYPE_COLORS = {
  text:     '#71717a',  // zinc-500
  voice:    '#10b981',  // emerald-500
  video:    '#f59e0b',  // amber-500
  photo:    '#3b82f6',  // blue-500
  audio:    '#8b5cf6',  // violet-500
  sticker:  '#06b6d4',  // cyan-500
  gif:      '#f97316',  // orange-500
  document: '#ec4899',  // pink-500
  poll:     '#eab308',  // yellow-500
  service:  '#64748b',  // slate-500
  other:    '#52525b',  // zinc-600
}

/**
 * Props:
 *   typeBreakdown: [{ type, count, with_media, transcribed }, ...]
 *   totalItems:    pre-computed sum
 *   indexed:       count of items that already have a vector in items_vec.
 *                  Renders an extra one-line summary "Семантический индекс:
 *                  N / total (P%)" below the bar — gives the user immediate
 *                  feedback whether the chat is searchable semantically.
 *
 * Renders one stacked bar (relative shares of types) + a legend with
 * per-type counts and "missing media" warnings.
 */
export default function CoverageBars({
  sourceId = null,
  typeBreakdown = [], totalItems = 0, platform = 'telegram', indexed = 0,
  commentsCount = 0,
}) {
  if (!typeBreakdown.length || !totalItems) return null

  // Sort the bar by count desc — biggest type comes first.
  const sorted = [...typeBreakdown].sort((a, b) => b.count - a.count)

  // Indexer embeds anything with a non-empty caption — that includes text
  // messages AND photos/documents that have a textual caption (a media post
  // with a body of text is fully embeddable). So the realistic denominator
  // is "rows with caption", not just "type=text". Sum across all types.
  //
  // Fallback chain: with_caption (preferred) → text count → totalItems.
  // Whatever we picked, we clamp `indexed` from above so the displayed
  // numerator never exceeds the denominator (which used to read "9684 / 9161"
  // when text-only count was used and the indexer also covered photo
  // captions).
  const withCaption = typeBreakdown.reduce((s, r) => s + (r.with_caption || 0), 0)
  const indexable = withCaption || totalItems
  const indexedShown = Math.min(indexed, indexable)
  const idxPct = indexable > 0 ? (indexedShown / indexable) * 100 : 0

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex h-3 rounded overflow-hidden border border-zinc-800/50">
        {sorted.map(row => {
          const pct = (row.count / totalItems) * 100
          if (pct < 0.5) return null
          return (
            <div
              key={row.type}
              style={{ width: `${pct}%`, background: TYPE_COLORS[row.type] || '#71717a' }}
              title={`${TYPE_LABELS[row.type] || row.type}: ${row.count} (${pct.toFixed(1)}%)`}
            />
          )
        })}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5">
        {sorted.map(row => (
          <Legend key={row.type} row={row} platform={platform} />
        ))}
      </div>

      {/* Telegram channel comments live in a sibling discussion group, not
          the items table — so they're not in `typeBreakdown`. Render as a
          separate summary chip below the legend so the user sees «yes, we
          have N stored». 0 = nothing pulled yet, hide. */}
      {platform === 'telegram' && commentsCount > 0 && (
        <div className="mt-2 text-zinc-400" style={{ fontSize: '14px' }}>
          <span className="inline-flex items-center gap-1.5">
            <span>💬</span>
            <span>комментариев <span className="text-zinc-100 tabular-nums">{commentsCount.toLocaleString('ru-RU')}</span></span>
          </span>
        </div>
      )}

      {/* Semantic index progress — Telegram only (others don't index yet). */}
      {platform === 'telegram' && (
        <div className="mt-3 pt-3 border-t border-zinc-800/60">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-400 inline-flex items-center gap-1.5"><Brain size={14} /> Семантический индекс</span>
            <div className="flex-1 h-1.5 rounded-full bg-zinc-900 overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-[width] duration-300"
                style={{ width: `${idxPct}%` }}
              />
            </div>
            <span className="text-zinc-300 tabular-nums shrink-0">
              {indexedShown.toLocaleString()} / {indexable.toLocaleString()}
              <span className="text-zinc-500 ml-1.5">({idxPct.toFixed(0)}%)</span>
            </span>
          </div>
        </div>
      )}

      {/* Disk-weight breakdown — how much each payload kind costs on disk, so
          the user can see what's eating space. Decomposed by PAYLOAD, not by
          message type (a photo's caption is text-in-DB; the photo file is
          media-on-disk). Telegram only for now — YT/IG store transcripts the
          same way but the per-type warnings above are TG-shaped. */}
      {sourceId != null && platform === 'telegram' && (
        <StorageRow sourceId={sourceId} />
      )}
    </div>
  )
}

// Bytes → human MB/KB/GB. Mirrors CopySavedPanel.formatBytes scale but adds
// GB for the index, which on a fully-indexed 76k-message channel is ~234 MB
// and climbs past a GB across several big sources.
function fmtSize(n) {
  if (!n) return '0'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

// Per-source disk usage, fetched lazily and refreshed on the same data-bus key
// the rest of this view uses — so a finished fetch/index updates the numbers
// without a manual reload. The right-side folder button reveals the storage
// root in Finder (one dir for everything — CLAUDE.md storage invariant).
function StorageRow({ sourceId }) {
  const [st, setSt] = useState(null)
  const itemsVer = useInvalidator(`items:${sourceId}`)
  useEffect(() => {
    if (!window.api?.sourceStorage || sourceId == null) return
    let alive = true
    window.api.sourceStorage(sourceId)
      .then(r => { if (alive && r?.ok) setSt(r) })
      .catch(() => {})
    return () => { alive = false }
  }, [sourceId, itemsVer])

  if (!st) return null

  // Show a chip per non-empty kind. Text and Index are almost always present;
  // media/transcripts only when files were actually downloaded (most TG
  // sources keep metadata-only, so those stay hidden rather than reading
  // «0 MB» noise).
  const chips = [
    { key: 'text',        label: 'Текст',       bytes: st.text?.bytes || 0,        color: '#71717a' },
    { key: 'media',       label: 'Медиа',       bytes: st.media?.bytes || 0,       color: '#3b82f6' },
    { key: 'transcripts', label: 'Транскрипты', bytes: st.transcripts?.bytes || 0, color: '#10b981' },
    { key: 'index',       label: 'Индекс',      bytes: st.index?.bytes || 0,       color: '#ec4899' },
  ].filter(c => c.bytes > 0 || c.key === 'text' || c.key === 'index')

  async function openFolder() {
    try { await window.api?.storageOpenRoot?.(st.root) } catch {}
  }

  return (
    <div className="mt-3 pt-3 border-t border-zinc-800/60 flex items-center gap-x-4 gap-y-1.5 flex-wrap">
      <span className="text-zinc-500 shrink-0" style={{ fontSize: '13px' }}>На диске</span>
      {chips.map(c => (
        <span key={c.key} className="inline-flex items-center gap-1.5" style={{ fontSize: '13px' }}>
          <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: c.color }} />
          <span className="text-zinc-400">{c.label}</span>
          <span className="text-zinc-200 tabular-nums">{fmtSize(c.bytes)}</span>
          {c.key === 'index' && st.index?.vectors > 0 && (
            <span className="text-zinc-600 tabular-nums" title="векторов в индексе">
              ({st.index.vectors.toLocaleString('ru-RU')})
            </span>
          )}
        </span>
      ))}
      <span className="text-zinc-700">·</span>
      <span className="inline-flex items-center gap-1.5" style={{ fontSize: '13px' }}>
        <span className="text-zinc-500">всего</span>
        <span className="text-zinc-100 tabular-nums font-medium">{fmtSize(st.total_bytes)}</span>
      </span>
      <button
        onClick={openFolder}
        className="ml-auto shrink-0 p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"
        title="Открыть папку хранилища в Finder"
      >
        <FolderOpen size={15} />
      </button>
    </div>
  )
}

// Which Telegram message-types actually expect *something* beyond raw metadata
// (a media file, a transcript, a caption). Anything outside this set —
// service messages (pinned/joined/title-changed), stickers, GIFs — never
// carries downloadable media nor an AI-processable payload, so a «⚠ N»
// warning on them is false-positive (count would always equal item count).
// «Системные 8 ⚠ 8» was the symptom users complained about; this set is
// the gate.
const TYPES_WITH_EXPECTED_MEDIA = new Set([
  'voice', 'video', 'audio', 'photo', 'document', 'docs', 'poll',
])

function Legend({ row, platform }) {
  // YouTube and Instagram items are streamed/transcribed remotely — they
  // never have a local media_path, so the "files not downloaded" warning
  // is meaningless there. Only show it for platforms where local media is
  // the norm (Telegram).
  const isStreaming = platform === 'youtube' || platform === 'instagram'
  const isPoll = row.type === 'poll'
  const hasExpectedPipeline = TYPES_WITH_EXPECTED_MEDIA.has(row.type)
  const transcribed = row.processed || row.transcribed || 0
  const stillNeeded = isPoll ? (row.with_caption || 0) : (row.with_media + transcribed)
  const missing = !isStreaming && hasExpectedPipeline && stillNeeded < row.count
  const missingCount = row.count - stillNeeded
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
        style={{ background: TYPE_COLORS[row.type] || '#71717a' }}
      />
      <span className="text-zinc-300">{TYPE_LABELS[row.type] || row.type}</span>
      <span className="text-zinc-500 tabular-nums">{row.count.toLocaleString()}</span>
      {missing && (
        <span
          style={{ fontSize: '14px' }}
          className="text-amber-400 tabular-nums"
          title={`${missingCount} ${TYPE_LABELS[row.type] || row.type}: только метаданные, файл/текст не загружены`}
        >
          ⚠ {missingCount.toLocaleString()}
        </span>
      )}
    </div>
  )
}
