const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function setup() {
    const scope = {AbortController, setTimeout, clearTimeout};
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../js/update-notice.js'), 'utf8'), scope);
    const updates = vm.runInContext('WarUpdates', scope);
    const data = new Map();
    return {updates, storage: {getItem: k => data.get(k), setItem: (k,v) => data.set(k,v)}};
}
test('update metadata uses the game version, not a newer unrelated asset', () => {
    const {updates} = setup();
    assert.equal(updates.parseBuild('<script src="js/ui.js?v=999"></script><script src="js/game.js?v=836"></script>'), 836);
    assert.equal(updates.parseBuild('<h1>503</h1>'), null);
    assert.equal(updates.parseBuild('<script src="js/game.js?v=99999999999999999999">'), null);
});
test('update checks cache results for fifteen minutes then check again', async () => {
    const {updates,storage} = setup(); let calls = 0;
    const fetcher = async (url, options) => {
        calls++; assert.equal(options.credentials, 'omit');
        return {ok:true,text:async()=>'<script src="js/game.js?v=837"></script>'};
    };
    assert.equal(await updates.latest(fetcher,storage,1000),837);
    assert.equal(await updates.latest(fetcher,storage,2000),837); assert.equal(calls,1);
    assert.equal(await updates.latest(fetcher,storage,901000),837); assert.equal(calls,2);
});
test('network failures are silent and cached; blocked storage still allows checks', async () => {
    const {updates,storage} = setup(); let calls = 0;
    const offline = async () => {calls++;throw Error('offline');};
    assert.equal(await updates.latest(offline,storage,1000),null);
    assert.equal(await updates.latest(offline,storage,2000),null);assert.equal(calls,1);
    const blocked={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
    assert.equal(await updates.latest(async()=>({ok:true,text:async()=>'<script src="js/game.js?v=837">'}),blocked),837);
});
test('bad responses and corrupt cached versions cannot announce updates', async () => {
    const {updates,storage} = setup();
    storage.setItem(updates.key,JSON.stringify({at:1000,build:'9999'}));
    assert.equal(await updates.latest(async()=>({ok:false}),storage,2000),null);
    storage.setItem(updates.key,'broken json');
    assert.equal(await updates.latest(async()=>({ok:true,text:async()=>'<html>error</html>'}),storage,2000),null);
});
test('landing notice only appears for a newer build and clipboard failure leaves selectable instructions', async () => {
    for (const remote of [835,836,837,null]) {
        let start;
        const elements = Object.fromEntries(['updateNotice','updateBuild','copyUpdateCommand','updateCommand','updateCopyStatus'].map(id=>[id,{
            hidden:true,dataset:{},value:'git pull --ff-only',addEventListener(_,fn){this.click=fn;},
            focus(){},select(){this.selected=true;}
        }]));
        const scope={AbortController,setTimeout,clearTimeout,UIManager:{buildVersion:()=>836},
            document:{readyState:'loading',getElementById:id=>elements[id],addEventListener:(_,fn)=>start=fn,execCommand:()=>false},
            window:{fetch:async()=>{}},navigator:{},t:key=>key,applyI18n(){}};
        vm.createContext(scope);
        vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../js/update-notice.js'),'utf8'),scope);
        vm.runInContext(`WarUpdates.latest = async () => ${remote}`,scope);
        await start();
        assert.equal(elements.updateNotice.hidden,remote!==837);
        if(remote===837){
            assert.equal(elements.updateBuild.textContent,837);
            await elements.copyUpdateCommand.click();
            assert.equal(elements.updateCommand.selected,true);
            assert.equal(elements.updateCopyStatus.textContent,'update.manual');
        }
    }
});
