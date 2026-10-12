'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { telegramBotTools, callTelegramBotTool } = require('./telegram-bot-tools')
const { normalizeTelegramLiveRequest, telegramBotMutationInFlight, telegramMembershipMutationInFlight,
  telegramLiveTarget, applyTelegramLiveEvent, createTelegramLiveState } = require('../electron/telegram-live')
const base = { session: 'session_4531193', bot: '@boosty_to_bot', expected_account_id: '1033012338', expected_peer_id: '935519651' }
const sha = 'a'.repeat(64)
test('seven public source tools preserve exact read/action/invite/join boundaries', () => {
  assert.deepEqual(telegramBotTools.map(t => t.name), ['telegram_invite_info','telegram_bot_info','telegram_bot_messages','telegram_bot_action','telegram_bot_action_status','telegram_bot_join','telegram_bot_join_status'])
  assert.equal(telegramBotTools.find(t => t.name === 'telegram_bot_action').annotations.readOnlyHint,false)
  assert.ok(telegramBotTools.filter(t => !['telegram_bot_action','telegram_bot_join'].includes(t.name)).every(t => t.annotations.readOnlyHint))
})
test('exact session/account/bot proof required before any request, unsafe integers not rounded', () => {
  for (const change of [{ session: null }, { expected_account_id: 2**62 }, { expected_peer_id: -123 }, { bot: 'Boosty display name' }]) {
    assert.throws(() => normalizeTelegramLiveRequest({ ...base,...change,operation:'bot_info' }))
  }
  const huge = normalizeTelegramLiveRequest({ ...base,operation:'bot_info',expected_account_id:'4611686018427387921' })
  assert.equal(huge.expected_account_id,'4611686018427387921')
})
test('all three selected bot replies go through the existing App bridge start, no hidden local producer', async () => {
  const calls=[]
  const args = { ...base,message_ids:[273965,273966,273967],wait_ms:0 }
  const out = await callTelegramBotTool('telegram_bot_messages',args,{ start:async (request,wait) => {
    calls.push({request,wait}); return {ok:true,job_id:'desktop:fixture',result:{messages:[]}}
  } })
  assert.equal(calls.length,1)
  assert.equal(calls[0].request.operation,'bot_messages')
  assert.deepEqual(calls[0].request.message_ids,[273965,273966,273967])
  assert.equal(calls[0].request.session,'session_4531193')
  assert.equal(telegramLiveTarget(calls[0].request),'@boosty_to_bot')
  assert.equal(JSON.parse(out.content[0].text).job_id,'desktop:fixture')
})
test('keyboard pagination pins per-message binding; stale/unpinned or unsafe pages rejected', () => {
  assert.throws(() => normalizeTelegramLiveRequest({ ...base,operation:'bot_messages',message_ids:[1],row_offset:1 }),/continuation/)
  assert.throws(() => normalizeTelegramLiveRequest({ ...base,operation:'bot_messages',message_ids:[1],expected_binding_hashes:{1:'wrong'} }))
  const out = normalizeTelegramLiveRequest({ ...base,operation:'bot_messages',message_ids:[1,1,2],row_offset:1,expected_binding_hashes:{1:sha,2:sha} })
  assert.deepEqual(out.message_ids,[1,2]); assert.equal(out.row_offset,1)
})
test('button binding/confirmation and verbatim label retained, no raw callback data or unsupported action parameter', async () => {
  const args = { ...base,request_id:'bot-1',confirm:true,purpose:'read_groups',action:'button',message_id:273966,row:0,column:1,expected_binding_hash:sha,expected_action_label:' 🎭 Доступные группы ' }
  const out = normalizeTelegramLiveRequest({ ...args,operation:'bot_action' })
  assert.equal(out.expected_action_label,args.expected_action_label)
  for (const change of [{confirm:false},{purpose:'pay'},{row:-1},{column:true},{expected_binding_hash:'wrong'},{message_id:0}]) {
    assert.throws(() => normalizeTelegramLiveRequest({ ...args,...change,operation:'bot_action' }))
  }
  await assert.rejects(callTelegramBotTool('telegram_bot_action',{...args,data_base64:'secret'}, {start(){throw Error('must not call')}}),/Unsupported/)
})
test('command-source proof is exact and status never carries an action/confirmation', () => {
  const action = normalizeTelegramLiveRequest({ ...base,operation:'bot_action',request_id:'cmd-1',confirm:true,purpose:'read_groups',action:'command',command:'/unban',command_source_message_id:273968,expected_command_source_sha256:sha })
  assert.equal(action.command,'/unban')
  assert.throws(() => normalizeTelegramLiveRequest({ ...base,operation:'bot_action',request_id:'cmd-1',confirm:true,purpose:'read_groups',action:'command',command:'/start pay' }))
  const status = normalizeTelegramLiveRequest({ ...base,operation:'bot_action_status',request_id:'cmd-1' })
  assert.equal(status.action,undefined); assert.equal(status.confirm,undefined)
})
test('Bot commit-in-flight cancellation fence preserves membership fence and permits preflight cancel', () => {
  assert.equal(telegramBotMutationInFlight({type:'tg_live_bot_action',tg_live:{stage:'dispatching_bot_action'}}),true)
  assert.equal(telegramBotMutationInFlight({type:'tg_live_bot_action',tg_live:{stage:'starting'}}),false)
  assert.equal(telegramBotMutationInFlight({type:'tg_live_bot_messages',tg_live:{stage:'dispatching_bot_action'}}),false)
  assert.equal(telegramMembershipMutationInFlight({type:'tg_live_join',tg_live:{stage:'updating_membership'}}),true)
  const job={type:'tg_live_bot_action',params:{operation:'bot_action'},tg_live:createTelegramLiveState({operation:'bot_action'})}
  applyTelegramLiveEvent(job,{type:'progress',stage:'dispatching_bot_action',done:0,total:1})
  assert.equal(telegramBotMutationInFlight(job),true)
})
test('read-only invite preview requires exact account/session and uses no confirm/join operation', async () => {
  const args={session:'session_4531193',expected_account_id:'1033012338',target:'https://t.me/+fixture_only_invite'}
  const out = normalizeTelegramLiveRequest({...args,operation:'membership_info'})
  assert.equal(out.confirm,undefined)
  assert.throws(()=>normalizeTelegramLiveRequest({...args,operation:'membership_info',session:null}))
  let call
  await callTelegramBotTool('telegram_invite_info',args,{start:async request => {call=request;return {ok:true}}})
  assert.equal(call.operation,'membership_info')
})
test('scoped join is bound to current bot button/title, not a raw URL or callback', async () => {
  const args = { ...base,request_id:'join-1',confirm:true,purpose:'join_itkras',message_id:273966,row:0,column:0,expected_binding_hash:sha,expected_action_label:'АйТи Красавчики: Клуб',expected_chat_title:'Клуб АйТи Красавчиков' }
  let call
  await callTelegramBotTool('telegram_bot_join',args,{start:async request=>{call=request;return {ok:true,result:{state:'request_sent',joined:false}}}})
  assert.equal(call.operation,'bot_join'); assert.equal(call.target,undefined)
  assert.throws(()=>normalizeTelegramLiveRequest({...args,operation:'bot_join',purpose:'pay'}))
  await assert.rejects(callTelegramBotTool('telegram_bot_join',{...args,target:'https://t.me/+must_not_use'},{}),/Unsupported/)
  const status=normalizeTelegramLiveRequest({...base,operation:'bot_join_status',request_id:'join-1'})
  assert.equal(status.message_id,undefined); assert.equal(status.confirm,undefined)
  assert.equal(telegramMembershipMutationInFlight({type:'tg_live_bot_join',tg_live:{stage:'updating_membership'}}),true)
})
