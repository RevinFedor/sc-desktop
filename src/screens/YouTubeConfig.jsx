import React from 'react'
import PlatformLogo from '../components/PlatformLogo'

export default function YouTubeConfig({ payload }) {
  const target = payload?.target || ''
  const kind = payload?.kind || 'video'
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 flex flex-col px-8 py-6">
        <div className="mb-6 flex items-center gap-3">
          <PlatformLogo platform="youtube" size={20} />
          <span className="text-xl font-semibold text-zinc-100">YouTube · {kind}</span>
          <span className="text-zinc-600 truncate max-w-md ml-2" title={target} style={{ fontSize: '14px' }}>{target}</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-zinc-500 text-center">
            YouTube screen coming next.<br/>
            <span className="text-xs text-zinc-600">Subs / AI / mp4 selector + channel filters.</span>
          </div>
        </div>
      </div>
    </div>
  )
}
