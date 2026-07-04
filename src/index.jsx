import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles/main.css'
import { installPerfDiagnostics } from './lib/perfDiagnostics'

installPerfDiagnostics()

// === code-inspector: Claude/Cursor-friendly clipboard formatter ===
// On Shift+Opt+click the plugin emits `code-inspector:trackCode` with
// detail = {name, path, line, column}. We additionally look up the DOM
// node via [data-insp-path=...] to include outerHTML in the paste.
window.addEventListener('code-inspector:trackCode', (e) => {
  try {
    const { name = '', path = '', line = '', column = '' } = e?.detail || {}
    const loc = path ? `${path}:${line}:${column}` : ''
    let html = ''
    if (loc) {
      const candidates = document.querySelectorAll(`[data-insp-path="${loc}"]`)
      const el = candidates[candidates.length - 1]
      if (el) {
        const clone = el.cloneNode(true)
        clone.querySelectorAll?.('[data-insp-path]').forEach(n => n.removeAttribute('data-insp-path'))
        clone.removeAttribute('data-insp-path')
        html = clone.outerHTML || ''
        if (html.length > 1200) html = html.slice(0, 1200) + '\n  ...(truncated)'
      }
    }
    const text = html ? `${html}\n\nin <${name}> at ${loc}` : `<${name}> at ${loc}`
    const electron = window.require?.('electron')
    if (electron?.clipboard?.writeText) electron.clipboard.writeText(text)
    else navigator.clipboard?.writeText?.(text)
  } catch (err) {
    console.error('[code-inspector] copy failed:', err?.message || err)
  }
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
