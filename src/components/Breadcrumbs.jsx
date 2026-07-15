import React from 'react'
import { Settings, FileText } from 'lucide-react'
import { useStore, navigateTo } from '../lib/store'
import { useSources } from '../lib/sources'
import { useFolders } from '../lib/folders'

/**
 * Persistent breadcrumb header. Reads the screen stack from the store,
 * renders [Home] › [crumb] › [current].  Each crumb except the last is
 * clickable and jumps to that point via navigateTo().
 *
 * The current screen is shown as plain text on the right (no Back button —
 * back navigation happens by clicking the previous crumb).  Sub-screens
 * therefore no longer need their own ← Back / title bars.
 */
export default function Breadcrumbs() {
  const screen  = useStore(s => s.screen)
  const history = useStore(s => s.history)
  const sources = useSources()
  const folders = useFolders()

  // Don't render at home — there's nowhere to go back to and no trail.
  if (history.length === 0 && screen.name === 'paste') return null

  // The first history entry is almost always a paste-screen — Home already
  // represents that, so skip it to avoid "Home › New paste › X".
  const skipFirst = history.length > 0 && history[0].name === 'paste'
  const trail = [...history.slice(skipFirst ? 1 : 0), screen]
  const lastIdx = trail.length - 1

  return (
    <div className="h-10 border-b border-zinc-800 px-6 flex items-center gap-2 shrink-0">
      <Crumb
        label="Главная"
        onClick={history.length === 0 && screen.name === 'paste' ? null : () => navigateTo(-1)}
        muted={lastIdx >= 0}
      />
      {trail.map((s, i) => {
        const last = i === lastIdx
        const c = crumbFor(s, sources, folders)
        // i in `trail` may be offset by the skipped paste — translate back
        // to the canonical index in store.history for navigateTo().
        const histIdx = i + (skipFirst ? 1 : 0)
        return (
          <React.Fragment key={i}>
            <Sep />
            <Crumb
              label={c.label}
              icon={c.icon}
              onClick={last ? null : () => navigateTo(histIdx)}
              muted={!last}
            />
          </React.Fragment>
        )
      })}
    </div>
  )
}

function Sep() {
  return <span className="text-zinc-700 select-none" style={{ fontSize: '14px' }}>›</span>
}

function Crumb({ label, icon, onClick, muted }) {
  const className = onClick
    ? 'flex items-center gap-1.5 cursor-pointer text-zinc-400 hover:text-zinc-100 transition-colors'
    : `flex items-center gap-1.5 ${muted ? 'text-zinc-500' : 'text-zinc-100 font-medium'}`
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag onClick={onClick || undefined} className={className} style={{ fontSize: '14px' }}>
      {icon && <span className="flex items-center">{icon}</span>}
      <span className="truncate max-w-[260px]">{label}</span>
    </Tag>
  )
}

/**
 * Resolve a {label, icon} for a screen-stack entry. Pulls live source data
 * for source-detail / job-detail entries. Static labels for everything else.
 */
function crumbFor(screen, sources, folders) {
  const { name, payload } = screen
  switch (name) {
    case 'paste':
      return { label: 'Новый запрос' }
    case 'telegram':
      return { label: 'Telegram' }
    case 'youtube':
      return { label: 'YouTube' }
    case 'instagram':
      return { label: 'Instagram' }
    case 'reddit':
      return { label: 'Reddit' }
    case 'tiktok':
      return { label: 'TikTok' }
    case 'twitter':
      return { label: 'X' }
    case 'tg-config':
      return { label: payload?.target ? `Custom fetch · ${payload.target}` : 'Custom fetch' }
    case 'yt-config':
      return { label: 'YouTube' }
    case 'ig-config':
      return { label: 'Instagram' }
    case 'settings':
      if (!payload?.section || payload.section === 'main') {
        return { label: 'Настройки', icon: <Settings size={13} /> }
      }
      return { label: ({
        telegram: 'Telegram',
        youtube: 'YouTube',
        instagram: 'Instagram',
        reddit: 'Reddit',
        tiktok: 'TikTok',
        twitter: 'X',
      })[payload.section] || 'Настройки' }
    case 'new-research':
      return { label: 'Новый research' }
    case 'source-detail': {
      const src = sources.find(s => s.id === payload?.sourceId)
      if (src) {
        const title = (src.display_name && src.display_name !== src.handle)
          ? src.display_name
          : '@' + src.handle
        return { label: title }
      }
      return { label: 'Источник…' }
    }
    case 'job-detail': {
      // Folder-typed jobs: show folder title (or generic "обновление папок")
      // instead of the meaningless "Job #1". entity_title isn't set for them.
      const job = payload?.job
      if (job?.type === 'tg_folder_fetch') {
        const fid = job.tg_folder?.folder_id
        const f = folders?.find(x => x.id === fid)
        return { label: f ? `Папка · ${f.title}` : 'Папка' }
      }
      if (job?.type === 'tg_folder_refresh') {
        return { label: 'Обновление папок' }
      }
      // Most jobs are reached from a source-detail screen, so the parent
      // crumb already shows the chat/channel name. Showing entity_title
      // here too produces «@bari_s_patrikovv › bari_s_patrikovv» — visual
      // duplicate. Use a job-type label + #N instead so the crumb actually
      // describes *which operation* this screen represents. Labels mirror
      // JobDetail::headerLabel.
      const num = payload?.jobId != null ? `#${payload.jobId}` : ''
      const TYPE_LABEL = {
        tg_fetch:             'Telegram fetch',
        tg_preview:           'Telegram preview',
        tg_index:             'Семантический индекс',
        tg_reply_backfill:    'Reply backfill',
        yt_transcribe:        'YouTube транскрипт',
        yt_channel_fetch:     'YouTube канал',
        yt_batch_transcribe:  'YouTube batch',
        yt_comments:          'YouTube комментарии',
        yt_batch_comments:    'YouTube комментарии (batch)',
        tk_transcribe:        'TikTok транскрипт',
        tk_channel_fetch:     'TikTok канал',
        tk_batch_transcribe:  'TikTok batch',
        ig_profile_fetch:     'Instagram профиль',
        ig_batch_transcribe:  'Instagram batch',
        local_transcribe:     'Локальный файл',
      }
      const typed = TYPE_LABEL[job?.type]
      if (typed) return { label: num ? `${typed} · ${num}` : typed }
      // Unknown job type — fall back to entity_title so we still show
      // something useful, never a bare «Job #» without context.
      return { label: job?.entity_title ? `${job.entity_title} · ${num}` : (`Job ${num}` || 'Job') }
    }
    case 'notes':
      return { label: 'Заметки', icon: <FileText size={13} /> }
    case 'aistudio-job':
      // Research/MCP постмортем — заголовок-провайдер живёт на самой
      // странице; в крошке достаточно типа экрана.
      return { label: 'Research' }
    default:
      return { label: name }
  }
}
