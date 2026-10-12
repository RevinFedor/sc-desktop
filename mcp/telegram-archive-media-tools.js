'use strict'

const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const runFile = promisify(execFile)
const root = require('node:path').resolve(__dirname, '..')
const identity = { job_id: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,120}$' } }

const telegramArchiveMediaTools = [
  { name: 'telegram_archive_media_plan', description: 'Create an immutable saved-message voice/document catch-up plan in SC CLI. No history fetch, download or cloud call. Only voice messages and non-audio/video documents; complete speech is reused. Requires an explicitly released credential sharing the existing Soniox project budget and existing physical USB pool.',
    inputSchema: { type: 'object', properties: { ...identity,
      source_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 100 },
      session: { type: 'string' }, expected_account_id: { type: 'integer', minimum: 1 }, credential_ref: { type: 'string' },
      media_pool_job_id: { type: 'string' }, peers: { type: 'array', items: { type: 'object', properties: {
        source_id: { type: 'integer', minimum: 1 }, peer_id: { type: 'integer' } }, required: ['source_id','peer_id'], additionalProperties: false } },
      quarantined_messages:{type:'array',items:{type:'string',pattern:'^[1-9][0-9]*:[1-9][0-9]*$'}},
    }, required: ['job_id','source_ids','session','expected_account_id','credential_ref','media_pool_job_id'], additionalProperties: false } },
  ...['start','status','cancel'].map(operation => ({ name: 'telegram_archive_media_' + operation,
    description: operation === 'start' ? 'Start or reuse the exact durable SC CLI catch-up controller. Downloads voice only into the same USB pool; local document originals/OCR on Mac. Soniox uses the existing project mutex, actual-cost ledger and cap. It preserves known provider IDs and does not replay unknown paid creates. Main Application API builds RAG; only proven own voice files are evicted.' : operation === 'status' ? 'Read durable catch-up counts, limitations, current source/RAG progress and exact controller PID. No new job or paid request.' : 'Request cooperative cancellation before the next selected attachment. Current known provider receipt and owned files are preserved; does not cancel the Boosty batch or switch keys.',
    inputSchema: { type: 'object', properties: identity, required: ['job_id'], additionalProperties: false },
    annotations: { readOnlyHint: operation === 'status', destructiveHint: false, idempotentHint: true },
  })),
  { name: 'telegram_archive_media_items', description:'Read a bounded page of exact saved-message media receipts, including type, limitations, original/derived paths and hashes. No Telegram network or paid call.',
    inputSchema:{type:'object',properties:{...identity,after_item_id:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:1000},
      kind:{type:'string',enum:['voice','document']},only_state:{type:'string'}},required:['job_id'],additionalProperties:false},annotations:{readOnlyHint:true}},
  { name: 'telegram_archive_media_proof', description:'Check exact saved paired originals/raw speaker and language metadata, known provider ID and cost, unchanged canonical message caption and source current RAG. No upload, paid request or deletion.',
    inputSchema:{type:'object',properties:{...identity,item_id:{type:'integer',minimum:1}},required:['job_id','item_id'],additionalProperties:false},annotations:{readOnlyHint:true}},
]

function archiveArgs(name, args) {
  if (!telegramArchiveMediaTools.some(t => t.name === name)) throw new Error('Unknown archive operation')
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(args.job_id || '')) throw new Error('Stable job_id required')
  const operation = name.slice('telegram_archive_media_'.length)
  const out = [operation === 'start' ? 'background' : operation, '--job-id', args.job_id]
  if(operation==='items'){
    for(const [key,flag] of [['after_item_id','--after-item-id'],['limit','--limit'],['kind','--kind'],['only_state','--only-state']])if(args[key]!=null)out.push(flag,String(args[key]))
  }
  if(operation==='proof'){
    if(!Number.isSafeInteger(args.item_id)||args.item_id<1)throw new Error('Exact saved item_id required')
    out.push('--item-id',String(args.item_id))
  }
  if (operation === 'plan') {
    if (!Array.isArray(args.source_ids) || !args.source_ids.length || args.source_ids.length > 100 || args.source_ids.some(s => !Number.isSafeInteger(s) || s < 1)) throw new Error('Exact source IDs required')
    if (!Number.isSafeInteger(args.expected_account_id) || args.expected_account_id < 1 || !/^session[A-Za-z0-9_-]*$/.test(args.session || '')) throw new Error('Exact account/session required')
    if (!/^boosty-soniox:[0-9a-f-]{36}$/.test(args.credential_ref || '') || !/^[A-Za-z0-9_.-]{1,120}$/.test(args.media_pool_job_id || '')) throw new Error('Released opaque connection and existing media pool required')
    out.push('--source-ids', [...new Set(args.source_ids)].join(','), '--session', args.session,
      '--expected-account-id', String(args.expected_account_id), '--credential-ref', args.credential_ref, '--media-pool-job-id', args.media_pool_job_id)
    for (const peer of args.peers || []) {
      if (!args.source_ids.includes(peer.source_id) || !Number.isSafeInteger(peer.peer_id) || peer.peer_id >= 0) throw new Error('Peer fence must belong to selected source')
      out.push('--peer', peer.source_id + ':' + peer.peer_id)
    }
    for(const value of args.quarantined_messages || []){
      if(!/^[1-9][0-9]*:[1-9][0-9]*$/.test(value)||!args.source_ids.includes(Number(value.split(':')[0])))throw new Error('Quarantine must bind an exact selected source/message')
      out.push('--exclude-unknown',value)
    }
  }
  return out
}

async function callTelegramArchiveMediaTool(name, args, execute = runFile) {
  const argv = archiveArgs(name, args)
  const { stdout } = await execute(root + '/.venv/bin/python3', [root + '/python-workers/telegram/telegram_archive_media.py', ...argv],
    { cwd: root, timeout: 35000, maxBuffer: 2 * 1024 * 1024 })
  const result = JSON.parse(stdout.trim().split('\n').at(-1))
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], ...(result.ok === false ? { isError: true } : {}) }
}

module.exports = { telegramArchiveMediaTools, callTelegramArchiveMediaTool, archiveArgs }
