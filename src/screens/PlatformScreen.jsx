import React from 'react'
import { ChevronRight, Settings } from 'lucide-react'
import PlatformLogo from '../components/PlatformLogo'
import { openSettings, pushScreen } from '../lib/store'
import { useSources, useSourcesLoaded } from '../lib/sources'

const PLATFORM_META = {
  youtube:   { label: 'YouTube', settings: true },
  instagram: { label: 'Instagram', settings: true },
  reddit:    { label: 'Reddit', settings: true },
  tiktok:    { label: 'TikTok', settings: true },
  twitter:   { label: 'X', settings: true },
}

export default function PlatformScreen({ platform }) {
  const meta = PLATFORM_META[platform] || { label: platform, settings: false }
  const sources = useSources(platform)
  const loaded = useSourcesLoaded()

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-4xl mx-auto px-8 pt-8 pb-12">
        <div className="flex items-center gap-3 mb-7">
          <PlatformLogo platform={platform} size={24} />
          <h1 className="text-2xl font-semibold text-zinc-100">{meta.label}</h1>
          <span className="text-zinc-600 text-sm tabular-nums">{loaded ? sources.length : ''}</span>
          {meta.settings && (
            <button
              type="button"
              onClick={() => openSettings(platform)}
              title={`Настройки ${meta.label}`}
              className="ml-auto p-2 rounded-md text-zinc-500 hover:text-zinc-100 hover:bg-zinc-900"
            ><Settings size={18} /></button>
          )}
        </div>

        <div className="text-sm text-zinc-500 mb-3">Источники</div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 divide-y divide-zinc-900 overflow-hidden">
          {!loaded && <Empty text="Загрузка источников…" />}
          {loaded && sources.length === 0 && <Empty text={`Источников ${meta.label} пока нет`} />}
          {sources.map(source => (
            <button
              key={source.id}
              type="button"
              data-platform-source={source.id}
              aria-label={`Открыть источник ${sourceTitle(source)}`}
              onClick={() => pushScreen('source-detail', { sourceId: source.id, platform })}
              className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-zinc-900 group"
            >
              <PlatformLogo platform={platform} size={18} className="shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-zinc-200 truncate">{sourceTitle(source)}</div>
                {sourceSubtitle(source) && (
                  <div className="text-zinc-600 text-sm truncate mt-0.5">{sourceSubtitle(source)}</div>
                )}
              </div>
              <span className="text-zinc-600 text-sm tabular-nums shrink-0">
                {Number(source.items_count || 0).toLocaleString('ru-RU')}
              </span>
              <ChevronRight size={16} className="text-zinc-700 group-hover:text-zinc-400 shrink-0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Empty({ text }) {
  return <div className="px-4 py-5 text-zinc-500 italic text-sm">{text}</div>
}

function sourceTitle(source) {
  if (source.display_name && source.display_name !== source.handle) return source.display_name
  if (source.handle) return source.handle.startsWith('@') ? source.handle : `@${source.handle}`
  return source.external_id || `Источник #${source.id}`
}

function sourceSubtitle(source) {
  if (source.display_name && source.handle && source.display_name !== source.handle) {
    return source.handle.startsWith('@') ? source.handle : `@${source.handle}`
  }
  return source.url || null
}
