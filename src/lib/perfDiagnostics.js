let installed = false

const LOOP_INTERVAL_MS = 250
const LOOP_GAP_MS = 350
const LONG_TASK_MS = 80
const INPUT_DELAY_MS = 160
const DATA_BUS_WINDOW_MS = 5000
const DATA_BUS_BURST_COUNT = 20

let dataBusWindow = resetDataBusWindow()
let dataBusTimer = null

function send(kind, payload = {}) {
  try {
    if (!window.api?.diagLog) return
    window.api.diagLog({
      kind,
      url: window.location?.hash || window.location?.pathname || '',
      visible: document.visibilityState,
      ...payload,
    })
  } catch {}
}

function clip(value, max = 160) {
  const s = String(value == null ? '' : value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function describeTarget(target) {
  try {
    const el = target?.nodeType === 1 ? target : target?.parentElement
    if (!el) return ''
    const tag = el.tagName ? el.tagName.toLowerCase() : ''
    const id = el.id ? `#${el.id}` : ''
    const cls = typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.')
      : ''
    const dataPath = el.getAttribute?.('data-insp-path')
    return clip(`${tag}${id}${cls}${dataPath ? ` path=${dataPath}` : ''}`, 180)
  } catch {
    return ''
  }
}

function eventDelayMs(event) {
  const now = performance.now()
  let delay = now - event.timeStamp
  if (!Number.isFinite(delay) || Math.abs(delay) > 60_000) {
    delay = Date.now() - event.timeStamp
  }
  return delay
}

function installLoopGapProbe() {
  let last = performance.now()
  let visible = document.visibilityState === 'visible'
  document.addEventListener('visibilitychange', () => {
    // Chromium aggressively throttles intervals while DevTools or another
    // page owns focus. Reset the baseline at the visibility boundary so the
    // first visible tick does not report hidden-time throttling as a UI stall.
    visible = document.visibilityState === 'visible'
    last = performance.now()
  })
  window.setInterval(() => {
    const now = performance.now()
    const gapMs = now - last - LOOP_INTERVAL_MS
    last = now
    if (!visible || document.visibilityState !== 'visible') return
    if (gapMs >= LOOP_GAP_MS) {
      send('RendererLoopGap', {
        gapMs,
        activeElement: describeTarget(document.activeElement),
      })
    }
  }, LOOP_INTERVAL_MS)
}

function installLongTaskProbe() {
  if (typeof PerformanceObserver !== 'function') return
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (document.visibilityState !== 'visible') continue
        if (entry.duration < LONG_TASK_MS) continue
        send('RendererLongTask', {
          durationMs: entry.duration,
          startMs: entry.startTime,
          name: entry.name || 'longtask',
        })
      }
    })
    obs.observe({ entryTypes: ['longtask'] })
  } catch {}
}

function installInputDelayProbe() {
  const lastByType = new Map()
  const handler = (event) => {
    const delay = eventDelayMs(event)
    if (delay < INPUT_DELAY_MS) return
    const now = performance.now()
    const prev = lastByType.get(event.type) || 0
    if (now - prev < 1000) return
    lastByType.set(event.type, now)
    send('InputDelay', {
      type: event.type,
      delayMs: delay,
      target: describeTarget(event.target),
    })
  }
  for (const type of ['pointerdown', 'click', 'keydown', 'wheel']) {
    window.addEventListener(type, handler, { capture: true, passive: true })
  }
}

function resetDataBusWindow() {
  return {
    started: Date.now(),
    count: 0,
    keys: new Map(),
    subscribers: new Map(),
  }
}

function bumpMap(map, key, n = 1) {
  const k = key == null ? 'none' : String(key)
  map.set(k, (map.get(k) || 0) + n)
}

function topMap(map, limit = 8) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => `${k}:${v}`)
    .join(',')
}

function flushDataBusWindow(reason = 'timer') {
  if (!dataBusWindow.count) {
    dataBusWindow = resetDataBusWindow()
    return
  }
  if (reason === 'threshold' || dataBusWindow.count >= DATA_BUS_BURST_COUNT) {
    send('DataBusBurst', {
      reason,
      count: dataBusWindow.count,
      elapsedMs: Date.now() - dataBusWindow.started,
      keys: topMap(dataBusWindow.keys),
      subscribers: topMap(dataBusWindow.subscribers),
    })
  }
  dataBusWindow = resetDataBusWindow()
}

function scheduleDataBusFlush() {
  if (dataBusTimer) return
  dataBusTimer = window.setTimeout(() => {
    dataBusTimer = null
    flushDataBusWindow('timer')
  }, DATA_BUS_WINDOW_MS)
}

export function noteDataBusInvalidation(key, subscriberCount = 0) {
  dataBusWindow.count += 1
  bumpMap(dataBusWindow.keys, key)
  bumpMap(dataBusWindow.subscribers, key, subscriberCount)
  scheduleDataBusFlush()
  if (dataBusWindow.count >= DATA_BUS_BURST_COUNT) {
    flushDataBusWindow('threshold')
    if (dataBusTimer) {
      window.clearTimeout(dataBusTimer)
      dataBusTimer = null
    }
  }
}

export function installPerfDiagnostics() {
  if (installed) return
  installed = true
  installLoopGapProbe()
  installLongTaskProbe()
  installInputDelayProbe()
  send('RendererDiagnosticsInstalled', {
    userAgent: navigator.userAgent,
  })
}
