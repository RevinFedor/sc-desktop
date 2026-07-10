#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import {
  TBankApiError,
  TBankPersonalClient,
  assertInsideAppRoot,
  defaultExportDir,
  defaultSessionFile,
  inferAccountsFromOperations,
  loadSession,
  normalizeAccount,
  normalizeOperation,
  saveSession,
  summarizeOperations,
} from './client.mjs'

const usage = `
Usage:
  node scripts/tbank-personal/cli.mjs save-session --sessionid <psid>
  node scripts/tbank-personal/cli.mjs browser-probe [--days 7]
  node scripts/tbank-personal/cli.mjs ping
  node scripts/tbank-personal/cli.mjs accounts [--browser] [--days 90] [--raw]
  node scripts/tbank-personal/cli.mjs operations --browser --from YYYY-MM-DD [--to YYYY-MM-DD] [--account <id>] [--raw]
  node scripts/tbank-personal/cli.mjs operations --account <id> --from YYYY-MM-DD [--to YYYY-MM-DD] [--raw]
  node scripts/tbank-personal/cli.mjs summary [--browser] [--account <id|all>] [--days 30] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  node scripts/tbank-personal/cli.mjs export [--browser] [--account <id|all>] [--days 30] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  node scripts/tbank-personal/cli.mjs receipt --operation <id> [--account <id>] [--operation-time ISO]

Session:
  --browser reads the current T-Bank cookies from the local browser MCP bridge
  and keeps them in memory only. Legacy psid mode reads TBANK_SESSION_ID/TBANK_PSID, then:
  ${defaultSessionFile()}

Notes:
  This prototype uses only read endpoints and never stores phone/password.
  For personal accounts in July 2026, --browser is the working path.
`.trim()

function parseArgs(argv) {
  const out = { command: null, options: {}, positionals: [] }
  const args = [...argv]
  out.command = args.shift() || 'help'

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) {
      out.positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      out.options[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = args[i + 1]
    if (!next || next.startsWith('--')) {
      out.options[key] = true
      continue
    }
    out.options[key] = next
    i += 1
  }

  return out
}

function json(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function dateFromDays(days) {
  return new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000)
}

function sendBrowserCommand(command, options = {}) {
  const bridgeUrl = options['bridge-url'] || process.env.SC_BROWSER_MCP_WS || 'ws://127.0.0.1:3458'
  const timeoutMs = Number(options['bridge-timeout'] || 20000)
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(bridgeUrl)
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error(`Browser MCP bridge timed out: ${bridgeUrl}`))
    }, timeoutMs)

    ws.on('open', () => {
      ws.send(JSON.stringify({ commandId: 1, ...command }))
    })
    ws.on('message', raw => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(raw.toString()))
      } catch (err) {
        reject(err)
      } finally {
        try { ws.close() } catch {}
      }
    })
    ws.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function loadBrowserCookies(options = {}) {
  const result = await sendBrowserCommand({
    action: 'mcp_get_cookies',
    domain: 'tbank.ru',
  }, options)
  if (!result.success) {
    throw new Error(result.error || 'Browser MCP cookie read failed')
  }
  const cookies = result.cookies || []
  const hasSession = cookies.some(cookie =>
    ['sso_api_session', 'navi_token', 'api_sso_id', 'ssoId'].includes(cookie.name)
  )
  if (!hasSession) {
    throw new Error('No active T-Bank browser session cookies found. Open T-Bank in the same browser profile and log in first.')
  }
  return cookies
}

async function clientFromSession(options) {
  if (options.browser || options['browser-cookies']) {
    const cookieJar = await loadBrowserCookies(options)
    return {
      client: new TBankPersonalClient({ cookieJar }),
      sessionSource: 'browser-mcp',
    }
  }

  const session = await loadSession({ sessionFile: options['session-file'] })
  if (!session) {
    throw new Error(
      'No T-Bank psid session found. For personal accounts use --browser after logging in to T-Bank in the browser.'
    )
  }
  return {
    client: new TBankPersonalClient({ sessionId: session.sessionId }),
    sessionSource: session.source,
  }
}

function rangeFromOptions(options) {
  const days = Number(options.days || 30)
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number')
  return {
    from: options.from || dateFromDays(days),
    to: options.to || new Date(),
  }
}

