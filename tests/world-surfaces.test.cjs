const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function textures(){
 const scope={window:{},Math,document:{createElement:()=>{const c={};c.getContext=()=>({
  createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:img=>c.pixels=img.data
 });return c;}}};vm.createContext(scope);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/engine/texgen.js'),'utf8'),scope);
 return scope.window.TexGen;
}
test('all world themes remain opaque, deterministic and continuous with offshore water',()=>{
 const T=textures(),size=128;
 for(const theme of ['summer','winter','desert']){
  const map=T.terrain(theme,12345,size,1000,417).pixels;
  assert.deepEqual(map,T.terrain(theme,12345,size,1000,417).pixels);
  const sea=T.openWaterGrain(),base=T.TERRAIN_PALETTES[theme].waterDeep;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
   const i=(y*size+x)*4;assert.equal(map[i+3],255,'terrain alpha cannot erase colour on canvas upload');
   if(x===0||y===0||x===size-1||y===size-1){
    const g=sea((x/size-.5)*1000/400,(y/size-.5)*1000/400);
    for(let c=0;c<3;c++)assert.equal(map[i+c],Math.round(base[c]+g*(c===2?.9:1)),'offshore phase');
   }
  }
 }
});
test('new stone and ore textures remain visibly distinct and reproducible',()=>{
 const T=textures();
 for(const theme of ['summer','winter','desert']){
  const stone=T.worldSurface('stone',theme,88,64).pixels,ore=T.worldSurface('ore',theme,88,64).pixels;
  let warm=0;for(let i=0;i<ore.length;i+=4)if(ore[i]>stone[i]+5&&ore[i+2]<stone[i+2]-5)warm++;
  assert.ok(warm>40,'gold resource must retain readable ochre inclusions');
  assert.deepEqual(ore,T.worldSurface('ore',theme,88,64).pixels);
 }
});
