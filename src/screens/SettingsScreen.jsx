import React from 'react'
import PlatformLogo from '../components/PlatformLogo'
import { pushScreen } from '../lib/store'
import { SETTINGS_SECTIONS } from '../lib/settingsSections'
import TelegramSettings from './TelegramSettings'
import YouTubeSettings from './YouTubeSettings'
import InstagramSettings from './InstagramSettings'
import RedditSettings from './RedditSettings'
import TikTokSettings from './TikTokSettings'
import TwitterSettings from './TwitterSettings'

const CONTENT = {
  main: MainSettings,
  telegram: TelegramSettings,
  youtube: YouTubeSettings,
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
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 px-5 py-4">
      <div className="text-zinc-200 text-sm font-medium">Общих параметров пока нет</div>
      <div className="text-zinc-500 text-sm mt-1">
        Настройки, которые реально влияют на работу, находятся в разделах приложений.
      </div>
    </div>
  )
}
