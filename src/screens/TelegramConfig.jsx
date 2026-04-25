import React from 'react'
import { goHome } from '../lib/store'
import PlatformLogo from '../components/PlatformLogo'
import TelegramConfigForm from '../components/TelegramConfigForm'

export default function TelegramConfig({ payload }) {
  const target = payload?.target || '@channel'

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto px-8 py-6">
        <div className="max-w-3xl mx-auto">
          <div className="mb-6 flex items-center gap-3">
            <PlatformLogo platform="telegram" size={20} />
            <span className="text-xl font-semibold text-zinc-100">Custom fetch</span>
            <span className="text-zinc-700">·</span>
            <span className="text-zinc-400">{target}</span>
          </div>
          <TelegramConfigForm
            target={target}
            onStarted={() => goHome()}
          />
        </div>
      </div>
    </div>
  )
}
