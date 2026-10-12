const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const {parse}=require('@babel/parser');
test('actual SC bridge sync forwards trace, partial meaning assessment, measured time and global preferences',async()=>{
 const source=fs.readFileSync(require('path').resolve(__dirname,'../../electron/browser-bridge.js'),'utf8');
 const fn=parse(source,{sourceType:'unambiguous'}).program.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name==='syncVocabularyWithVoice');
 const item={id:'v_word',term:'word',state:'saved'},calls=[];
 const context=vm.createContext({Date,Map,Set,console,normalizeVocabularyTerm:x=>x,vocabularyIdentityKey:x=>x.term,
  remoteVocabularyIndex:items=>({byId:new Map(items.map(x=>[x.id,x])),byIdentity:new Map(),byTerm:new Map(items.map(x=>[x.term,x]))}),
  voiceVocabularyRequest:async(method,path,body)=>{calls.push({method,path,body});return path==='/api/vocabulary/study-state'?{studyPreferences:{showSupport:false},acknowledgedStudyEvents:['trace']} :method==='POST'?{item}:{items:[item]};}});
 vm.runInContext(source.slice(fn.start,fn.end)+'\nthis.run=syncVocabularyWithVoice;',context);
 const trace={stream:'device',position:7,id:'show'},meaningRecall={assessed:['defs:a','defs:b'],remembered:['defs:b']};
 const result=await context.run({studyStateVersion:1,studyEvents:[{id:'trace',kind:'show'}],preferenceOperations:[{id:'pref',showSupport:false}],reviews:[{id:'review',type:'review',remoteId:'v_word',result:'partial',durationMs:9500,recallVersion:1,trace,meaningRecall}]});
 const sent=calls.find(x=>x.path.endsWith('/review')).body;assert.equal(sent.durationMs,9500);assert.equal(sent.recallVersion,1);assert.deepEqual(sent.trace,trace);assert.deepEqual(sent.meaningRecall,meaningRecall);
 assert.equal(result.studyPreferences.showSupport,false);assert.deepEqual(result.acknowledgedStudyEvents,['trace']);
 assert.equal(calls.find(x=>x.path.endsWith('/study-state')).body.preferenceOperations[0].showSupport,false);
 const skippedAt=Date.now();calls.length=0;
 const skipped=await context.run({reviews:[{id:'skip-1',type:'skip',remoteId:'v_word',skippedAt,createdAt:skippedAt},
  {id:'undo-skip-1',type:'undo-skip',remoteId:'v_word',skipOperationId:'skip-1',createdAt:skippedAt+1}]});
 assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(x=>x.method==='POST'))),[
  {method:'POST',path:'/api/vocabulary/v_word/skip',body:{operationId:'skip-1',skippedAt}},
  {method:'POST',path:'/api/vocabulary/v_word/skip/undo',body:{operationId:'skip-1'}}]);
 assert.deepEqual([...skipped.acknowledgedReviews],['skip-1','undo-skip-1']);
});
