import test from 'node:test';import assert from 'node:assert/strict';
import {wireResearchNavigation} from './researchNavigation.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('late expired publication cannot navigate or claim the detail page was rendered',async()=>{
  let listener;const calls=[];
  const off=wireResearchNavigation({api:{onResearchOpenRequest:fn=>{listener=fn;return()=>{}},researchOpenReady:async()=>null,researchOpenAck:async x=>calls.push(x)},
    navigate:()=>calls.push('navigate'),closeOverlays(){},getScreen:()=>null,reportError:e=>assert.fail(String(e))});
  listener({requestId:'old',jobId:'job',sequence:1});await tick();assert.deepEqual(calls,[]);off();
});
test('fresh request uses canonical existing screen; no ACK is synthesized before the screen loads',async()=>{
  let listener,current=null;const calls=[],screen={};
  const off=wireResearchNavigation({api:{onResearchOpenRequest:fn=>{listener=fn;return()=>{}},researchOpenReady:async()=>current,researchOpenAck:async x=>calls.push(x)},
    navigate:(...x)=>calls.push(x),closeOverlays:()=>calls.push('close'),getScreen:()=>screen,reportError:e=>assert.fail(String(e))});
  await tick();current={requestId:'nav',jobId:'exact',sequence:2};listener(current);await tick();
  assert.deepEqual(calls,['close',['aistudio-job',{jobId:'exact',navigationRequestId:'nav'}]]);off();
});
test('delayed ready snapshot cannot supersede a newer publication',async()=>{
  let listener,release;const calls=[],screen={};let reads=0;
  const current={requestId:'new',jobId:'B',sequence:2};
  const off=wireResearchNavigation({api:{onResearchOpenRequest:fn=>{listener=fn;return()=>{}},researchOpenReady:async()=>++reads===1?new Promise(resolve=>{release=resolve}):current,researchOpenAck:async()=>{}},
    navigate:(...x)=>calls.push(x),closeOverlays(){},getScreen:()=>screen,reportError:e=>assert.fail(String(e))});
  listener(current);await tick();release({requestId:'old',jobId:'A',sequence:1});await tick();
  assert.deepEqual(calls,[['aistudio-job',{jobId:'B',navigationRequestId:'new'}]]);off();
});
test('manual navigation during ready proof prevents late focus reversal',async()=>{
  let listener,release,screen={};const calls=[];let reads=0;
  const current={requestId:'nav',jobId:'A',sequence:1};
  const off=wireResearchNavigation({api:{onResearchOpenRequest:fn=>{listener=fn;return()=>{}},researchOpenReady:async()=>++reads===1?null:new Promise(resolve=>{release=resolve}),researchOpenAck:async x=>calls.push(x)},
    navigate:()=>assert.fail('manual navigation owns the screen'),closeOverlays(){},getScreen:()=>screen,reportError:e=>assert.fail(String(e))});
  await tick();listener(current);await tick();screen={};release(current);await tick();
  assert.equal(calls[0].success,false);assert.equal(calls[0].error,'research_navigation_cancelled_by_user');off();
});
