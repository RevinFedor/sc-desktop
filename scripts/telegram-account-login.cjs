#!/usr/bin/env node
'use strict'

// Local interactive companion to the existing desktop session worker, not a
// second server or legacy CLI runtime. All secrets are read by Python on TTY.
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const ROOT = path.resolve(__dirname, '..')

function runtime({ platform = process.platform, root = ROOT, env = process.env, exists = fs.existsSync } = {}) {
  const paths = platform === 'darwin' ? [
    '/Applications/SC Desktop.app/Contents/Resources/.venv/bin/python3',
    path.join(root, '.venv/bin/python3'),
  ] : platform === 'win32' ? [path.join(root, '.venv/Scripts/python.exe')] : [path.join(root, '.venv/bin/python3')]
  if (env.SC_DESKTOP_PYTHON) paths.unshift(env.SC_DESKTOP_PYTHON)
  const python = paths.find(file => exists(file))
  const worker = path.join(root, 'python-workers/telegram/tg_sessions_ndjson.py')
  if (!python || !exists(worker)) throw Object.assign(new Error('Supported SC Desktop Python/worker is unavailable; no legacy CLI fallback.'), { code: 'ACCOUNT_LOGIN_RUNTIME_UNAVAILABLE' })
  return { python, worker, cwd: path.join(root, 'python-workers') }
}

function parse(argv) {
  const out = { check: false, label: null, expectedAccountId: null }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--check') out.check = true
    else if (flag === '--label') out.label = argv[++i]
    else if (flag === '--expected-account-id') out.expectedAccountId = Number(argv[++i])
    else throw Object.assign(new Error('Only --label, --expected-account-id and --check are allowed; never pass secrets as arguments.'), { code: 'INVALID_ACCOUNT_LOGIN_ARGUMENT' })
  }
  if (out.label != null && (typeof out.label !== 'string' || !out.label.trim() || out.label.length > 120)) throw new Error('Invalid account label')
  if (out.expectedAccountId != null && (!Number.isSafeInteger(out.expectedAccountId) || out.expectedAccountId < 1)) throw new Error('Invalid account ID')
  return out
}

function argsFor(options) {
  if (options.check) return ['runtime-check']
  return ['login-interactive', ...(options.label ? ['--label', options.label] : []),
    ...(options.expectedAccountId ? ['--expected-account-id', String(options.expectedAccountId)] : [])]
}

function localNode({ platform = process.platform, executable = process.execPath, exists = fs.existsSync } = {}) {
  // MCP can itself run under Electron's RUN_AS_NODE shim. Returning that path
  // without its environment would launch a GUI, not a local Node CLI.
  const candidates = platform === 'darwin' ? ['/opt/homebrew/bin/node', '/usr/local/bin/node', executable] : [executable]
  const selected = candidates.find(file => exists(file) && !/[\\/]Electron(?:\.exe)?$/i.test(file))
  if (!selected) throw Object.assign(new Error('A local Node CLI is required; Electron GUI is not a login command.'), { code: 'ACCOUNT_LOGIN_NODE_UNAVAILABLE' })
  return selected
}

function command({ label, expectedAccountId, node = localNode(), script = __filename, platform = process.platform } = {}) {
  const options = parse([...(label != null ? ['--label', label] : []), ...(expectedAccountId != null ? ['--expected-account-id', String(expectedAccountId)] : [])])
  const argv = [node, script, ...(options.label ? ['--label', options.label] : []),
    ...(options.expectedAccountId ? ['--expected-account-id', String(options.expectedAccountId)] : [])]
  if (platform === 'win32') return argv.map(value => '"' + String(value).replace(/"/g, '""') + '"').join(' ')
  return argv.map(value => "'" + String(value).replace(/'/g, "'\\''") + "'").join(' ')
}

async function main(argv, deps = {}) {
  const options = parse(argv), selected = (deps.runtime || runtime)()
  if (options.check) {
    const checked = (deps.spawnSync || spawnSync)(selected.python, [selected.worker, ...argsFor(options)], { cwd: selected.cwd, env: process.env, encoding: 'utf8', timeout: 10000 })
    if (checked.status !== 0) throw new Error('SC Desktop auth worker/dependencies unavailable; no login was attempted.')
    process.stdout.write(JSON.stringify({ ok: true, platform: process.platform, runtime: selected, check: JSON.parse(checked.stdout.trim()) }) + '\n')
    return
  }
  if (!(deps.tty ?? (process.stdin.isTTY && process.stderr.isTTY))) throw Object.assign(new Error('Run this command yourself in a local terminal; AI must not receive phone/code/password.'), { code: 'INTERACTIVE_TERMINAL_REQUIRED' })
  const child = (deps.spawn || spawn)(selected.python, [selected.worker, ...argsFor(options)], { cwd: selected.cwd, env: process.env, stdio: 'inherit' })
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => { process.exitCode = code ?? 2; resolve() }) })
}

module.exports = { runtime, parse, argsFor, command, localNode, main }
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, code: error.code || 'ACCOUNT_LOGIN_FAILED', error: error.message }) + '\n')
  process.exitCode = 2
})
