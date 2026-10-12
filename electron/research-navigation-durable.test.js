const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {once}=require('node:events');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sc-research-navigation-db-'));
process.env.SC_DESKTOP_DIR=root;process.env.SC_DESKTOP_DB=path.join(root,'library.db');
const db=require('./database'),{startServer,listExternalJobsForUi}=require('./browser-bridge');
test('exact historic job bypasses recent100 using the UI normalizer, not browser/recovery snapshot',async t=>{
  const database=db.getDb();
  const insert=database.prepare(`INSERT INTO research_jobs(job_id,kind,provider,model_id,mode,status,stage,prompt,response_text,result_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('old-job','research','chatgpt','6-astra','chat','done','done','saved prompt','saved answer',
    JSON.stringify({text:'saved answer',input_files:[{name:'source.md',path:'/synthetic/source.md'}]}),1,1);
  for(let i=0;i<101;i++)insert.run('new-'+i,'research','chatgpt','6-astra','chat','done','done','new','new',null,10+i,10+i);
  assert.equal(db.listResearchJobs(100).some(j=>j.jobId==='old-job'),false);
  const old=db.getResearchHistoryJob('old-job');
  assert.equal(old.jobId,'old-job');assert.equal(old.fullPrompt,'saved prompt');assert.equal(old.responseText,'saved answer');
  assert.deepEqual(old,db.listResearchJobs(200).find(j=>j.jobId==='old-job'));
  assert.equal(db.getResearchJob('old-job').id,'old-job');assert.equal(db.getResearchJob('old-job').jobId,undefined,'recovery snapshot intentionally different');
  const selected=listExternalJobsForUi({jobId:'old-job',summary:false});assert.equal(selected.length,1);assert.equal(selected[0].jobId,'old-job');
  const before=database.prepare('SELECT * FROM research_jobs ORDER BY job_id').all();
  const server=startServer({port:0,jobRunner:{LIB_ROOT:root},requestExtension:()=>assert.fail('navigation read cannot send browser commands')});
  if(!server.listening)await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(root,{recursive:true,force:true})});
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/external-jobs?id=old-job&summary=1').then(r=>r.json());
  assert.equal(response.jobs.length,1);assert.equal(response.jobs[0].jobId,'old-job');assert.equal(response.jobs[0].fullPrompt,undefined);
  assert.deepEqual(database.prepare('SELECT * FROM research_jobs ORDER BY job_id').all(),before);
});
