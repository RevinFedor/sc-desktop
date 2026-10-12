'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { inventoryResult, selectAccount, accountTools, loginCommand } = require('./telegram-account-tools')
const session = (name,id,first,label=null) => ({name,label,authorized:true,verified_at:10,me:{id,first_name:first,phone:'+19999990001'}})
const inventory = sessions => inventoryResult([...sessions.map(s=>({type:'session',...s})),{type:'done',enumeration_complete:true,verification_complete:sessions.every(s=>s.authorized!=null)}],'first')

test('login command reports visible phone/code and hidden 2FA without starting login',()=>{
 const out=loginCommand({label:'Менеджер FlowTab'})
 assert.equal(out.executes_login,false);assert.equal(out.active_changed,false)
 assert.equal(out.secrets_input,'local_tty')
 assert.deepEqual(out.input_visibility,{phone:'visible',telegram_code:'visible',two_factor_password:'hidden'})
})

test('fresh get_me selects exact account ID and label without changing active',()=>{
 const inv=inventory([session('first',100,'Fedor'),session('third',300,'Manager','Менеджер FlowTab')])
 for(const selector of [{account_id:300},{name:'менеджер  flowtab'},{session:'third'}]){
  const out=selectAccount(inv,selector);assert.equal(out.session,'third');assert.equal(out.account_id,300);assert.equal(out.identity_basis,'fresh_get_me');assert.equal(out.active_changed,false)
 }
 assert.equal(inv.active,'first')
})
test('missing support never falls back to Fedor/Arbi or an ordinal index',()=>{
 const inv=inventory([session('first',100,'Fedor'),session('second',200,'Arbi')])
 for(const selector of [{name:'Менеджер FlowTab'},{account_id:300},{name:'второй'}]){const out=selectAccount(inv,selector);assert.equal(out.state,'missing');assert.equal(out.ok,false);assert.equal(out.session,undefined)}
})
test('unauthorized exact account is not replaced by another authorized one',()=>{
 const inv=inventory([session('first',100,'Fedor'),{name:'third',label:'support',authorized:false,verified_at:10,me:null,me_cached:{id:300}}])
 assert.equal(selectAccount(inv,{account_id:300}).state,'unauthorized')
})
test('DNS timeout or incomplete enumeration means unknown not absence',()=>{
 const inv=inventory([{name:'third',label:'support',authorized:null,me_cached:{id:300}}])
 assert.equal(selectAccount(inv,{account_id:300}).state,'unknown')
 assert.equal(selectAccount(inv,{name:'missing'}).state,'unknown')
 assert.equal(selectAccount({...inv,enumeration_complete:false},{name:'another'}).state,'unknown')
})
test('cached identity is never fresh authorization proof',()=>{
 const inv=inventory([{name:'third',authorized:true,me:null,me_cached:{id:300},verified_at:10}])
 assert.equal(selectAccount(inv,{account_id:300}).state,'unknown')
})
test('ambiguous name among different accounts rejects rather than choosing first',()=>{
 const inv=inventory([session('first',100,'Manager','support'),session('third',300,'Manager','support')])
 assert.equal(selectAccount(inv,{name:'support'}).state,'ambiguous')
 assert.equal(selectAccount(inv,{account_id:300}).session,'third')
})
test('multiple verified sessions of same account choose stable canonical name not recipient order',()=>{
 const a=selectAccount(inventory([session('z',300,'Manager'),session('a',300,'Manager')]),{account_id:300})
 const b=selectAccount(inventory([session('a',300,'Manager'),session('z',300,'Manager')]),{account_id:300})
 assert.equal(a.session,'a');assert.equal(b.session,'a');assert.deepEqual(a.same_account_sessions,['a','z'])
})
test('fresh re-login of the same account works while preserved old unauthorized session remains',()=>{
 const inv=inventory([{name:'old',label:'support',authorized:false,verified_at:10,me_cached:{id:300}},session('fresh',300,'Manager','support')])
 assert.equal(selectAccount(inv,{name:'support'}).session,'fresh')
 const unknown=inventory([{name:'old',label:'support',authorized:false,me_cached:{id:300}}, {name:'pending',label:'support',authorized:null,me_cached:{id:300}}])
 assert.equal(selectAccount(unknown,{name:'support'}).state,'unknown')
})
test('exact selector schema and result redaction do not expose full phones or opaque paths',()=>{
 const inv=inventory([session('third',300,'Manager')])
 assert.equal(JSON.stringify(inv).includes('+19999990001'),false)
 assert.equal(inv.sessions[0].me.phone_masked,'••••0001')
 assert.equal(inv.sessions[0].path,undefined)
 for(const args of [{},{name:'support',account_id:300},{account_id:0},{account_id:'300'}])assert.throws(()=>selectAccount(inv,args),{code:'INVALID_ACCOUNT_SELECTOR'})
 assert.equal(accountTools.length,2);assert.ok(accountTools.every(t=>t.annotations.readOnlyHint))
})
