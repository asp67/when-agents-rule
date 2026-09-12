// Optional real-browser regression: WAR_PLAYWRIGHT_PATH points to Playwright;
// WAR_CHROME_PATH may select an installed Chrome. No model connections are used.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.WAR_PLAYWRIGHT_PATH||'playwright');
const root=path.resolve(__dirname,'../..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const server=http.createServer((req,res)=>{
 const rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/, '')||'index.html';
 const file=path.resolve(root,rel);
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
 res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const out=process.env.WAR_QA_DIR||fs.mkdtempSync(path.join(os.tmpdir(),'war-shared-qa-'));
 fs.mkdirSync(out,{recursive:true});let browser;
 try{
  browser=await chromium.launch({headless:true,...(process.env.WAR_CHROME_PATH?{executablePath:process.env.WAR_CHROME_PATH}:{}),args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('warGraphicsQuality','low');localStorage.setItem('warUiLang','en');});
  await page.goto(origin+'/?full=1');await page.waitForFunction(()=>typeof game!=='undefined'&&game?.renderer);
  assert.equal(await page.evaluate(()=>game.renderer.graphicsQuality),'cinematic');
  const build=Number(fs.readFileSync(path.join(root,'index.html'),'utf8').match(/js\/game\.js\?v=(\d+)/)[1]);
  assert.equal(await page.evaluate(()=>UIManager.buildVersion()),build);
  await page.evaluate(()=>{setUiLang('en');game.startVisualShowcase('greek','summer','iron','night');});
  await page.waitForFunction(()=>game.gameStarted&&game.player.units.length>5);
  await page.evaluate(()=>{
   game.pauseState='paused';game.aiManager.update=()=>{};
   const r=game.renderer;r.cameraTarget.set(-3,0,-325);r._halfH=20;
   window.lampCheck=null;const assemble=r._assembleFrame;
   r._assembleFrame=function(...args){
    for(const u of this.units){u._fade=window.lampTest==='ghost'?.4:null;u.mesh.visible=window.lampTest!=='hidden';}
    const result=assemble.apply(this,args),buffers=new Set((this._workerLampModel||[]).map(e=>e.buf));
    window.lampCheck={meshes:this._dl.opaque.filter(e=>buffers.has(e.buf)).length,
     lit:this.units.filter(u=>this._dl.opaque.some(e=>e.localLights===u._engine.lampLights&&e.localLights?.[3]>0)).map(u=>u.type)};
    return result;
   };
  });
  await page.waitForFunction(()=>lampCheck?.meshes>0&&lampCheck.lit.length>0);
  assert.ok((await page.evaluate(()=>lampCheck.lit)).every(t=>t==='worker'));
  await require('./light-range-check.cjs')(page);
  await page.screenshot({path:path.join(out,'worker-lanterns-night.png')});
  for(const quality of ['balanced','low']){
   await page.evaluate(q=>game.ui.setGraphicsQuality(q),quality);
   await page.waitForFunction(()=>lampCheck.meshes===0&&lampCheck.lit.length===0);
  }
  await page.evaluate(()=>game.ui.setGraphicsQuality('cinematic'));
  for(const mode of ['ghost','hidden']){
   await page.evaluate(m=>window.lampTest=m,mode);
   await page.waitForFunction(()=>lampCheck.meshes===0&&lampCheck.lit.length===0);
  }
  await page.evaluate(()=>{window.lampTest=null;game._showcaseLightSeconds=EngineAtmosphere.previewTime('summer','day');});
  await page.waitForFunction(()=>lampCheck.meshes>0&&lampCheck.lit.length===0);
  // Visibility still gates the light even when an entity's mesh is present.
  await page.evaluate(()=>{game._showcaseLightSeconds=EngineAtmosphere.previewTime('summer','night');window.wasVisible=game.fogOfWar.isPositionVisible;game.fogOfWar.isPositionVisible=()=>false;});
  await page.waitForFunction(()=>lampCheck.lit.length===0);
  await page.evaluate(()=>game.fogOfWar.isPositionVisible=window.wasVisible);
  await page.waitForFunction(()=>lampCheck.lit.length>0);
  // A disabled fog layer must be restored on the same canvas, with no leaked texture.
  assert.equal(await page.evaluate(()=>{
   const r=game.renderer,fow=game.fogOfWar;r._syncFog();const canvas=r._fogCanvas,old=r._fogTex;
   game.fogOfWar=null;r._syncFog();game.fogOfWar=fow;r._syncFog();
   return r._fogCanvas===canvas&&!!r._fogEntry&&r._fogTex!==old;
  }),true);
  await page.reload();await page.waitForFunction(()=>typeof game!=='undefined'&&game?.renderer);
  await page.evaluate(()=>{
   setUiLang('en');game.spectatorMode=true;game.startGame('campaign',2);
   game.pauseState='paused';game.aiManager.update=()=>{};
   const ai=game.aiManager.aiPlayers[0];ai.researchedTechs={house:true};ai.currentResearch={techId:'farm',progress:5,duration:20};
   game.ui.updateSpectatorPlayerList();game.ui.openLbFlyout(ai.id);
   game.openAIAIManager.decisionLog=[
    {playerId:ai.id,civName:'Greeks',color:'#5388ff',move:1,action:'assign_workers',params:{},failed:true,result:'[ERROR] Unknown resource coordinates',timestamp:Date.now()},
    {playerId:ai.id,civName:'Greeks',color:'#5388ff',move:2,action:'network_error',params:{},failed:true,timestamp:Date.now()}
   ];game.ui.updateDecisionLog();
  });
  await page.waitForFunction(()=>document.querySelector('.is-researching')?.textContent.includes('25%'));
  assert.equal(await page.locator('#aiLogEntries .log-error').count(),2);
  assert.ok(await page.locator('#aiLogEntries .log-error').first().isVisible());
  assert.ok(await page.locator('.is-researching').isVisible());
  for(const msg of await page.locator('#aiLogEntries .log-error').allTextContents())assert.ok(msg.startsWith('⚠ ')&&msg.length>3);
  await page.evaluate(()=>{game.aiManager.aiPlayers[0].currentResearch.progress=10;game.ui.updateSpectatorPlayerList();});
  await page.waitForFunction(()=>document.querySelector('.is-researching')?.textContent.includes('50%'));
  await page.screenshot({path:path.join(out,'research-rejections.png')});
  await page.evaluate(()=>{const ai=game.aiManager.aiPlayers[0];ai.currentResearch=null;ai.researchedTechs.farm=true;game.ui.updateSpectatorPlayerList();});
  assert.equal(await page.locator('.is-researching').count(),0);
  assert.equal(await page.locator('.lb-fly-sec').first().locator('.lb-fly-chip').count(),2);
  await page.evaluate(()=>game.ui.setGraphicsQuality('low'));await page.reload();
  await page.waitForFunction(()=>typeof game!=='undefined'&&game?.renderer);
  assert.equal(await page.evaluate(()=>game.renderer.graphicsQuality),'cinematic');
  // Load a shipped transcript and ensure replay geometry stays fixed between frames.
  await page.evaluate(async()=>{game.ui.anOpen();await game.ui.anLoadSample();game.ui.anSetLayout('watch');});
  await page.waitForFunction(()=>game.ui.analyzer?.order?.length>0&&game.renderer.replayMode);
  const positions=await page.evaluate(()=>game.renderer.units.map(u=>[u.x,u.z]));
  assert.ok(positions.length>0);
  const frames=await page.evaluate(()=>game.renderer._completedFrames);
  await page.waitForFunction(n=>game.renderer._completedFrames>n+3,frames);
  assert.deepEqual(await page.evaluate(()=>game.renderer.units.map(u=>[u.x,u.z])),positions);
  assert.deepEqual(errors,[]);
  console.log('PASS: High/reload, night/day worker lamps, fog/ghost/quality rules, research progress/completion, rejection warnings and transcript replay. Screenshots: '+out);
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
