const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),http=require('node:http');
const ts=require('typescript');
const {createResearchNavigation}=require('./research-navigation');
const source=fs.readFileSync(require.resolve('./browser-bridge'),'utf8'),ast=ts.createSourceFile('bridge.js',source,ts.ScriptTarget.Latest,true);
function block(path){let found;const visit=n=>{if(ts.isIfStatement(n)&&n.expression.getText(ast).includes("url.pathname === '"+path+"'"))found=n;ts.forEachChild(n,visit)};visit(ast);assert.ok(found);return found.getText(ast);}
test('actual origin-less HTTP route waits for rendered ACK; web origins/missing jobs never start research',async t=>{
  let payload;const reads=[],window={isDestroyed:()=>false,isMinimized:()=>false,show(){},focus(){},webContents:{id:7,send:(_c,p)=>{payload=p}}};
  const nav=createResearchNavigation({getWindow:()=>window,readJob:id=>{reads.push(id);return id==='missing'?null:{jobId:id};}});
  const handler=vm.runInNewContext('(async(req,res,url)=>{'+block('/research-capabilities')+block('/research-open')+' res.writeHead(404);res.end();})',{
    researchNavigation:nav,readBody:async req=>{let body='';for await(const chunk of req)body+=chunk;return JSON.parse(body)},
    sendJson:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))},
  });
  const server=http.createServer((req,res)=>handler(req,res,new URL(req.url,'http://localhost')).catch(e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}))}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{nav.dispose();await new Promise(resolve=>server.close(resolve))});
  const base='http://127.0.0.1:'+server.address().port;
  const caps=await fetch(base+'/research-capabilities').then(r=>r.json());assert.equal(caps.navigation.renderedAck,true);
  const forbidden=await fetch(base+'/research-open',{method:'POST',headers:{origin:'https://evil.example'},body:JSON.stringify({jobId:'job',requestId:'a'})});
  assert.equal(forbidden.status,403);assert.equal(reads.length,0);
  const request=fetch(base+'/research-open',{method:'POST',body:JSON.stringify({jobId:'job',requestId:'b'})});
  await new Promise(resolve=>{const wait=()=>payload?resolve():setImmediate(wait);wait()});
  assert.equal(payload.jobId,'job');nav.acknowledge(7,{...payload,success:true});
  const response=await request;assert.equal(response.status,200);assert.equal((await response.json()).opened,true);
  assert.equal((await fetch(base+'/research-open',{method:'POST',body:JSON.stringify({jobId:'missing',requestId:'c'})})).status,404);
});
