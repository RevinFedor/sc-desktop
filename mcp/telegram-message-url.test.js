'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {telegramMessageUrl}=require('./telegram-rag-readers')
function source(kind='group'){return{external_id:'2563262745',handle:'2563262745',meta_json:JSON.stringify({kind,forum:false})}}
function row(peer={kind:'channel',id:2563262745},version=1){return{external_id:'133',raw_meta_json:JSON.stringify({telegram_reply:{version,source_peer:peer,target_peer:{kind:'channel',id:999},scope:'external_peer',message_id:'777'}})}}
test('non-forum full-history megagroup uses its observed own peer, not an external reply target',()=>{
 assert.equal(telegramMessageUrl(source(),row()),'https://t.me/c/2563262745/133')
})
test('a no-reply packet also proves the physical Channel namespace',()=>{
 const item=row();item.raw_meta_json=JSON.stringify({telegram_reply:{version:1,source_peer:{kind:'channel',id:2563262745},scope:'none'}})
 assert.equal(telegramMessageUrl(source(),item),'https://t.me/c/2563262745/133')
})
test('group label, mismatched peer, Basic Chat, unknown packet version and forward never invent a channel link',()=>{
 assert.equal(telegramMessageUrl(source(),{external_id:'133'}),null)
 assert.equal(telegramMessageUrl(source(),row({kind:'channel',id:999})),null)
 assert.equal(telegramMessageUrl(source(),row({kind:'chat',id:2563262745})),null)
 assert.equal(telegramMessageUrl(source(),row(undefined,2)),null)
 assert.equal(telegramMessageUrl(source(),{external_id:'133',url:'https://t.me/original_channel/133',raw_meta_json:JSON.stringify({forward:{from_peer:{kind:'channel',id:2563262745}}})}),null)
})
test('known user/basic Chat and ordinary channel/forum URL contracts are preserved',()=>{
 assert.equal(telegramMessageUrl(source('user'),row()),null)
 assert.equal(telegramMessageUrl(source('chat'),row()),null)
 assert.equal(telegramMessageUrl(source('channel'),{external_id:'133'}),'https://t.me/c/2563262745/133')
 assert.equal(telegramMessageUrl(source(),{...row(),topic_id:403}),'https://t.me/c/2563262745/403/133')
})
