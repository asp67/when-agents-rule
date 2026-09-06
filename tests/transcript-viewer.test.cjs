// Exercise the real viewer/controller with a small DOM boundary double. Actual
// HTML parsing is checked separately in offline startup; browser layout/GPU time
// remains unmeasured.
const test=require('node:test'),assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function harness(count=300) {
    const stats={writes:0,layout:0,cards:0,plans:0};
    class Classes extends Set {
        contains(k){return this.has(k);}
        remove(k){this.delete(k);}
        toggle(k,on=!this.has(k)){on?this.add(k):this.delete(k);return on;}
    }
    class Element {
        constructor(classes=''){this.children=[];this.dataset={};this.style={};this.classList=new Classes(classes.split(' ').filter(Boolean));this.listeners={};this.scrollTop=0;this._text='';}
        get firstChild(){return this.children[0]||null;}
        get firstElementChild(){return this.firstChild;}
        get nextElementSibling(){return this.parentElement?.children[this.parentElement.children.indexOf(this)+1]||null;}
        get offsetTop(){stats.layout++;return (this.parentElement?.children.indexOf(this)||0)*100;}
        get offsetWidth(){stats.layout++;return 400;}
        getBoundingClientRect(){return {top:this.offsetTop};}
        get isConnected(){return !!this.parentElement;}
        set textContent(v){stats.writes++;this._text=String(v);}
        get textContent(){return this._text;}
        remove(){stats.writes++;if(this.parentElement){const list=this.parentElement.children;list.splice(list.indexOf(this),1);this.parentElement=null;}}
        insertBefore(node,before){stats.writes++;node.remove();const i=before?this.children.indexOf(before):this.children.length;assert.ok(i>=0);this.children.splice(i,0,node);node.parentElement=this;return node;}
        replaceChildren(){stats.writes++;for(const node of this.children)node.parentElement=null;this.children=[];}
        addEventListener(type,fn){this.listeners[type]=fn;}
        fire(type,target=this){this.listeners[type]?.({target});}
        scrollTo({top}){this.scrollTop=top;this.fire('scroll');}
        querySelectorAll(selector){const matches=[];const match=n=>selector==='pre'?n.tag==='pre':selector.includes('data-key=')?n.dataset.key===selector.match(/data-key="([^"]+)"/)[1]:n.classList.contains(selector.slice(1));const walk=n=>{for(const c of n.children){if(match(c))matches.push(c);walk(c);}};walk(this);return matches;}
        querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
        get innerHTML(){return this._html||'';}
        set innerHTML(html){
            stats.writes++;this._html=html;this.replaceChildren();
            // Only the structural boundary used by the viewer: a card or a late
            // result section. Text rendering remains in the real tvTurnHtml method.
            const card=html.match(/class="(tv-turn[^"]*)" data-key="([^"]+)"/);
            let parent=this;
            if(card){parent=new Element(card[1]);parent.dataset.key=card[2];this.insertBefore(parent,null);}
            for(const d of html.matchAll(/<details class="([^"]+)"([^>]*)>[\s\S]*?<pre>([\s\S]*?)<\/pre><\/details>/g)){
                const details=new Element(d[1]);details.open=/(?:^|\s)open(?:\s|$)/.test(d[2]);details.dataset.turn=d[2].match(/data-turn="([^"]+)"/)?.[1];
                const pre=new Element();pre.tag='pre';pre._text=d[3];details.insertBefore(pre,null);parent.insertBefore(details,null);
            }
            if(!card&&!this.children.length)this.insertBefore(new Element('tv-empty'),null);
        }
    }
    const ids=Object.fromEntries(['transcriptViewer','tvBody','tvTitle','tvCount','tvOlder','tvNewer','tvLatest','tvRange','tvTopBtn'].map(k=>[k,new Element()]));
    const document={getElementById:id=>ids[id]||null,createElement:()=>new Element()};
    const context=vm.createContext({document,console,window:{},t:k=>k,getUiLang:()=> 'en'});
    vm.runInContext(fs.readFileSync(path.join(root,'js/ui.js'),'utf8')+'\nthis.UIManager=UIManager;',context);
    const make=(turn,seat='one')=>({turn,at:turn*1000,name:seat,assistant:{reasoning:'reason '.repeat(100),content:'reply'},parsed:turn===1?{objective:'Hold the coast'}:{},state:{units:[{id:turn}]},harnessResult:null});
    const rings={one:Array.from({length:count},(_,i)=>make(i+1)),two:[make(1,'two')]};
    const recorder={recent:id=>rings[id]?.slice()||[]};
    const game={running:true,simSpeed:2,openAIAIManager:{transcripts:recorder,decisionLog:[]},aiManager:{aiPlayers:[]}};
    const ui=Object.create(context.UIManager.prototype);Object.assign(ui,{game,_transcriptFor:'one',teamDotHtml:()=>'',updateSpectatorPlayerList:()=>{}});
    const html=ui.tvTurnHtml,carry=ui.tvCarryPlan;
    ui.tvTurnHtml=function(...args){stats.cards++;return html.apply(this,args);};
    ui.tvCarryPlan=function(...args){stats.plans++;return carry.apply(this,args);};
    return {ui,ids,stats,rings,make,game,keys:()=>ids.tvBody.children.map(n=>Number(n.dataset.key))};
}

