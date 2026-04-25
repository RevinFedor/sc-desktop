import React, { useState, useEffect, useImperativeHandle, forwardRef } from 'react'
import { pushScreen } from '../lib/store'
import { invalidate } from '../lib/dataBus'
import PlatformLogo from './PlatformLogo'

/**
 * Inline form mounted on PasteScreen when the user typed a free-text Telegram
 * folder name and clicked the [папка] chip. Walks `tgResolveFolder` once and:
 *   - exact match           → upserts folder + sources, pushScreen('telegram',
 *                              { folderId }), clears paste draft
 *   - multiple candidates   → renders picker; click resolves the chosen id
 *   - zero candidates       → "у вас нет именованных папок" hint
 *   - error                 → red row with retry
 *
 * Mirrors TelegramSingleMessageForm in spirit: auto-fires on mount (no extra
 * Submit button), result is one-click — folder kind has no parameters to
 * configure at this point. Period and chat selection happen on TelegramScreen
 * itself.
 */
export default forwardRef(function TelegramFolderForm({ name, onStarted }, ref) {
  const [stage, setStage] = useState('resolving')   // resolving | picker | error | done
  const [candidates, setCandidates] = useState([])
  const [error, setError] = useState(null)

  useImperativeHandle(ref, () => ({
    trigger() { /* no-op — auto-fires on mount */ },
  }))

  useEffect(() => {
    let cancelled = false
    if (!name) {
      setStage('error')
      setError('Не указано имя папки')
      return
    }
    ;(async () => {
      try {
        const res = await window.api.tgResolveFolder({ name })
        if (cancelled) return
        if (!res?.ok) {
          setStage('error')
          setError(res?.error || 'Не удалось получить список папок')
          return
        }
        if (res.folder) {
          // Single hit — done.
          invalidate('folders')
          invalidate('sources')
          setStage('done')
          if (onStarted) onStarted()
          pushScreen('telegram', { folderId: res.folder.id })
          return
        }
        // No exact match — show picker (or hint when list is empty).
        setCandidates(res.candidates || [])
        setStage('picker')
      } catch (err) {
        if (!cancelled) {
          setStage('error')
          setError(String(err && err.message || err))
        }
      }
    })()
    return () => { cancelled = true }
  }, [name])

  async function pickCandidate(c) {
    setStage('resolving')
    setError(null)
    try {
      const res = await window.api.tgResolveFolder({ filterId: c.filter_id })
      if (!res?.ok || !res.folder) {
        setStage('error')
        setError(res?.error || 'Не удалось загрузить папку')
        return
      }
      invalidate('folders')
      invalidate('sources')
      setStage('done')
      if (onStarted) onStarted()
      pushScreen('telegram', { folderId: res.folder.id })
    } catch (err) {
      setStage('error')
      setError(String(err && err.message || err))
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
      <div className="flex items-center gap-2 mb-4">
        <PlatformLogo platform="telegram" size={16} />
        <span className="text-zinc-200 font-medium">Telegram-папка</span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400 truncate">{name}</span>
      </div>

      {stage === 'resolving' && (
        <div className="text-zinc-400" style={{ fontSize: '14px' }}>
          ищу папку «{name}» среди ваших Telegram-папок…
        </div>
      )}

      {stage === 'picker' && candidates.length > 0 && (
        <div>
          <div className="text-zinc-400 mb-3" style={{ fontSize: '14px' }}>
            Точного совпадения не нашлось — выберите подходящую папку:
          </div>
          <ul className="border border-zinc-800 rounded-md">
            {candidates.map(c => (
              <li key={c.filter_id} className="border-b border-zinc-900 last:border-b-0">
                <button
                  onClick={() => pickCandidate(c)}
                  className="w-full px-3 py-2 flex items-center gap-3 hover:bg-zinc-900 text-left"
                  style={{ fontSize: '14px' }}
                >
                  <span className="text-zinc-200 truncate flex-1">{c.title}</span>
                  <span className="text-zinc-500 text-xs">{c.include_count} чатов</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {stage === 'picker' && candidates.length === 0 && (
        <div className="text-zinc-500" style={{ fontSize: '14px' }}>
          В вашем Telegram-аккаунте нет именованных папок. Создай папку прямо в клиенте Telegram, потом возвращайся.
        </div>
      )}

      {stage === 'error' && (
        <div className="text-red-300" style={{ fontSize: '14px' }}>
          {error || 'Ошибка'}
        </div>
      )}
    </div>
  )
})
