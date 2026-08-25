// Production file logger.
// Same contract as custom-terminal: intercepts console.log/error/warn,
// writes only [Tag]-prefixed lines (errors always), deduplicates repeats.
//
//   Dev:   <project root>/logs/dev.log
//   Prod:  app.getPath('logs')/production.log   (~/Library/Logs/SC Desktop/...)

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const isDev = !app.isPackaged
const TAG_RE = /^\[/

function init() {
  const LOG_DIR = process.env.SC_DESKTOP_LOG_DIR
    ? path.resolve(process.env.SC_DESKTOP_LOG_DIR)
    : isDev
      ? path.join(__dirname, '..', 'logs')
      : path.join(app.getPath('logs'))

  try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch {}

  const LOG_PATH = path.join(LOG_DIR, isDev ? 'dev.log' : 'production.log')

  // Rotate when older than 7 days. No size cap (sessions can be long).
  try {
    if (fs.existsSync(LOG_PATH)) {
      const stat = fs.statSync(LOG_PATH)
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24)
      if (ageDays > 7) {
        try { fs.renameSync(LOG_PATH, LOG_PATH + '.old') } catch {}
      }
    }
  } catch {}

  let stream = null
  try {
    stream = fs.createWriteStream(LOG_PATH, { flags: 'a' })
    stream.on('error', () => { stream = null })
    stream.write(`\n--- Session ${new Date().toISOString()} (PID ${process.pid}) ---\n`)
  } catch {}

  let lastLine = ''
  let dedupCount = 0

  function writeLine(line) {
    if (!stream) return
    if (line === lastLine) {
      dedupCount++
      return
    }
    if (dedupCount > 0) {
      stream.write(`  ×${dedupCount + 1}\n`)
      dedupCount = 0
    }
    lastLine = line
    const ts = new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
    stream.write(`${ts} ${line}\n`)
  }

  const argsToString = (args) =>
    args
      .map(a => {
        if (typeof a === 'string') return a
        if (a instanceof Error) return a.stack || a.message
        try { return JSON.stringify(a) } catch { return String(a) }
      })
      .join(' ')

  const origLog   = console.log
  const origError = console.error
  const origWarn  = console.warn

  console.log = (...args) => {
    origLog.apply(console, args)
    const msg = argsToString(args)
    if (TAG_RE.test(msg)) writeLine(msg)
  }
  console.error = (...args) => {
    origError.apply(console, args)
    const msg = argsToString(args)
    writeLine(msg.startsWith('[') ? msg : `[ERROR] ${msg}`)
  }
  console.warn = (...args) => {
    origWarn.apply(console, args)
    const msg = argsToString(args)
    if (TAG_RE.test(msg)) writeLine(msg)
  }

  process.on('exit', () => {
    if (dedupCount > 0 && stream) stream.write(`  ×${dedupCount + 1}\n`)
    if (stream) stream.end()
  })

  // Capture stray crashes too.
  process.on('uncaughtException',  (err)  => console.error('[uncaughtException]', err))
  process.on('unhandledRejection', (err)  => console.error('[unhandledRejection]', err))

  return { logPath: LOG_PATH }
}

module.exports = { init }
