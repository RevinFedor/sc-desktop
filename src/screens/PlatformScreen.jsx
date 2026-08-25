import React, { useCallback, useEffect, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { ChevronRight, FolderOpen, Settings, Trash2 } from 'lucide-react'
import PlatformLogo from '../components/PlatformLogo'
import { openSettings, pushScreen } from '../lib/store'
import { useSources, useSourcesLoaded } from '../lib/sources'

const PLATFORM_META = {
  youtube:   { label: 'YouTube', settings: true },
  boosty:    { label: 'Boosty', settings: true },
  instagram: { label: 'Instagram', settings: true },
  reddit:    { label: 'Reddit', settings: true },
  tiktok:    { label: 'TikTok', settings: true },
  twitter:   { label: 'X', settings: true },
}

export default function PlatformScreen({ platform }) {
  const meta = PLATFORM_META[platform] || { label: platform, settings: false }
  const sources = useSources(platform)
  const loaded = useSourcesLoaded()
  const [boostyStorage, setBoostyStorage] = useState(null)
  const [storageBusy, setStorageBusy] = useState(false)

  const reloadBoostyStorage = useCallback(async () => {
    if (platform !== 'boosty' || !window.api?.boostyPlatformStorage) return
    try {
      const result = await window.api.boostyPlatformStorage()
      if (result?.ok) setBoostyStorage(result)
    } catch {}
  }, [platform])

  useEffect(() => {
    if (loaded) reloadBoostyStorage()
  }, [loaded, sources.length, reloadBoostyStorage])

  async function deleteAllBoostyAudio() {
    const bytes = Number(boostyStorage?.audio?.bytes || 0)
    const files = Number(boostyStorage?.audio?.present || 0)
    if (!bytes || !files || storageBusy) return
    if (!window.confirm(
      `Удалить всё локальное аудио Boosty (${files} файлов, ${fmtSize(bytes)})?\n\n` +
      'Посты, обложки, метаданные, расшифровки и SRT останутся. Аудио можно скачать заново.'
    )) return
    setStorageBusy(true)
    try {
      const result = await window.api?.boostyDeletePlatformAudio?.()
      await reloadBoostyStorage()
      if (!result?.ok) window.alert(result?.error || 'Часть аудиофайлов удалить не удалось')
    } finally {
      setStorageBusy(false)
    }
  }

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

        {platform === 'boosty' && boostyStorage && (
          <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className="text-zinc-500">На диске</span>
            <StorageMetric label="Аудио" bytes={boostyStorage.audio?.bytes} count={boostyStorage.audio?.present} />
            <StorageMetric label="Видео" bytes={boostyStorage.videos?.bytes} count={boostyStorage.videos?.present} />
            <StorageMetric label="Обложки" bytes={boostyStorage.thumbnails?.bytes} />
            <StorageMetric label="Расшифровки" bytes={boostyStorage.transcripts?.bytes} />
            {Number(boostyStorage.text?.bytes || 0) > 0 && <StorageMetric label="Текст" bytes={boostyStorage.text.bytes} />}
            {Number(boostyStorage.index?.bytes || 0) > 0 && <StorageMetric label="Индекс" bytes={boostyStorage.index.bytes} />}
            <span className="text-zinc-700">·</span>
            <span className="text-zinc-400">всего <span className="text-zinc-100 font-medium tabular-nums">{fmtSize(boostyStorage.total_bytes)}</span></span>
            {Number(boostyStorage.audio?.bytes || 0) > 0 && (
              <button
                type="button"
                onClick={deleteAllBoostyAudio}
                disabled={storageBusy}
                className="ml-auto h-8 px-2.5 rounded text-red-300 hover:bg-red-950/40 disabled:text-zinc-600 inline-flex items-center gap-1.5"
              >
                <Trash2 size={14} /> {storageBusy ? 'Удаляю…' : `Освободить ${fmtSize(boostyStorage.audio.bytes)}`}
              </button>
            )}
            <button
              type="button"
              onClick={() => window.api?.storageOpenRoot?.(boostyStorage.audio_root || boostyStorage.root)}
              title="Открыть папку аудио Boosty"
              className={`${Number(boostyStorage.audio?.bytes || 0) > 0 ? '' : 'ml-auto'} p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800`}
            ><FolderOpen size={15} /></button>
          </div>
        )}

        <div className="text-sm text-zinc-500 mb-3">Источники</div>
        <div
          data-platform-source-list
          className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden"
          style={{ height: loaded && sources.length ? Math.min(640, Math.max(72, sources.length * 64)) : 'auto' }}
        >
          {!loaded && <Empty text="Загрузка источников…" />}
          {loaded && sources.length === 0 && <Empty text={`Источников ${meta.label} пока нет`} />}
          {loaded && sources.length > 0 && (
            <Virtuoso
              data={sources}
              defaultItemHeight={64}
              increaseViewportBy={160}
              computeItemKey={(_index, source) => source.id}
              itemContent={(_index, source) => (
                <button
                  type="button"
                  data-platform-source={source.id}
                  aria-label={`Открыть источник ${sourceTitle(source)}`}
                  onClick={() => pushScreen('source-detail', { sourceId: source.id, platform })}
                  className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-zinc-900 group border-b border-zinc-900 last:border-b-0"
                >
                  <PlatformLogo platform={platform} size={18} className="shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-zinc-200 truncate">{sourceTitle(source)}</div>
                    {sourceSubtitle(source) && (
                      <div className="text-zinc-600 text-sm truncate mt-0.5">{sourceSubtitle(source)}</div>
                    )}
                  </div>
                  {platform === 'boosty' ? (
                    <BoostySourceMetrics source={source} storage={boostyStorage?.per_source?.[String(source.id)]} />
                  ) : (
                    <span className="text-zinc-600 text-sm tabular-nums shrink-0">
                      {Number(source.items_count || 0).toLocaleString('ru-RU')}
                    </span>
                  )}
                  <ChevronRight size={16} className="text-zinc-700 group-hover:text-zinc-400 shrink-0" />
                </button>
              )}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function BoostySourceMetrics({ source, storage }) {
  return (
    <span className="text-zinc-600 text-sm tabular-nums shrink-0 text-right">
      <span className="block">
        <span className="text-zinc-400">{Number(source.items_count || 0).toLocaleString('ru-RU')} постов</span>
        <span className="mx-1.5">·</span>
        {Number(source.boosty_videos_count || 0).toLocaleString('ru-RU')} видео
        <span className="mx-1.5">·</span>
        {Number(source.boosty_transcribed_count || 0).toLocaleString('ru-RU')} готово
      </span>
      {Number(storage?.audio_bytes || 0) > 0 && (
        <span className="block text-xs text-zinc-500 mt-0.5">
          аудио {fmtSize(storage.audio_bytes)} · {Number(storage.audio_files || 0).toLocaleString('ru-RU')} файлов
        </span>
      )}
      {Number(storage?.video_bytes || 0) > 0 && (
        <span className="block text-xs text-zinc-500 mt-0.5">
          видео {fmtSize(storage.video_bytes)} · {Number(storage.video_files || 0).toLocaleString('ru-RU')} файлов
        </span>
      )}
    </span>
  )
}

function StorageMetric({ label, bytes = 0, count = null }) {
  return (
    <span className="text-zinc-400">
      {label} <span className="text-zinc-200 tabular-nums">{fmtSize(bytes)}</span>
      {count != null && Number(count) > 0 && <span className="text-zinc-600 tabular-nums"> · {Number(count).toLocaleString('ru-RU')}</span>}
    </span>
  )
}

function fmtSize(value) {
  const n = Number(value || 0)
  if (!n) return '0 Б'
  if (n < 1024) return `${n} Б`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} КБ`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`
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
