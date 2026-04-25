import React, { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  Database,
  FileText,
  HardDrive,
  Link2,
  MessageCircle,
} from 'lucide-react'

export default function SocialSourceOverview({ sourceId, source }) {
  const [state, setState] = useState({ loading: true, data: null, error: null })

  useEffect(() => {
    let alive = true
    setState({ loading: true, data: null, error: null })
    ;(async () => {
      if (!sourceId || !window.api?.sourceSocialOverview) {
        if (alive) setState({ loading: false, data: null, error: 'overview unavailable' })
        return
      }
      try {
        const r = await window.api.sourceSocialOverview(sourceId)
        if (!alive) return
        if (r?.ok) setState({ loading: false, data: r, error: null })
        else setState({ loading: false, data: null, error: r?.error || 'overview failed' })
      } catch (err) {
        if (alive) setState({ loading: false, data: null, error: String(err?.message || err) })
      }
    })()
    return () => { alive = false }
  }, [sourceId])

  if (state.loading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5 text-zinc-500">
        Загружаю обзор…
      </div>
    )
  }
  if (state.error || !state.data) {
    return (
      <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-5 text-red-300">
        {state.error || 'Не удалось загрузить обзор'}
      </div>
    )
  }

  return <OverviewBody data={state.data} source={source} />
}

