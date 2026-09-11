const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function setup() {
    const scope = vm.createContext({URL, console, document: {getElementById: () => null}, t: k => k});
    vm.runInContext(fs.readFileSync(path.join(root,'js/openai-ai.js'),'utf8')+'\nthis.Manager=OpenAIAIManager;', scope);
    vm.runInContext(fs.readFileSync(path.join(root,'js/ui.js'),'utf8')+'\nthis.UI=UIManager;', scope);
    const manager = scope.Manager;
    manager.buildAuthHeaders = async () => ({Authorization:'Bearer test-only'});
    return {manager,scope};
}
const response = (status, data = {data:[{id:'local-model'}]}) => ({ok:status===200,status,json:async()=>data});

test('normalizes private addresses and preserves explicit schemes and custom paths',()=>{
    const {manager:m}=setup();
    for(const address of ['192.168.8.144:8888/v1','localhost:11434','10.0.0.5:1234','172.16.0.1:8080','127.0.0.1:8000','[::1]:8000','[fd00::1]:8000'])
        assert.equal(m.normalizeLocalEndpoint(' '+address+' '),'http://'+address);
    for(const address of ['https://192.168.8.144:8888/custom','example.com:8000','8.8.8.8:8000','172.32.0.1:8000','192.168.1.999:8000','user:secret@192.168.1.1:8000','ftp://localhost:8000'])
        assert.equal(m.normalizeLocalEndpoint(address),address);
});

test('bare local endpoint retries only /v1 on 404 and returns the verified base',async()=>{
    const {manager:m}=setup();const urls=[];
    m.fetchWithTimeout=async(url,opts)=>{urls.push(url);assert.equal(opts.headers.Authorization,'Bearer test-only');return response(urls.length===1?404:200);};
    const result=await m.testConnection('192.168.8.144:8888',{},'openai');
    assert.deepEqual(urls,['http://192.168.8.144:8888/models','http://192.168.8.144:8888/v1/models']);
    assert.equal(result.endpoint,'http://192.168.8.144:8888/v1');assert.equal(result.ok,true);
});

test('existing paths, public hosts and explicit providers never get path guesses',async()=>{
    for(const [endpoint,provider] of [['http://localhost:8000/custom','openai'],['https://example.com','openai'],['https://localhost:8000/?key=x','openai'],['http://localhost:8000','anthropic'],['localhost:11434','auto']]){
        const {manager:m}=setup();const urls=[];m.fetchWithTimeout=async url=>{urls.push(url);return response(404);};
        assert.equal((await m.testConnection(endpoint,{},provider)).ok,false);assert.equal(urls.length,1);
        if(provider==='auto') assert.equal(urls[0],'http://localhost:11434/api/tags');
    }
});

test('does not retry authorization failures, rate limits, timeouts or infer from invalid JSON shapes',async()=>{
    for(const status of [401,403,429,500]){
        const {manager:m}=setup();let calls=0;m.fetchWithTimeout=async()=>{calls++;return response(status);};
        assert.equal((await m.testConnection('localhost:8000',{},'openai')).ok,false);assert.equal(calls,1);
    }
    const {manager:m}=setup();let calls=0;
    m.fetchWithTimeout=async()=>{calls++;throw Object.assign(Error('timeout'),{name:'AbortError'});};
    assert.equal((await m.testConnection('localhost:8000',{},'openai')).errorCode,'timeout');assert.equal(calls,1);
    for(const data of [{message:'welcome'},{data:[{}]},null]){
        calls=0;m.fetchWithTimeout=async()=>response(++calls===1?404:200,data);
        const result=await m.testConnection('localhost:8000',{},'openai');assert.equal(result.ok,false);assert.equal(result.endpoint,undefined);
    }
});

test('HTTPS fallback stays HTTPS and a failed fallback is never saved',async()=>{
    const {manager:m}=setup();const urls=[];m.fetchWithTimeout=async url=>{urls.push(url);return response(urls.length===1?404:403);};
    const result=await m.testConnection('https://192.168.1.2:8000',{},'openai');
    assert.equal(urls[1],'https://192.168.1.2:8000/v1/models');assert.equal(result.endpoint,undefined);
});

test('CORS diagnosis stays on the original route without attempting /v1',async()=>{
    const {manager:m}=setup();const urls=[];
    m.fetchWithTimeout=async(url,options)=>{urls.push(url);if(options.mode==='cors')throw Error('Failed to fetch');return {};};
    assert.equal((await m.testConnection('localhost:8000',{},'openai')).errorCode,'cors');
    assert.deepEqual(urls,['http://localhost:8000/models','http://localhost:8000/models']);
});

test('library saves the verified endpoint before probing and rendering',async()=>{
    const {manager:m,scope}=setup();const model={endpoint:'192.168.8.144:8888',provider:'openai'};
    const ui=Object.create(scope.UI.prototype);ui.getArenaModel=()=>model;ui.cleanAuth=()=>({});
    m.fetchWithTimeout=async url=>response(url.endsWith('/v1/models')?200:404);
    let probe,saved,rendered;
    m.probeCapabilities=async conn=>{probe=conn.endpoint;return null;};
    ui.saveArenaConfig=()=>{saved=model.endpoint;};ui.renderArenaLibrary=()=>{rendered=model.endpoint;};
    await ui.testArenaModel(1);
    assert.equal(saved,'http://192.168.8.144:8888/v1');assert.equal(probe,saved);assert.equal(rendered,saved);
});
