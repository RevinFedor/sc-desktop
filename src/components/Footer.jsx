import React from 'react'
import { useSources } from '../lib/sources'

export default function Footer() {
  const sources = useSources()
  const totalItems = sources.reduce((s, x) => s + (x.items_count || 0), 0)

  return (
    <div className="h-7 border-t border-zinc-800 px-4 flex items-center text-xs text-zinc-500 gap-4 select-none">
      <span>
        Library: <span className="text-zinc-300">{sources.length}</span> sources
        · <span className="text-zinc-300">{totalItems.toLocaleString()}</span> items
      </span>
      <span className="text-zinc-700">·</span>
      <span className="text-zinc-600 truncate">~/Library/Application Support/sc-desktop</span>
      <div className="ml-auto flex items-center gap-3">
        <span className="text-zinc-600">v0.1.0</span>
      </div>
    </div>
  )
}
