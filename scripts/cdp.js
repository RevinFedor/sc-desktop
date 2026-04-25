#!/usr/bin/env node
// Minimal CDP helper for SC Desktop. Uses the project's local `ws`.
//   node scripts/cdp.js eval '<JS>'         — Runtime.evaluate, awaitPromise
//   node scripts/cdp.js shot /tmp/sc.png    — Page.captureScreenshot (PNG)
//   node scripts/cdp.js targets             — list targets
const WebSocket = require('ws')
const fs = require('fs')

async function getList() {
  const r = await (await fetch('http://localhost:9222/json/list')).json()
  return r
}
async function getWsUrl() {
  const list = await getList()
  // SC Desktop renderer is the only HTML page; devtools targets and
  // service workers come back as type==='other' / 'service_worker'.
  const tab = list.find(t =>
    t.type === 'page'
      && !t.url.startsWith('devtools://')
      && !t.url.startsWith('chrome-extension://')
  )
  if (!tab) {
    throw new Error('No page target. Got: ' + JSON.stringify(
      list.map(t => ({ type: t.type, url: t.url, title: t.title })),
      null, 2,
    ))
  }
  return tab.webSocketDebuggerUrl
}
async function call(ws, method, params = {}) {
  return new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 100000)
    const handler = data => {
      const m = JSON.parse(data)
      if (m.id !== id) return
      ws.off('message', handler)
      if (m.error) rej(m.error)
      else res(m.result)
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function withWs(fn) {
  const url = await getWsUrl()
  const ws = new WebSocket(url)
  await new Promise(r => ws.once('open', r))
  try { return await fn(ws) } finally { ws.close() }
}

async function main() {
  const cmd = process.argv[2]
  const arg = process.argv[3]
  if (cmd === 'targets') {
    console.log(JSON.stringify(await getList(), null, 2))
    return
  }
  if (cmd === 'eval') {
    const r = await withWs(ws => call(ws, 'Runtime.evaluate', {
      expression: arg,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    }))
    if (r.exceptionDetails) {
      console.error(JSON.stringify({ error: r.exceptionDetails }, null, 2))
      process.exit(1)
    }
    const out = r.result?.value
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2))
    return
  }
  if (cmd === 'shot') {
    if (!arg) throw new Error('shot needs an output path')
    // Optional crop: shot path x y w h
    const clipArgs = process.argv.slice(4).map(Number)
    const params = { format: 'png' }
    if (clipArgs.length === 4 && clipArgs.every(Number.isFinite)) {
      params.clip = { x: clipArgs[0], y: clipArgs[1], width: clipArgs[2], height: clipArgs[3], scale: 1 }
    }
    const r = await withWs(ws => call(ws, 'Page.captureScreenshot', params))
    fs.writeFileSync(arg, Buffer.from(r.data, 'base64'))
    console.log(arg)
    return
  }
  console.error(`unknown command: ${cmd}`)
  process.exit(2)
}

main().catch(err => {
  console.error(err.message || err)
  process.exit(1)
})