async function loadAccounts(client, options) {
  if (client.usesBrowserCookies) {
    const range = rangeFromOptions({ ...options, days: options.days || 90 })
    const operations = await client.operations({
      account: options.account || 'all',
      from: range.from,
      to: range.to,
    })
    return inferAccountsFromOperations(operations)
  }

  const accounts = await client.accounts()
  if (options.account && options.account !== 'all') {
    return accounts.filter(account => account.id === options.account)
  }
  return accounts
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))

  if (command === 'help' || command === '--help' || options.help) {
    process.stdout.write(`${usage}\n`)
    return
  }

  if (command === 'save-session') {
    const sessionId = options.sessionid || options.psid || process.env.TBANK_SESSION_ID || process.env.TBANK_PSID
    if (!sessionId) throw new Error('save-session requires --sessionid <psid>')
    const sessionFile = await saveSession(sessionId, {
      sessionFile: options['session-file'],
      source: 'manual-psid',
    })
    json({ ok: true, sessionFile })
    return
  }

  if (command === 'browser-probe') {
    options.browser = true
  }

  const { client, sessionSource } = await clientFromSession(options)

  if (command === 'browser-probe') {
    const range = rangeFromOptions(options)
    const operations = await client.operations({
      account: options.account || 'all',
      from: range.from,
      to: range.to,
    })
    json({
      ok: true,
      sessionSource,
      from: new Date(range.from).toISOString(),
      to: new Date(range.to).toISOString(),
      operations: operations.length,
      accounts: inferAccountsFromOperations(operations).length,
      firstOperationKeys: operations[0] ? Object.keys(operations[0]).slice(0, 40) : [],
    })
    return
  }

  if (command === 'ping') {
    json({ ok: true, sessionSource, payload: await client.ping() })
    return
  }

  if (command === 'accounts') {
    const accounts = await loadAccounts(client, options)
    json(options.raw ? accounts : accounts.map(normalizeAccount))
    return
  }

  if (command === 'operations') {
    if (!client.usesBrowserCookies && !options.account) throw new Error('operations requires --account <id> in psid mode')
    const payload = await client.operations({
      account: options.account || 'all',
      from: options.from,
      to: options.to,
    })
    json(options.raw ? payload : payload.map(normalizeOperation))
    return
  }

  if (command === 'summary') {
    const range = rangeFromOptions(options)
    const accounts = await loadAccounts(client, options)
    const groups = await client.operationsForAccounts({
      accounts,
      account: options.account || 'all',
      from: range.from,
      to: range.to,
      includeExternal: Boolean(options['include-external']),
      includeHidden: Boolean(options['include-hidden']),
    })
    const operations = groups.flatMap(group => group.operations)
    json({
      from: new Date(range.from).toISOString(),
      to: new Date(range.to).toISOString(),
      accounts: (client.usesBrowserCookies ? accounts : groups.map(group => group.account)).map(normalizeAccount),
      ...summarizeOperations(operations),
    })
    return
  }

  if (command === 'export') {
    const range = rangeFromOptions(options)
    const accounts = await loadAccounts(client, options)
    const groups = await client.operationsForAccounts({
      accounts,
      account: options.account || 'all',
      from: range.from,
      to: range.to,
      includeExternal: Boolean(options['include-external']),
      includeHidden: Boolean(options['include-hidden']),
    })
    const exportDir = defaultExportDir()
    const outPath = assertInsideAppRoot(
      options.out || path.join(exportDir, `tbank-personal-${isoStamp()}.json`)
    )
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(outPath, `${JSON.stringify({
      exportedAt: new Date().toISOString(),
      from: new Date(range.from).toISOString(),
      to: new Date(range.to).toISOString(),
      accounts,
      groups,
    }, null, 2)}\n`, { mode: 0o600 })
    await fs.chmod(outPath, 0o600)
    json({
      ok: true,
      outPath,
      accounts: groups.length,
      operations: groups.reduce((sum, group) => sum + group.operations.length, 0),
    })
    return
  }

  if (command === 'receipt') {
    const operationId = options.operation || options['operation-id']
    if (!operationId) throw new Error('receipt requires --operation <id>')
    json(await client.shoppingReceipt({
      operationId,
      account: options.account,
      operationTime: options['operation-time'],
      idSourceType: options['id-source-type'],
    }))
    return
  }

  throw new Error(`Unknown command: ${command}\n\n${usage}`)
}

main().catch(err => {
  if (err instanceof TBankApiError) {
    json({
      ok: false,
      error: err.message,
      status: err.status,
      resultCode: err.resultCode,
      apiPath: err.apiPath,
    })
    process.exitCode = 1
    return
  }
  process.stderr.write(`${err.message || err}\n`)
  process.exitCode = 1
})
