import { useCallback, useEffect, useRef, useState } from 'react'

function sectionFromResponse(response, section) {
  if (!response || typeof response !== 'object') return null
  if (response[section] && typeof response[section] === 'object') return response[section]
  if (response.settings && typeof response.settings === 'object') {
    return response.settings[section] || response.settings
  }
  if (response.ok === true && Object.keys(response).length === 1) return null
  return response
}

/** Shared settings.json section with optimistic, single-field patching. */
export function useAppSettingsSection(section) {
  const [value, setValue] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const requestSeq = useRef(0)

  const reload = useCallback(async () => {
    if (!window.api?.appSettingsGet) {
      setError('Настройки приложения недоступны')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await window.api.appSettingsGet()
      setValue(sectionFromResponse(response, section) || {})
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setLoading(false)
    }
  }, [section])

  useEffect(() => { reload() }, [reload])

  const patch = useCallback(async (nextPatch) => {
    if (!nextPatch || typeof nextPatch !== 'object') return null
    if (!window.api?.appSettingsPatch) {
      setError('Сохранение настроек недоступно')
      return null
    }
    const seq = ++requestSeq.current
    setValue(prev => ({ ...(prev || {}), ...nextPatch }))
    setSaving(true)
    setError(null)
    try {
      const response = await window.api.appSettingsPatch({ section, patch: nextPatch })
      const saved = sectionFromResponse(response, section)
      if (seq === requestSeq.current && saved) {
        setValue(prev => ({ ...(prev || {}), ...saved }))
      }
      return saved
    } catch (err) {
      if (seq === requestSeq.current) {
        const saveError = String(err?.message || err)
        await reload()
        if (seq === requestSeq.current) setError(saveError)
      }
      return null
    } finally {
      if (seq === requestSeq.current) setSaving(false)
    }
  }, [reload, section])

  return { value, setValue, loading, saving, error, reload, patch }
}
