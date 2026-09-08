const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('foreground water stays inside the camera clipping planes across zoom and pitch',()=>{
 const scope={window:{},TexGen:{}};vm.createContext(scope);
 for(const file of ['math3d','gamerenderer'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/engine/'+file+'.js'),'utf8'),scope);
 const r=Object.create(scope.window.EngineRenderer.prototype);
 Object.assign(r,{terrain:{size:800},cameraTarget:{x:400,z:-400},W:2285,H:990,_yaw:0});
 for(const zoom of [10,34,190,520])for(const degrees of [10,15,26.565,45,89]){
  r._halfH=zoom;r._pitch=degrees*Math.PI/180;const cam=r._computeCam();
  // Camera-space depth where the bottom-centre view ray meets the water plane.
  const depth=(cam.dist*Math.sin(r._pitch)+.35)/(Math.sin(r._pitch)+cam.tanHalf*Math.cos(r._pitch));
  const p=cam.proj,ndc=(-p[10]*depth+p[14])/depth;
  assert.ok(ndc>=-1&&ndc<=1,`water clipped at zoom ${zoom}, pitch ${degrees}: ${ndc}`);
 }
});
