import React, { useEffect, useRef } from 'react'
import { useJobs } from '../lib/jobs'
import { isActiveRequestJob, isVisibleRequestJob, RequestJobRow } from './ActivityPanel'

export default function RequestsRunningPopover({ open, onClose, anchorRef }) {
  const jobs = useJobs()
  const active = jobs.filter(j => isVisibleRequestJob(j) && isActiveRequestJob(j))
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e) {
      const t = e.target
      if (ref.current && ref.current.contains(t)) return
      if (anchorRef?.current && anchorRef.current.contains(t)) return
      onClose()
    }
    const id = setTimeout(() => {
      document.addEventListener('mousedown', onDocMouseDown)
    }, 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', onDocMouseDown)
    }
  }, [open, onClose, anchorRef])

  if (!open) return null

  return (
    <div
      ref={ref}
      className="no-drag absolute top-10 right-2 w-[390px] max-h-[60vh] overflow-auto z-50 bg-zinc-950 border border-zinc-700 rounded-lg shadow-2xl py-2"
    >
      {active.length === 0 ? (
        <div className="px-4 py-5 text-zinc-500 text-sm text-center">
          Нет активных запросов.
        </div>
      ) : (
        <div className="px-2 space-y-2">
          {active.map(j => (
            <RequestJobRow
              key={j.id}
              job={j}
              active
              onClose={onClose}
            />
          ))}
        </div>
      )}
    </div>
  )
}
