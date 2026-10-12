'use strict'
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict')
const {inventoryResult,selectAccount}=require('./telegram-account-tools')
const source=fs.readFileSync(path.join(__dirname,'server.js'),'utf8')
const resolve=source.slice(source.indexOf('async function resolveTelegramSessionName'),source.indexOf('async function buildTelegramJobParams'))
const build=source.slice(source.indexOf('async function buildTelegramJobParams'),source.indexOf('function jobStartResult'))

function context(sessions){const c={require,Set,Number,Object,String,console,path,fs:{existsSync:()=>false},projectRoot:'/repo',db:{LIB_ROOT:'/app',maxExternalId:()=>0},
 selectTelegramAccount:selectAccount,listTelegramSessions:async()=>inventoryResult([...sessions.map(s=>({type:'session',...s})),{type:'done',enumeration_complete:true,verification_complete:true}],'personal'),
 targetFromArgs:args=>args.target,resolveSourceOrThrow:()=>({id:48}),normaliseTypes:types=>new Set(types||[]),coercePositiveInt:(v,f)=>Number.isSafeInteger(v)&&v>0?v:f}
 c.require=name=>name.includes('telegram-fetch-policy')?require('../electron/telegram-fetch-policy'):require(name)
 vm.createContext(c);vm.runInContext(resolve+build,c);return c}
const sessions=[{name:'personal',authorized:true,verified_at:10,me:{id:100,first_name:'Fedor'}},
 {name:'support_uuid',label:'Менеджер FlowTab',authorized:true,verified_at:10,me:{id:300,first_name:'Manager'}}]

test('actual MCP params builder carries resolved account override without global active writes',async()=>{
 const c=context(sessions)
 const result=await c.buildTelegramJobParams({target:'fixture',session:'300',mode:'last_n',limit:10,process_voice:false})
 assert.equal(result._tg_session_override,'support_uuid');assert.equal(result.target,'fixture')
 const named=await c.buildTelegramJobParams({target:'fixture',profile:'Менеджер FlowTab'})
 assert.equal(named._tg_session_override,'support_uuid')
})
test('actual builder refuses missing/unauthorized account instead of silently using personal',async()=>{
 const c=context(sessions)
 await assert.rejects(c.buildTelegramJobParams({target:'fixture',session:'999'}),{code:'TELEGRAM_ACCOUNT_NOT_FOUND'})
 const dead=context([sessions[0],{...sessions[1],authorized:false,me:null,me_cached:{id:300}}])
 await assert.rejects(dead.buildTelegramJobParams({target:'fixture',session:'300'}),{code:'TELEGRAM_ACCOUNT_UNAUTHORIZED'})
})
