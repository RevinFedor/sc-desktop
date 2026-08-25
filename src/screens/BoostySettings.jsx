import React, { useEffect, useState } from 'react'
import { FolderOpen, RotateCcw } from 'lucide-react'
import Checkbox from '../components/Checkbox'
import { useAppSettingsSection } from '../lib/appSettings'

export default function BoostySettings() {
  const state = useAppSettingsSection('boosty')
  const [resolved, setResolved] = useState(null)

  async function reloadResolved() {
    if (!window.api?.boostyStorageConfig) return
    try { setResolved(await window.api.boostyStorageConfig()) } catch {}
  }

  useEffect(() => { reloadResolved() }, [state.value?.audio_dir, state.value?.video_dir])

  if (state.loading && !state.value) {
    return <div className="text-zinc-500 italic text-sm py-4">Загрузка настроек Boosty…</div>
  }

  const settings = {
    audio_dir: state.value?.audio_dir || '',
    video_dir: state.value?.video_dir || '',
    save_video: !!state.value?.save_video,
  }

  async function choose(kind) {
    const current = kind === 'audio' ? resolved?.audio_dir : resolved?.video_dir
    const result = await window.api?.storageChooseDirectory?.({
      title: kind === 'audio' ? 'Папка для аудио Boosty' : 'Папка для видео Boosty',
      default_path: current,
    })
    if (result?.path) await state.patch({ [`${kind}_dir`]: result.path })
  }

  async function reset(kind) {
    await state.patch({ [`${kind}_dir`]: '' })
  }

  return (
    <div>
      {(state.saving || state.error) && (
        <div className={`mb-4 text-sm ${state.error ? 'text-red-300' : 'text-zinc-500'}`}>
          {state.error || 'Сохраняю…'}
        </div>
      )}

      <section className="mb-8">
        <h2 className="text-zinc-200 font-medium mb-3">Хранилище</h2>
        <div className="rounded-md border border-zinc-800 bg-zinc-950 divide-y divide-zinc-900">
          <PathRow
            label="Аудио MP3"
            hint="Для массовой расшифровки скачивается только дорожка 96 Кбит/с. Транскрипты остаются в общей библиотеке SC Desktop."
            value={settings.audio_dir}
            resolvedPath={resolved?.audio_dir}
            disk={resolved?.audio_disk}
            onChange={value => state.setValue(prev => ({ ...(prev || {}), audio_dir: value }))}
            onBlur={() => state.patch({ audio_dir: state.value?.audio_dir || '' })}
            onChoose={() => choose('audio')}
            onReset={() => reset('audio')}
          />
          <PathRow
            label="Полные видео"
            hint="Используется только при включённой архивации видео; основной поток аудио работает быстрее и не зависит от этой папки."
            value={settings.video_dir}
            resolvedPath={resolved?.video_dir}
            disk={resolved?.video_disk}
            onChange={value => state.setValue(prev => ({ ...(prev || {}), video_dir: value }))}
            onBlur={() => state.patch({ video_dir: state.value?.video_dir || '' })}
            onChoose={() => choose('video')}
            onReset={() => reset('video')}
          />
        </div>
      </section>

      <section>
        <h2 className="text-zinc-200 font-medium mb-3">Архивация</h2>
        <div className="rounded-md border border-zinc-800 bg-zinc-950 px-4 py-3">
          <Checkbox
            checked={settings.save_video}
            onChange={value => state.patch({ save_video: value })}
            label="Сохранять полное видео вместе с аудио"
          />
          <div className="text-zinc-500 text-xs mt-2 ml-7">
            Выключено по умолчанию: полный видеоархив обычно требует в десятки раз больше места и времени, чем MP3.
          </div>
        </div>
      </section>
    </div>
  )
}

function PathRow({ label, hint, value, resolvedPath, disk, onChange, onBlur, onChoose, onReset }) {
  const custom = !!value.trim()
  return (
    <div className="px-4 py-4">
      <div className="text-zinc-200 text-sm">{label}</div>
      <div className="text-zinc-500 text-xs mt-1">{hint}</div>
      <div className="mt-3 flex items-center gap-2">
        <input
          value={value}
          onChange={event => onChange(event.target.value)}
          onBlur={onBlur}
          placeholder={resolvedPath || 'Папка по умолчанию'}
          className="h-9 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-zinc-200 text-sm outline-none focus:border-zinc-600"
        />
        <button type="button" onClick={onChoose} className="h-9 px-3 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-2">
          <FolderOpen size={14} /> Выбрать
        </button>
        {custom && (
          <button type="button" onClick={onReset} title="Вернуть папку SC Desktop" className="h-9 w-9 rounded-md border border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 inline-flex items-center justify-center">
            <RotateCcw size={14} />
          </button>
        )}
      </div>
      <div className="text-zinc-600 text-xs mt-2 flex flex-wrap gap-x-3">
        <span className="truncate">{resolvedPath || '—'}</span>
        {disk?.free_bytes != null && <span className="shrink-0">свободно {fmtSize(disk.free_bytes)}</span>}
      </div>
    </div>
  )
}

function fmtSize(value) {
  const n = Number(value || 0)
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} КБ`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`
  return `${(n / 1024 ** 3).toFixed(1)} ГБ`
}
