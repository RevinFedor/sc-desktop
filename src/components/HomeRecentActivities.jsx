import React from 'react'
import { useJobsSelector } from '../lib/jobs'
import { sameArrayItems } from '../lib/jobSelectorCore.mjs'
import { pushScreen } from '../lib/store'
import { useSources } from '../lib/sources'
import PlatformLogo from './PlatformLogo'

// Минималистичный список последних действий для PasteScreen.
//
// Зачем: пользователь кликает на видео в браузере → скроллит дальше → быстро
// забывает на что кликал. Когда возвращается в desktop, хочет одним взглядом
// увидеть «вот мои недавние действия». ActivityPanel в боковой шторе для
// этого слишком громоздкий и спрятан за иконкой.
//
// Показываем последние 8 jobs (running + recent done/error), компактные
// строки. Click → JobDetail (для running) или SourceDetail (если у job
// есть source_id).
//
// Не показываем когда совсем пусто (нечего показывать) или когда юзер уже
// что-то парсит (committed форма открыта — не отвлекаем).
//
// Заголовок — серый caps маленький, как у Recent paste выше, чтобы блок
// смотрелся как часть Home, а не отдельная страница.

const PLATFORM_BY_TYPE = {
  tg_fetch: 'telegram', tg_preview: 'telegram',
  yt_transcribe: 'youtube', yt_comments: 'youtube', yt_batch_comments: 'youtube',
  yt_channel_fetch: 'youtube', yt_batch_transcribe: 'youtube',
  rutube_transcribe: 'rutube',
  tk_transcribe: 'tiktok', tk_channel_fetch: 'tiktok', tk_batch_transcribe: 'tiktok',
  ig_profile_fetch: 'instagram',
  boosty_transcribe: 'boosty',
  boosty_channel_fetch: 'boosty', boosty_batch_transcribe: 'boosty',
  local_transcribe: 'local',
}

const TYPE_LABEL = {
  tg_fetch:             'Telegram',
  tg_preview:           'Telegram',
  yt_transcribe:        'YouTube видео',
  yt_comments:          'YouTube комменты',
  yt_batch_comments:    'YouTube комменты · batch',
  yt_channel_fetch:     'YouTube канал',
  yt_batch_transcribe:  'YouTube batch',
  rutube_transcribe:    'Rutube видео',
  tk_transcribe:        'TikTok видео',
  tk_channel_fetch:     'TikTok канал',
  tk_batch_transcribe:  'TikTok batch',
  ig_profile_fetch:     'Instagram',
  boosty_transcribe:    'Boosty видео',
  boosty_channel_fetch: 'Boosty каталог',
  boosty_batch_transcribe: 'Boosty batch',
  local_transcribe:     'Локальный файл',
}

function humanAgo(secs) {
  if (secs < 5)     return 'только что'
  if (secs < 60)    return `${secs}с назад`
  if (secs < 3600)  return `${Math.round(secs / 60)} мин назад`
  if (secs < 86400) return `${Math.round(secs / 3600)} ч назад`
  return `${Math.round(secs / 86400)} д назад`
}

function StatusDot({ status }) {
  const color = {
    running:     '#10b981',
    awaiting_ai: '#f59e0b',
    done:        '#52525b',
    error:       '#ef4444',
    cancelled:   '#a1a1aa',
    pending:     '#a1a1aa',
  }[status] || '#52525b'
  const pulse = status === 'running' || status === 'awaiting_ai'
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${pulse ? 'animate-pulse' : ''}`}
      style={{ background: color }}
    />
  )
}

export default function HomeRecentActivities() {
  const visible = useJobsSelector(jobs => jobs.slice(0, 8), sameArrayItems)
  const sources = useSources()

  // Последние 8 — running выше, потом готовые по убыванию времени.
  // useJobs уже возвращает отсортированный список (последние сверху).
  if (visible.length === 0) return null

  return (
    <div className="mt-12">
      <div className="text-xs uppercase tracking-wider text-zinc-500 mb-3">
        Последние действия
      </div>
      <div className="flex flex-col gap-1">
        {visible.map(job => {
          const platform = PLATFORM_BY_TYPE[job.type] || null
          const typeLabel = TYPE_LABEL[job.type] || job.type
          const isActive = job.status === 'running' || job.status === 'awaiting_ai'
          const ts = job.finished_at || job.started_at || 0
          const ago = isActive ? '' : humanAgo(Math.max(0, Math.floor(Date.now() / 1000) - ts))
          const title = (job.entity_title || job.target || '').toString()
          const truncated = title.length > 80 ? title.slice(0, 80) + '…' : title

          // Куда вести по клику. Для running — JobDetail; для done с
          // source_id — SourceDetail (мы привязаны к источнику в Library).
          // Для done без source_id (single-paste) — JobDetail (там видно
          // путь к транскрипту и copy-кнопка).
          const matchedSource = job.source_id ? sources.find(s => s.id === job.source_id) : null
          const onClick = () => {
            if (matchedSource) {
              pushScreen('source-detail', { sourceId: matchedSource.id })
            } else {
              pushScreen('job-detail', { jobId: job.id, job })
            }
          }

          return (
            <button
              key={job.id}
              onClick={onClick}
              className="group flex items-center gap-2.5 py-1.5 px-2 -mx-2 rounded hover:bg-zinc-900 text-left transition-colors"
            >
              <StatusDot status={isActive ? 'running' : job.status} />
              {platform && <PlatformLogo platform={platform} size={12} />}
              <span className="text-zinc-500 text-xs shrink-0">{typeLabel}</span>
              <span className="text-zinc-300 text-sm truncate flex-1" title={title}>
                {truncated || '—'}
              </span>
              {isActive ? (
                <span className="text-emerald-400 text-xs shrink-0">⏳</span>
              ) : (
                <span className="text-zinc-600 text-xs shrink-0">{ago}</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
