import React from 'react'
import { AlertTriangle, CircleAlert, CheckCircle2, Info, X } from 'lucide-react'
import { useToasts, dismissToast } from '../lib/toast'

// Single mounted host for the global toast stack. Lives once in App.jsx,
// fixed top-right just below the 40px titlebar. Every toast shares the same
// geometry (height, radius, ✕ position, left icon as a diff-marker, ellipsis
// for long text) — only icon + border-color vary by type. This is the
// «Единая форма» rule from methodology/переносимый-дизайн.md.

const VARIANTS = {
  error:   { icon: CircleAlert,    border: 'border-red-700/70',     iconCls: 'text-red-400' },
  warning: { icon: AlertTriangle,  border: 'border-amber-700/70',   iconCls: 'text-amber-400' },
  success: { icon: CheckCircle2,   border: 'border-emerald-700/70', iconCls: 'text-emerald-400' },
  info:    { icon: Info,           border: 'border-zinc-600',       iconCls: 'text-zinc-300' },
}

export default function ToastHost() {
  const toasts = useToasts()
  if (!toasts.length) return null

  return (
    <div
      className="fixed right-4 z-[100] flex flex-col gap-2 w-[360px] max-w-[calc(100vw-2rem)] pointer-events-none"
      style={{ top: 'calc(env(titlebar-area-height, 40px) + 12px)' }}
    >
      {toasts.map(t => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  )
}

function ToastRow({ toast }) {
  const v = VARIANTS[toast.type] || VARIANTS.info
  const Icon = v.icon
  return (
    <div
      className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border ${v.border}
                  bg-zinc-900/95 backdrop-blur-sm shadow-2xl px-3 py-2.5 animate-toast-in`}
    >
      <Icon size={16} className={`shrink-0 mt-0.5 ${v.iconCls}`} />
      <div className="flex-1 min-w-0">
        {/* Long messages wrap up to 3 lines then ellipsis — never grow the
            card taller arbitrarily (Единая форма). */}
        <div
          className="text-zinc-100 leading-snug"
          style={{
            fontSize: '14px',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {toast.message}
        </div>
        {toast.actionLabel && (
          <button
            type="button"
            onClick={() => {
              if (toast.onAction) toast.onAction()
              dismissToast(toast.id)
            }}
            className="mt-1.5 text-zinc-300 hover:text-white underline decoration-zinc-600 hover:decoration-zinc-300"
            style={{ fontSize: '13px' }}
          >
            {toast.actionLabel}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        title="Скрыть"
        className="shrink-0 text-zinc-500 hover:text-zinc-200 -mr-0.5 -mt-0.5"
      >
        <X size={15} />
      </button>
    </div>
  )
}
