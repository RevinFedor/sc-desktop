import React from 'react'
import PlatformLogo from '../components/PlatformLogo'
import Checkbox from '../components/Checkbox'
import { pushScreen } from '../lib/store'
import { SETTINGS_SECTIONS } from '../lib/settingsSections'
import { useAppSettingsSection } from '../lib/appSettings'
import TelegramSettings from './TelegramSettings'
import YouTubeSettings from './YouTubeSettings'
import BoostySettings from './BoostySettings'
import InstagramSettings from './InstagramSettings'
import RedditSettings from './RedditSettings'
import TikTokSettings from './TikTokSettings'
import TwitterSettings from './TwitterSettings'

const CONTENT = {
  main: MainSettings,
  telegram: TelegramSettings,
  youtube: YouTubeSettings,
  boosty: BoostySettings,
  instagram: InstagramSettings,
  reddit: RedditSettings,
  tiktok: TikTokSettings,
  twitter: TwitterSettings,
}

export default function SettingsScreen({ payload }) {
  const selected = CONTENT[payload?.section] ? payload.section : 'main'
  const Content = CONTENT[selected]

  return (
    <div className="h-full overflow-auto" style={{ scrollbarGutter: 'stable' }}>
      <div className="max-w-5xl mx-auto px-8 pt-5 pb-12">
        <nav
          aria-label="Разделы настроек"
          className="h-10 flex items-center gap-1 overflow-x-auto border-b border-zinc-800 mb-7"
        >
          {SETTINGS_SECTIONS.map(section => {
            const active = selected === section.id
            return (
              <button
                key={section.id}
                type="button"
                data-settings-section={section.id}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  if (!active) pushScreen('settings', { section: section.id })
                }}
                className={`h-9 px-3 rounded-t-md inline-flex items-center gap-2 whitespace-nowrap text-sm border-b-2 ${
                  active
                    ? 'bg-zinc-900 text-zinc-100 border-emerald-500'
                    : 'text-zinc-500 border-transparent hover:text-zinc-200 hover:bg-zinc-900/60'
                }`}
              >
                {section.platform && <PlatformLogo platform={section.platform} size={15} />}
                {section.label}
              </button>
            )
          })}
        </nav>

        <div className="max-w-3xl">
          <Content />
        </div>
      </div>
    </div>
  )
}

function MainSettings() {
  const state = useAppSettingsSection('main')
  if (state.loading && !state.value) {
    return <div className="text-zinc-500 italic text-sm py-4">Загрузка общих настроек…</div>
  }
  const autoClose = state.value?.external_research_auto_close === true

  return (
    <section>
      <h2 className="text-zinc-200 font-medium mb-3">Внешние AI-вкладки</h2>
      <div className="rounded-md border border-zinc-800 bg-zinc-950 px-4 py-4">
        <Checkbox
          checked={autoClose}
          disabled={state.saving}
          onChange={value => state.patch({ external_research_auto_close: value })}
          label="Автоматически закрывать вкладки после успешного завершения"
        />
        <div className="text-zinc-500 text-xs mt-2 ml-7">
          {autoClose
            ? 'Включено: успешные AI-вкладки закрываются после сохранения результата. Ошибки остаются для диагностики.'
            : 'Выключено: вкладка с результатом external research останется открытой.'}
        </div>
        {(state.saving || state.error) && (
          <div className={`text-sm mt-3 ${state.error ? 'text-red-300' : 'text-zinc-500'}`}>
            {state.error || 'Сохраняю…'}
          </div>
        )}
      </div>
    </section>
  )
}