test('opening a full recorder mounts eight turns; unchanged polling does no rendering or layout work',()=>{
    const h=harness();h.ui.renderTranscriptViewer();
    assert.equal(h.stats.cards,8);assert.equal(h.ids.tvBody.children.length,8);
    assert.deepEqual(h.keys(),[300,299,298,297,296,295,294,293]);
    const before={...h.stats};for(let i=0;i<20;i++)h.ui.renderTranscriptViewer();
    assert.deepEqual(h.stats,before);assert.equal(h.rings.one.length,300);
    assert.equal(h.game.running,true);assert.equal(h.game.simSpeed,2);
    assert.match(h.ids.tvBody.innerHTML||h.ui.tvPlanText(h.rings.one.at(-1)),/Hold the coast/);
});

test('older pages expose the full ring and remain stable while new turns arrive',()=>{
    const h=harness();h.ui.renderTranscriptViewer();const seen=new Set(h.keys());
    while(!h.ids.tvOlder.disabled){h.ui.tvPage(-1);h.keys().forEach(k=>seen.add(k));assert.ok(h.keys().length<=8);}
    assert.equal(seen.size,300);assert.ok(h.ids.tvOlder.disabled);
    h.ui.tvPage(1);const reading=h.keys(),node=h.ids.tvBody.firstChild;h.ids.tvBody.scrollTop=42;
    h.rings.one.push(h.make(301));h.rings.one.shift();h.ui.renderTranscriptViewer();
    assert.deepEqual(h.keys(),reading);assert.equal(h.ids.tvBody.firstChild,node);assert.equal(h.ids.tvBody.scrollTop,42);
    h.ui.scrollTranscriptTop();assert.equal(h.keys()[0],301);assert.equal(h.ids.tvBody.scrollTop,0);
});

test('live arrivals reuse existing cards and their nested reading positions',()=>{
    const h=harness();h.ui.renderTranscriptViewer();const node=h.ids.tvBody.firstChild;
    const pre=node.querySelector('.tv-reply').querySelector('pre');pre.scrollTop=37;
    const before=h.stats.cards;h.rings.one.push(h.make(301));h.rings.one.shift();h.ui.renderTranscriptViewer();
    assert.equal(h.stats.cards,before+1);assert.equal(h.ids.tvBody.children[1],node);assert.equal(pre.scrollTop,37);
    h.ids.tvBody.scrollTop=50;h.ids.tvBody.fire('scroll');const reading=h.keys();
    assert.equal(h.ids.tvLatest.disabled,false);
    h.rings.one.push(h.make(302));h.rings.one.shift();h.ui.renderTranscriptViewer();
    assert.deepEqual(h.keys(),reading);assert.equal(h.ids.tvBody.scrollTop,50);
    h.ui.scrollTranscriptTop();assert.equal(h.keys()[0],302);
});

test('late harness results update their section without rebuilding the turn',()=>{
    const h=harness();h.ui.renderTranscriptViewer();const node=h.ids.tvBody.firstChild;
    h.rings.one.at(-1).harnessResult='[ERROR] blocked';h.ui.renderTranscriptViewer();
    assert.equal(h.ids.tvBody.firstChild,node);assert.equal(h.stats.cards,8);
    assert.equal(node.querySelector('.tv-result').querySelector('pre').textContent,'[ERROR] blocked');
    assert.ok(node.classList.contains('is-error'));
    h.rings.one.at(-1).harnessResult='Done';h.ui.renderTranscriptViewer();
    assert.equal(node.querySelector('.tv-result').querySelector('pre').textContent,'Done');assert.ok(!node.classList.contains('is-error'));
});

test('decision-log jumps directly mount the target page and keep it pinned',()=>{
    const h=harness();h.game.openAIAIManager.decisionLog=[{_uid:7,playerId:'one',timestamp:42001}];
    h.ui.openTranscriptAt(7);assert.equal(h.stats.cards,8);assert.equal(h.keys()[0],42);assert.equal(h.ui._tvPinned,42);
    h.rings.one.push(h.make(301));h.rings.one.shift();h.ui.renderTranscriptViewer();assert.equal(h.keys()[0],42);
});

test('state expansion is bounded to the page; preferences survive switching seats and closing frees cards',()=>{
    const h=harness();h.ui.renderTranscriptViewer();
    const state=h.ids.tvBody.firstChild.querySelector('.tv-state');state.open=true;h.ids.tvBody.fire('toggle',state);
    const open=h.ids.tvBody.querySelectorAll('.tv-state');assert.equal(open.length,8);
    assert.ok(open.every(d=>d.open && d.querySelector('pre').dataset.filled==='1'));
    assert.ok(h.ui.tvSectionPrefs()['tv-state']);
    h.ui.toggleTranscriptViewer('two');assert.equal(h.keys().length,1);assert.ok(h.ids.tvBody.firstChild.querySelector('.tv-state').open);
    h.ui.toggleTranscriptViewer('two');assert.equal(h.ids.tvBody.children.length,0);assert.equal(h.ids.transcriptViewer.style.display,'none');
});

test('empty rings, ring eviction and replacement recorders recover without exceeding the page budget',()=>{
    const h=harness(0);h.ui.renderTranscriptViewer();assert.equal(h.stats.cards,0);assert.ok(h.ids.tvOlder.disabled);
    h.rings.one.push(...Array.from({length:20},(_,i)=>h.make(i+1)));h.ui.renderTranscriptViewer();h.ui.tvPage(-1);
    h.rings.one=Array.from({length:300},(_,i)=>h.make(i+100));h.ui.renderTranscriptViewer();
    assert.equal(h.keys()[0],107);assert.equal(h.keys().at(-1),100);assert.ok(h.ids.tvOlder.disabled);
    h.game.openAIAIManager.transcripts={recent:()=>[h.make(1)]};h.ui.renderTranscriptViewer();assert.deepEqual(h.keys(),[1]);
});
