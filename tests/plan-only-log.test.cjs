const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(turnBased = false) {
    const scope = { console, getCivilization: () => ({ name: 'Egyptians', color: 0xffff00 }) };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/openai-ai.js'), 'utf8'), scope);
    const Manager = vm.runInContext('OpenAIAIManager', scope);
    const manager = new Manager({});
    manager.turnBased = turnBased; manager._roundNo = 7;
    const seat = { aiPlayer: { id: 'egypt', civilization: 'egyptian' },
        model: { provider: 'ollama' }, stats: { turnsExecuted: 0, actionCounts: {} }, turnLog: [{}],
        conversationHistory: [], _moveNo: 2, _moveMs: 34500 };
    seat.seat = seat; manager.aiControllers = [seat];
    const lane = Object.create(seat);
    lane._moveNo = 3; lane._moveMs = 1200; lane.pendingLog = [];
    seat.lanes = [lane];
    const call = (name, args) => ({ type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const parse = calls => manager.parseResponse({ tool_calls: calls, finish_reason: 'tool_calls' }, lane);
    return { Manager, manager, seat, lane, call, parse };
}

for (const turnBased of [false, true]) {
    test(`plan-only turn logs exactly once with the answering lane's metadata (${turnBased ? 'round' : 'live'})`, () => {
        const { manager, seat, lane, call, parse } = setup(turnBased);
        const envelope = parse([call('plan', { objective: 'Expand', plan: ['Train workers'] })]);
        if (turnBased) {
            manager.notePipelineRescues = () => 0;
            seat.queuedAction = envelope; seat.answeringLane = lane;
            manager.flushRound([seat]);
        } else manager.executeTurn(lane, envelope);
        assert.equal(manager.decisionLog.length, 1);
        const entry = manager.decisionLog[0];
        assert.equal(entry.action, 'plan_only'); assert.equal(entry.playerId, 'egypt');
        assert.equal(entry.move, 3); assert.equal(entry.latencyMs, 1200);
        assert.equal(entry.reason, 'Expand'); assert.equal(entry.failed, false);
        assert.equal(entry.round, turnBased ? 7 : undefined);
        assert.equal(lane.pendingLog.length, 0);
        assert.equal(seat.objective, 'Expand'); assert.equal(seat.plan[0], 'Train workers');
        assert.equal(seat.stats.noActionReturns || 0, 0);
        assert.equal(seat.stats.planOnlyUpdates, 1);
        assert.match(seat.lastActionResult, /^OK - Plan saved/);
        assert.equal(seat.turnLog[0].outcome, seat.lastActionResult);
    });
}

test('a plan with an action keeps its action entry without a plan-only duplicate', () => {
    const { manager, lane, call, parse } = setup();
    const envelope = parse([call('plan', { objective: 'Expand', plan: ['Train workers'] }),
        call('wait', { reason: 'Save resources' })]);
    manager.executeTurn(lane, envelope);
    assert.equal(manager.decisionLog.length, 1);
    assert.equal(manager.decisionLog[0].action, 'wait');
    assert.equal(lane.stats.noActionReturns || 0, 0);
});

test('one plan and three game commands execute in the same turn', () => {
    const { manager, seat, lane, call, parse } = setup();
    const envelope = parse([call('plan', { objective: 'Hold position', plan: ['Save resources'] }),
        call('wait', { reason: 'First command' }), call('wait', { reason: 'Second command' }),
        call('wait', { reason: 'Third command' })]);
    manager.executeTurn(lane, envelope);
    assert.equal(seat.objective, 'Hold position');
    assert.equal(manager.decisionLog.length, 3);
    assert.equal(seat.stats.actionCounts.wait, 3);
    assert.equal(seat.stats.turnsExecuted, 1);
    assert.equal(seat.stats.noActionReturns || 0, 0);
    assert.equal(seat.stats.planOnlyUpdates || 0, 0);
});

test('successful plan-only feedback reaches the transcript with the lane identity', () => {
    const { manager, lane, call, parse } = setup();
    const results = [];
    manager.transcripts = { noteResult: (...args) => results.push(args) };
    lane.laneNo = 1;
    manager.executeTurn(lane, parse([call('plan', { plan: ['Scout the eastern edge'] })]));
    assert.equal(results.length, 1);
    assert.equal(results[0][0], 'egypt');
    assert.match(results[0][1], /^OK - Plan saved/);
    assert.equal(results[0][2], 1);
    assert.equal(manager.decisionLog[0].failed, false);
});

test('a genuinely empty turn still counts as a no-action return', () => {
    const { manager, lane } = setup();
    manager.registerNoActionReturn(lane);
    assert.equal(lane.stats.noActionReturns, 1);
    assert.match(lane.lastActionResult, /^\[ERROR\]/);
});

test('opening prompt, tool description and corrective feedback allow combined calls', () => {
    const { Manager, lane } = setup();
    const prompt = Manager.defaultSystemPrompt();
    assert.match(prompt, /plan.*ONCE AND.*3 GAME COMMANDS/);
    assert.match(prompt, /plan \+ assign_workers \+ train_unit \+ research_tech/);
    assert.match(prompt, /A plan-only turn is a successful plan update/);
    const tool = Manager.TOOLS.find(t => t.function.name === 'plan');
    assert.match(tool.function.description, /together with up to 3 game-command tools/);
    assert.match(Manager.howToAnswer(lane), /"plan" once AND up to 3/);
});

test('all four answered seats appear when one round reply contains only malformed commands',()=>{
 const h=setup(true);const seats=[];
 for(let i=0;i<4;i++){
  const c={aiPlayer:{id:'seat'+i,civilization:'egyptian'},model:{},stats:{turnsExecuted:0,actionCounts:{},invalidActions:0},turnLog:[{}],_moveNo:8,_moveMs:1000,lanes:[]};
  c.seat=c;c.conversationHistory=[];c.queuedAction=i===3?{commands:[{action:null,_unparsed:true},{action:null,_unparsed:true}]}:{action:'wait',params:{reason:'Hold'}};
  seats.push(c);
 }
 h.manager.aiControllers=seats;h.manager.notePipelineRescues=()=>0;h.manager.flushRound(seats);
 assert.equal(new Set(h.manager.decisionLog.map(e=>e.playerId)).size,4);
 assert.ok(h.manager.decisionLog.filter(e=>e.playerId==='seat3').every(e=>e.failed&&e.round===7));
});

test('queued execution exception produces a decision card and does not skip later seats',()=>{
 const h=setup(true);h.manager.notePipelineRescues=()=>0;
 h.seat.queuedAction={action:'wait'};h.manager.executeTurn=()=>{throw new Error('test failure');};
 h.manager.flushRound([h.seat]);assert.equal(h.manager.decisionLog[0].action,'tool_call_failed');
 assert.equal(h.manager.decisionLog[0].playerId,'egypt');
});

test('log revision advances even when timestamp and capped length are unchanged',()=>{
 const h=setup();h.manager.maxLogEntries=1;
 h.manager.commitDecision({playerId:'a'});const revision=h.manager.decisionLogRevision;
 h.manager.commitDecision({playerId:'b'});assert.equal(h.manager.decisionLog.length,1);
 assert.ok(h.manager.decisionLogRevision>revision);
});

test('compact log retains every seat latest round despite delayed older entries',()=>{
 const scope={console,document:{readyState:'loading',addEventListener(){}}};vm.createContext(scope);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/ui.js'),'utf8'),scope);
 const UI=vm.runInContext('UIManager',scope);const ui=Object.create(UI.prototype);
 const entries=[{playerId:'a',round:3,move:9},{playerId:'a',round:4,move:8},
 {playerId:'b',round:4,move:1},{playerId:'c',round:4,move:2},{playerId:'d',round:4,move:3}];
 const actual=ui.compactDecisionEntries(entries);assert.equal(actual.length,4);assert.ok(actual.every(e=>e.round===4));
});

for(const category of ['rate_limited','context_overflow','harness_cancelled']){
 test(`request failure path records ${category} without silently losing the round`,async()=>{
  const h=setup(true),notes=[];h.manager.transcripts={turnsFor:()=>1,note:(id,row)=>notes.push(row)};
  h.manager.buildSystemPrompt=()=>'';h.manager.buildCompactState=()=>'';h.manager.buildRollingTurns=()=>[];
  h.Manager.buildAuthHeaders=async()=>({});
  h.Manager.buildChatRequest=()=>{if(category==='harness_cancelled')h.manager._stopped=true;throw new Error(category==='rate_limited'?'API error (429)':category==='context_overflow'?'context length exceeded':'The user aborted a request.');};
  h.lane.askedInRound=7;h.seat.stats.requests=0;h.seat.stats.networkErrors=0;
  assert.equal(await h.manager.sendToOpenAI(h.lane,{}),null);
  assert.equal(notes.length,1);assert.equal(notes[0].category,category);assert.equal(notes[0].askedInRound,7);
  assert.equal(h.seat.stats.networkErrors,0);
  if(category==='harness_cancelled'){
   assert.equal(notes[0].type,'request_cancelled');assert.equal(h.seat.stats.requests,0);assert.equal(h.lane.pendingLog.length,0);
  }else{
   assert.equal(h.lane.pendingLog.length,1);assert.equal(h.manager.decisionLog.length,0);
   h.manager.notePipelineRescues=()=>0;h.manager.flushRound([h.seat]);
   assert.equal(h.manager.decisionLog[0].round,7);assert.equal(h.manager.decisionLog[0].action,'request_failed');
   assert.match(h.manager.decisionLog[0].reason,category==='rate_limited'?/rate limit/:/too large/);
  }
 });
}

for (const native of [false, true]) {
 test('excess commands are rejected individually after the first three ('+(native?'native tools':'text envelope')+')',()=>{
  const {manager,seat,lane,call,parse}=setup();
  Object.assign(seat.stats,{actionsAttempted:0,actionsRejected:0,actionsSucceeded:0});
  const commands=Array.from({length:5},(_,i)=>({action:'wait',params:{reason:'Command '+(i+1)}}));
  const envelope=native?parse([call('plan',{objective:'Hold',plan:['Wait']}),...commands.map(c=>call(c.action,c.params))]):{commands,objective:'Hold',plan:['Wait']};
  const stamps=[];manager.transcripts={noteResult:(...args)=>stamps.push(args)};
  manager.executeTurn(lane,envelope);
  assert.equal(seat.stats.actionCounts.wait,3);
  assert.equal(seat.stats.turnsExecuted,1);
  assert.equal(seat.stats.actionsAttempted,5);
  assert.equal(seat.stats.actionsRejected,2);
  assert.equal(seat.objective,'Hold');
  assert.equal(manager.decisionLog.length,5);
  const errors=manager.decisionLog.filter(e=>e.failed);
  assert.equal(errors.length,2);assert.ok(errors.every(e=>e.action==='command_limit'));
  assert.match(seat.lastActionResult,/Command 4 was not executed: maximum 3/);
  assert.match(seat.lastActionResult,/Command 5 was not executed: maximum 3/);
  assert.equal(stamps.at(-1)[1],seat.lastActionResult);
  assert.equal(seat.turnLog[0].outcome,seat.lastActionResult);
 });
}
