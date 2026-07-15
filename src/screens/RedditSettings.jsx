import React from 'react'
import RedditBackendControl from '../components/RedditBackendControl'
import { useAppSettingsSection } from '../lib/appSettings'

export default function RedditSettings() {
  const state = useAppSettingsSection('reddit')
  if (state.loading && !state.value) {
    return <div className="text-zinc-500 italic text-sm py-4">Загрузка настроек Reddit…</div>
  }
  const backend = ['api', 'auto', 'apify'].includes(state.value?.backend)
    ? state.value.backend
    : 'api'
  return (
    <section>
      <h2 className="text-zinc-200 font-medium mb-3">Получение данных</h2>
      <div className="rounded-md border border-zinc-800 bg-zinc-950 p-4">
        <div className="text-zinc-500 text-sm mb-4">
          Этот способ будет выбран по умолчанию в поиске и при загрузке треда.
        </div>
        <div className="max-w-xl">
          <RedditBackendControl value={backend} onChange={value => state.patch({ backend: value })} disabled={state.saving} />
        </div>
        {state.error && <div className="text-red-300 text-sm mt-3">{state.error}</div>}
      </div>
    </section>
  )
}