function OverviewBody({ data, source }) {
  const c = data.counters || {}
  const links = data.links || {}
  const storage = data.storage || {}
  const bytes = data.bytes || {}
  const typeRows = Array.isArray(data.type_breakdown) ? data.type_breakdown : []
  const typeTotal = typeRows.reduce((sum, r) => sum + Number(r.count || 0), 0)
  const postLabel = source?.platform === 'twitter' ? 'Посты' : 'Посты'
  const kind = kindLabel(source?.platform, data.kind)
  const availability = useMemo(() => availabilityRows(data), [data])

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex flex-wrap items-start gap-3 mb-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-zinc-100 font-medium" style={{ fontSize: '16px' }}>
            <BarChart3 size={16} className="text-zinc-500" />
            Обзор данных
          </div>
          <div className="text-zinc-500 mt-1" style={{ fontSize: '14px' }}>
            {kind}
            {data.query ? ` · ${data.query}` : ''}
            {data.subreddit ? ` · ${data.subreddit}` : ''}
          </div>
        </div>
        <div className="text-zinc-500 text-right tabular-nums" style={{ fontSize: '14px' }}>
          source #{source?.id || '—'}
          {data.backend ? <div>{data.backend}</div> : null}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Metric icon={FileText} label={postLabel} value={fmt(c.post_items)} detail={`${fmt((c.with_caption || 0) + (c.with_title || 0))} с текстом`} />
        <Metric icon={MessageCircle} label="Комментарии" value={fmt(c.comment_items)} detail={c.max_depth > 1 ? `глубина до ${c.max_depth}` : 'сохранённые строки'} />
        <Metric icon={Link2} label="Ссылки" value={fmt((links.source_urls || 0) + (links.external_urls || 0))} detail={`${fmt(links.source_urls)} оригиналов`} />
        <Metric icon={HardDrive} label="Вес" value={formatBytes(storage.total_bytes)} detail={`${formatBytes(storage.media?.bytes || 0)} медиа`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)] gap-4">
        <Panel title="Что хранится в БД" icon={Database}>
          <div className="space-y-2">
            {availability.map(row => (
              <InfoRow key={row.label} label={row.label} value={row.value} tone={row.tone} detail={row.detail} />
            ))}
          </div>
          {typeRows.length > 0 && (
            <div className="mt-4 pt-3 border-t border-zinc-900">
              <div className="text-zinc-500 mb-2" style={{ fontSize: '13px' }}>Типы строк</div>
              <div className="flex flex-wrap gap-2">
                {typeRows.map(row => (
                  <TypePill
                    key={row.type}
                    label={typeLabel(row.type)}
                    count={row.count}
                    pct={typeTotal ? Number(row.count || 0) / typeTotal : 0}
                  />
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel title="Вес данных" icon={HardDrive}>
          <div className="space-y-2">
            <SizeRow label="Текст" value={formatBytes((bytes.title || 0) + (bytes.caption || 0))} />
            <SizeRow label="URL" value={formatBytes(bytes.url || 0)} />
            <SizeRow label="Raw meta" value={formatBytes(bytes.raw_meta || 0)} />
            <SizeRow
              label="Медиа-файлы"
              value={formatBytes(storage.media?.bytes || 0)}
              detail={`${fmt(storage.media?.present || 0)} / ${fmt(storage.media?.total || 0)} файлов`}
            />
            <SizeRow
              label="Индекс"
              value={formatBytes(storage.index?.bytes || 0)}
              detail={`${fmt(storage.index?.vectors || 0)} vectors`}
            />
          </div>
          <div className="mt-4 pt-3 border-t border-zinc-900 flex items-baseline justify-between">
            <span className="text-zinc-500" style={{ fontSize: '14px' }}>Итого</span>
            <span className="text-zinc-100 font-medium tabular-nums">{formatBytes(storage.total_bytes || 0)}</span>
          </div>
        </Panel>
      </div>
    </div>
  )
}

function Metric({ icon: Icon, label, value, detail }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/70 px-4 py-3 min-w-0">
      <div className="flex items-center gap-2 text-zinc-500 mb-1" style={{ fontSize: '13px' }}>
        <Icon size={14} />
        <span className="truncate">{label}</span>
      </div>
      <div className="text-zinc-100 font-medium tabular-nums" style={{ fontSize: '18px' }}>
        {value}
      </div>
      <div className="text-zinc-600 truncate" style={{ fontSize: '13px' }}>{detail}</div>
    </div>
  )
}

function Panel({ title, icon: Icon, children }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/50 p-4 min-w-0">
      <div className="flex items-center gap-2 text-zinc-300 font-medium mb-3" style={{ fontSize: '14px' }}>
        <Icon size={15} className="text-zinc-500" />
        {title}
      </div>
      {children}
    </div>
  )
}

function InfoRow({ label, value, detail, tone = 'neutral' }) {
  const toneClass = tone === 'good'
    ? 'text-emerald-300 bg-emerald-950/35 border-emerald-900/50'
    : tone === 'warn'
      ? 'text-amber-300 bg-amber-950/35 border-amber-900/50'
      : 'text-zinc-300 bg-zinc-900/60 border-zinc-800'
  return (
    <div className="flex items-start gap-3">
      <div className="w-32 shrink-0 text-zinc-500" style={{ fontSize: '14px' }}>{label}</div>
      <div className="min-w-0 flex-1">
        <span className={`inline-flex items-center min-h-6 px-2 rounded border ${toneClass}`} style={{ fontSize: '13px' }}>
          {value}
        </span>
        {detail && <div className="text-zinc-600 mt-0.5" style={{ fontSize: '13px' }}>{detail}</div>}
      </div>
    </div>
  )
}

function SizeRow({ label, value, detail }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-zinc-500 flex-1" style={{ fontSize: '14px' }}>{label}</span>
      <span className="text-zinc-200 tabular-nums">{value}</span>
      {detail && <span className="text-zinc-600 tabular-nums" style={{ fontSize: '13px' }}>{detail}</span>}
    </div>
  )
}

function TypePill({ label, count, pct }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 px-2 py-1">
      <span className="text-zinc-300" style={{ fontSize: '13px' }}>{label}</span>
      <span className="text-zinc-500 tabular-nums" style={{ fontSize: '13px' }}>{fmt(count)}</span>
      {pct > 0 && (
        <span className="w-10 h-1 rounded-full bg-zinc-800 overflow-hidden">
          <span className="block h-full bg-zinc-500" style={{ width: `${Math.max(4, Math.round(pct * 100))}%` }} />
        </span>
      )}
    </span>
  )
}

function availabilityRows(data) {
  const c = data.counters || {}
  const links = data.links || {}
  const storage = data.storage || {}
  const rows = [
    {
      label: 'Текст',
      value: c.with_caption || c.with_title ? `${fmt((c.with_caption || 0) + (c.with_title || 0))} строк` : 'нет текста',
      tone: c.with_caption || c.with_title ? 'good' : 'warn',
      detail: 'title + caption, готово для чтения агентом',
    },
    {
      label: 'Обсуждение',
      value: c.comment_items ? `${fmt(c.comment_items)} комментариев` : 'нет комментариев',
      tone: c.comment_items ? 'good' : 'neutral',
      detail: c.linked_reply_items ? `parent_external_id/depth заполнены у ${fmt(c.linked_reply_items)} строк` : 'поиск может содержать только посты',
    },
    {
      label: 'Авторы',
      value: c.authors ? `${fmt(c.authors)} авторов` : 'нет sender',
      tone: c.authors ? 'good' : 'neutral',
      detail: 'поле sender хранит автора поста или комментария',
    },
    {
      label: 'Ссылки',
      value: `${fmt(links.source_urls || 0)} оригиналов`,
      tone: links.source_urls ? 'good' : 'neutral',
      detail: links.external_urls ? `ещё ${fmt(links.external_urls)} внешних ссылок в тексте/meta` : 'только URL строк',
    },
    {
      label: 'Картинки',
      value: mediaStatus(data),
      tone: (storage.media?.present || 0) > 0 ? 'good' : (c.media_items ? 'warn' : 'neutral'),
      detail: links.media_urls ? `${fmt(links.media_urls)} media URL в raw meta` : 'media URL не найдены',
    },
    {
      label: 'Счётчики',
      value: countersStatus(c),
      tone: (c.with_likes || c.with_comment_counter || c.with_views) ? 'good' : 'neutral',
      detail: 'likes/comments/views сохраняются только если платформа их отдала',
    },
  ]
  if (storage.index?.vectors) {
    rows.push({
      label: 'Индекс',
      value: `${fmt(storage.index.vectors)} vectors`,
      tone: 'good',
      detail: 'семантические векторы уже занимают место в library.db',
    })
  }
  return rows
}

function mediaStatus(data) {
  const c = data.counters || {}
  const media = data.storage?.media || {}
  if (!c.media_items) return 'нет media'
  if (!media.total) return `${fmt(c.media_items)} строк · только URL`
  if (media.present >= media.total) return `${fmt(media.present)} файлов локально`
  return `${fmt(media.present)} / ${fmt(media.total)} локально`
}

function countersStatus(c) {
  const parts = []
  if (c.with_likes) parts.push(`likes ${fmt(c.with_likes)}`)
  if (c.with_comment_counter) parts.push(`comments ${fmt(c.with_comment_counter)}`)
  if (c.with_views) parts.push(`views ${fmt(c.with_views)}`)
  return parts.length ? parts.join(' · ') : 'нет'
}

function kindLabel(platform, kind) {
  if (platform === 'twitter') {
    if (kind === 'thread') return 'Twitter/X · тред'
    if (kind === 'search') return 'Twitter/X · поиск'
    return 'Twitter/X'
  }
  if (kind === 'thread') return 'Reddit · тред'
  if (kind === 'search') return 'Reddit · поиск'
  return platform === 'reddit' ? 'Reddit' : (platform || 'Источник')
}

function typeLabel(type) {
  return ({
    text: 'Посты',
    comment: 'Комментарии',
    photo: 'Фото',
    video: 'Видео',
    document: 'Документы',
    other: 'Прочее',
  })[type] || type || '—'
}

function fmt(n) {
  return Number(n || 0).toLocaleString('ru-RU')
}

function formatBytes(n) {
  const v = Number(n || 0)
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
}
