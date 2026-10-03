// Local sound prototype. All waveforms are synthesized here; no external audio.
// Own PRNG and wall clock: presentation must not consume simulation randomness/time.
class WarAudio {
    constructor(game) {
        this.game = game;
        this.enabled = false; // AudioContext needs a gesture before it may sound
        // Unmuted by default (b1023): sound starts with the first click or key press
        // unless the viewer muted it first. One-use handoff for our own scene/menu
        // navigation keeps a mute across it; a reload starts unmuted again.
        let handoff = null;
        try {
            handoff = sessionStorage.getItem('warAudioNavigation');
            sessionStorage.removeItem('warAudioNavigation');
        } catch (_) {}
        this.chosen = handoff === 'off';   // a mute (or unmute) the viewer chose themselves
        // Effects at .336 (b1023: 0.8 of b1011's .42, itself 30 % below .6); ambience
        // at half of b1011's .45.
        this.levels = {master: .45, ambience: .225, effects: .336, work: 1, movement: 1};
        try {
            const saved = JSON.parse(localStorage.getItem('warAudioLevelsV1'));
            // Moving any one slider saves all five, so an untouched effects or ambience
            // was stored at its old default. That value is read as "default", not as a
            // choice: the new default applies. A level set on purpose is kept.
            const oldDefault = {ambience: [.45], effects: [.6, .42]};
            for (const key of Object.keys(this.levels)) if (Number.isFinite(saved?.[key]) && !(oldDefault[key] || []).includes(saved[key]))
                this.levels[key] = Math.max(0, Math.min(1, saved[key]));
        } catch (_) {}
        this.seed = 0x574152;
        this.voices = new Set();
        this.cells = new Map();
        this.positions = new WeakMap();
        this.recent = [];
        this.notices = new Map(); this.eliminations = new WeakSet(); this.wonderStages = new WeakMap();
        this.diagnostics = {played:0, suppressed:{}};
        this.nextUpdate = 0;
        this.nextCrackle = 0;
        this.wasActive = false;
        this.onVisibility = () => {
            if (!this.ctx) return;
            if (document.hidden) { this.silence(); this.ctx.suspend().catch(() => {}); }
            else if (this.enabled) this.ctx.resume().catch(() => {});
        };
        document.addEventListener('visibilitychange', this.onVisibility);
        // Browsers may suspend audio across document navigation until a gesture.
        const gesture = () => {
            if(this.enabled && this.ctx?.state==='suspended') this.ctx.resume().catch(()=>{});
            else if(!this.enabled && !this.chosen) this.setEnabled(true, false).catch(()=>{});
        };
        document.addEventListener('pointerdown', gesture);
        document.addEventListener('keydown', gesture);
        if(handoff==='on') this.setEnabled(true, false).catch(()=>{});
    }

    preserveForNavigation() {
        // 'off' only for a mute the viewer chose: a page still waiting for its first
        // gesture hands on nothing, and the next page starts unmuted.
        try { sessionStorage.setItem('warAudioNavigation',this.enabled?'on':this.chosen?'off':''); } catch (_) {}
    }

    random() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
    ramp(param, value, seconds = .18) {
        // Web Audio rejects NaN, Infinity and values outside a float32. Audio
        // must never let a malformed spatial value interrupt the simulation.
        if (!Number.isFinite(value) || Math.abs(value) > 3.402823466e38) {
            this.suppressed('invalidParameter'); value = 0;
        }
        if (!Number.isFinite(seconds) || seconds <= 0) seconds = .18;
        const now = this.ctx.currentTime;
        param.cancelScheduledValues(now);
        param.setTargetAtTime(value, now, seconds);
    }
    setLevel(key, value) {
        if (!Object.hasOwn(this.levels, key)) return;
        const n = Number(value);
        if (!Number.isFinite(n)) return;
        this.levels[key] = Math.max(0, Math.min(1, n));
        try { localStorage.setItem('warAudioLevelsV1', JSON.stringify(this.levels)); } catch (_) {}
        if (this.ctx) {
            this.ramp(this.ambience.gain, this.levels.ambience);
            this.ramp(this.effects.gain, this.levels.effects * 2);
            if (this.workBus) this.ramp(this.workBus.gain, this.levels.work);
            if (this.moveBus) this.ramp(this.moveBus.gain, this.levels.movement);
            this.ramp(this.master.gain, this.active() ? this.levels.master : 0);
        }
    }

    // `chosen`: the viewer's own switch. The default start on the first gesture is not
    // one, so it never overrides a mute the viewer set before it.
    async setEnabled(value, chosen = true) {
        if (chosen) this.chosen = true;
        this.enabled = !!value;
        if (!this.enabled) { if (this.ctx) { this.silence(); await this.ctx.suspend(); } return; }
        try {
            if (!this.ctx) this.init();
            await this.ctx.resume();
            if (!this.enabled) await this.ctx.suspend();
            if (this.enabled && this.ctx.state !== 'running') throw Error('Audio unavailable');
        } catch (error) {
            this.enabled = false;
            if (this.ctx) this.silence();
            throw error;
        }
    }

    init() {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) throw Error('Web Audio unavailable');
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain(); this.master.gain.value = 0;
        // Peak control is a safety net, not a replacement for quiet source levels.
        this.limiter = this.ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -9; this.limiter.knee.value = 6;
        this.limiter.ratio.value = 12; this.limiter.attack.value = .003; this.limiter.release.value = .15;
        // 50% master volume now matches the previous 100% level.
        this.outputGain = this.ctx.createGain(); this.outputGain.gain.value = 8;
        this.master.connect(this.outputGain); this.outputGain.connect(this.limiter);
        this.limiter.connect(this.ctx.destination);
        this.ambience = this.ctx.createGain(); this.effects = this.ctx.createGain();
        // Extra effects boost only; ambience retains its existing volume scale.
        this.ambience.gain.value = this.levels.ambience; this.effects.gain.value = this.levels.effects * 2;
        this.ambience.connect(this.master); this.effects.connect(this.master);
        // Work (chopping, harvesting, mining, building) and movement (footsteps, hooves)
        // each get a bus of their own, inside ambience and effects, so either can be
        // turned down alone (review #12).
        this.workBus = this.ctx.createGain(); this.workBus.gain.value = this.levels.work; this.workBus.connect(this.ambience);
        this.moveBus = this.ctx.createGain(); this.moveBus.gain.value = this.levels.movement; this.moveBus.connect(this.effects);
        // No synthesis on the click that unmutes (review #12). Making all 116 sounds here
        // froze the page for ~3.4 s. Each variant is now made the first time it is played
        // (or in idle time, see warm), from the PRNG state it would have started from in
        // the old eager order, so every sound is bit-identical to before.
        this.buffers = {};
        for (const kind of WarAudio.KINDS) this.buffers[kind] = this.lazyVariants(kind);
        this.seed = WAR_AUDIO_SEEDS.after;   // what play draws from, exactly as before
        this.noticeTurn = {};
        this.wind = null; this.fire = null;
        // The ambience loops a moment later, off the click (they fade in anyway).
        setTimeout(() => this.startAmbience(), 0);
    }
    startAmbience() {
        if (!this.ctx || this.wind) return;
        this.wind = this.loop('wind', 850);
        this.fire = this.loop('fire', 2300);
        this.warm();
    }

    // Four variants of a sound, each synthesized the first time anything reads it.
    lazyVariants(kind) {
        const made = [], variants = [];
        for (let i = 0; i < 4; i++) Object.defineProperty(variants, i, { enumerable: true,
            get: () => made[i] || (made[i] = this.seeded(WAR_AUDIO_SEEDS[kind][i], () => this.makeBuffer(kind))) });
        Object.defineProperty(variants, 'ready', { value: i => !!made[i] });
        return variants;
    }
    // Run fn from a given PRNG state and put the running state back afterwards, so
    // making a buffer late never changes what play draws next.
    seeded(seed, fn) {
        const saved = this.seed;
        this.seed = seed;
        try { return fn(); } finally { this.seed = saved; }
    }
    // Make the rest while the page is idle, announcements first: one buffer per slice,
    // so no single frame pays for more than one sound.
    warm() {
        const order = ['start','command','commandAction','built','research','trained','warning','elimination','wonderLost','victory','defeat','ageUp','underAttack'];
        const queue = [];
        for (const kind of order.concat(WarAudio.KINDS.filter(k => !order.includes(k)))) {
            if (!this.buffers[kind]) continue;
            for (let i = 0; i < 4; i++) queue.push([kind, i]);
        }
        if (typeof requestIdleCallback !== 'function') return;   // no idle time to use: first use makes them
        const idle = cb => requestIdleCallback(cb, { timeout: 1500 });
        const next = () => {
            if (!this.ctx || !this.enabled) return;   // muted: what is missing is made on first use
            const item = queue.shift();
            if (!item) return;
            const [kind, i] = item;
            // Warming is a courtesy: if a device refuses, the sound is made on first use.
            try { if (!this.buffers[kind].ready(i)) void this.buffers[kind][i]; } catch (e) { return; }
            idle(next);
        };
        idle(next);
    }

    // The PRNG state each buffer begins from, in the order the old eager init made them:
    // four variants of every kind, then the wind and fire loops, then what was left for
    // play. With these, any buffer can be made on its own, later, and come out
    // bit-identical (review #12). tests/audio-lazy.test.cjs regenerates this table and
    // fails if WAR_AUDIO_SEEDS no longer matches it.
    recordSeeds() {
        const table = {};
        this.seed = WarAudio.SEED0;
        for (const kind of WarAudio.KINDS) {
            table[kind] = [];
            for (let i = 0; i < 4; i++) { table[kind].push(this.seed); this.makeBuffer(kind); }
        }
        table.wind = this.seed; this.makeBuffer('wind');
        table.fire = this.seed; this.makeBuffer('fire');
        table.after = this.seed;
        return table;
    }
    static get SEED0() { return 0x574152; }
    static get KINDS() { return ['step','snow','gravel','hoof','hoofSnow','hoofGravel','bow','crossbow','impact','steel','stone','crackle','chop','harvest','mine','build','built','research','trained','collapse','wonderLost','heal','command','commandAction','start','elimination','victory','defeat','warning','ageUp','underAttack']; }

    makeBuffer(kind) {
        const rate = 24000;
        // Event fanfares share the horn timbre but have their own higher register
        // and rhythm. Routine completion calls retain their established phrasing.
        const fanfare={
            start:{notes:[392,587,392,587],beats:[1,1.25,1,1.25],duration:1.15},
            elimination:{notes:[440,392,330],beats:[.8,.8,1.5],duration:.9},
            victory:{notes:[494,494,494,784],beats:[1.4,.6,.6,1.4],duration:1.24},
            defeat:{notes:[440,392,330,294],beats:[1,.65,.85,1.8],duration:1.35},
            // A rising call for a new age; a low, urgent double blast when your own are hit.
            ageUp:{notes:[262,330,392,523],beats:[.7,.7,.7,1.6],duration:1.05},
            underAttack:{notes:[196,196,147],beats:[.55,.55,1.5],duration:.95}
        }[kind];
        const duration = fanfare?.duration ?? {wind:8,fire:8,step:.28,snow:.34,gravel:.32,hoof:.28,hoofSnow:.34,hoofGravel:.32,bow:.20,crossbow:.16,impact:.24,steel:.55,stone:.33,crackle:.55,chop:.38,harvest:.55,mine:.18,build:.42,built:.425,research:.55,trained:.35,collapse:1.15,wonderLost:1.6,heal:.8,command:.65,commandAction:.65,start:.825,elimination:.6,victory:1.35,defeat:1.125,warning:.55}[kind];
        const buffer = this.ctx.createBuffer(1, Math.ceil(duration * rate), rate);
        const data = buffer.getChannelData(0);
        const softTexture = ['step','snow','gravel','hoof','hoofSnow','hoofGravel','chop','harvest','mine','bow','impact','steel','stone','build','built','research','trained','collapse','wonderLost','heal','command','commandAction','start','elimination','victory','defeat','warning','ageUp','underAttack'].includes(kind);
        let low = 0, slower = 0, muffled = 0, smooth = 0;
        const pitch = .9 + this.random() * .2;
        const notes = fanfare?.notes ?? {research:[262,392],built:[196,262],trained:[294],heal:[174,220],command:[196],start:[196,262,330],elimination:[262,196],victory:[196,247,294,392],defeat:[247,196,147],warning:[220,294]}[kind];
        const brass = ['built','research','trained','start','elimination','victory','defeat','warning','ageUp','underAttack'].includes(kind);
        // Reserve a short resonant tail inside the existing announcement length.
        const hornTail=brass?Math.min(.16,duration*.20):0;
        const hornEnd=duration-hornTail;
        const brassStep=brass?hornEnd/(notes.length+.5):0;
        // Reference-informed harmonic balance, not sampled audio: a dominant body
        // with progressively weaker overtones, rather than odd-only reed colouring.
        const hornSpectrum=[1,.40,.25,.19,.095,.060,.037,.024,.015,.010];
        const fanfareBeats=fanfare?.beats.reduce((sum,beat)=>sum+beat,0);
        const hornNotes=brass?notes.map((hz,n)=>({
            phase:0, air:0, airLow:0,
            start:(fanfare?hornEnd*fanfare.beats.slice(0,n).reduce((sum,beat)=>sum+beat,0)/fanfareBeats:n*brassStep)
                +(n?(this.random()-.5)*.004:0),
            length:fanfare?hornEnd*fanfare.beats[n]/fanfareBeats-.008:null,
            attack:.030+this.random()*.010,
            strength:.93+this.random()*.12,
            tuning:1+(this.random()-.5)*.004,
            // Smooth irregular breath motion instead of repeating keyboard vibrato.
            breath:Array.from({length:Math.ceil(duration*24)+3},()=>this.random()*2-1)
        })):null;
        // Independent wood snaps, with air between them, rather than one long
        // low-passed noise hit (which resembles a muffled snare drum).
        let snapAt=0;
        const snaps=kind==='crackle'?Array.from({length:3+Math.floor(this.random()*3)},()=>{
            const snap={at:snapAt,decay:.002+this.random()*.005,level:.12+this.random()*.2};
            snapAt+=.025+this.random()*.085;return snap;
        }):[];
        for (let i = 0; i < data.length; i++) {
            const t = i / rate, noise = this.random() * 2 - 1;
            low += .12 * (noise - low); slower += .014 * (noise - slower);
            const envelope = Math.min(1, t / .006) * Math.exp(-t * (kind === 'stone' ? 13 : 26));
            const softEnvelope = Math.sin(Math.min(1,t/.045)*Math.PI/2)**2 * Math.exp(-t*14);
            let v = 0;
            if (kind === 'wind') v = slower * 2 + low * .15;
            else if (kind === 'fire') v = (noise-low)*.025 + low*.08;
            else if (kind === 'step' || kind === 'hoof')
                v = (low*.55 + slower*.22) * softEnvelope
                    + (noise-low)*.10*Math.sin(Math.PI*t/duration)**2*Math.exp(-t*9);
            else if (kind === 'snow' || kind === 'hoofSnow')
                v = (low*.85 + slower*.45) * softEnvelope
                    + low*.25*Math.sin(Math.PI*t/duration)**2;
            else if (kind === 'gravel' || kind === 'hoofGravel') {
                const grains=.35+.65*Math.sin(t*183+Math.sin(t*71)*2)**8;
                v=(low*.55+slower*.18)*softEnvelope
                    +(noise-low)*.30*grains*Math.sin(Math.min(1,t/.018)*Math.PI/2)**2*Math.exp(-t*18);
            }
            else if (kind === 'bow') v = (low * .65 + Math.sin(t * 2 * Math.PI * (220 * pitch - 70*t)) * .035) * softEnvelope;
            else if (kind === 'crossbow') {
                // A short latch click with a muted string/body snap.
                const latch=Math.sin(Math.min(1,t/.002)*Math.PI/2)**2;
                v=latch*((noise-low)*.20*Math.exp(-t*150)
                    +Math.sin(2*Math.PI*1850*pitch*t)*.11*Math.exp(-t*95)
                    +Math.sin(2*Math.PI*340*pitch*t)*.07*Math.exp(-t*42));
            }
            else if (kind === 'impact') v = (low * 1.1 + slower * .3 +
                Math.sin(t * 2 * Math.PI * 210 * pitch) * .075) * softEnvelope;
            else if (kind === 'steel') {
                // Inharmonic blade resonances ring beyond the initial contact.
                // A close pair adds the slight beating of two vibrating blades.
                const strike=Math.sin(Math.min(1,t/.0015)*Math.PI/2)**2;
                v=strike*(Math.sin(2*Math.PI*2576*pitch*t)*.11*Math.exp(-t*9)
                    +Math.sin(2*Math.PI*2628.8*pitch*t)*.055*Math.exp(-t*12)
                    +Math.sin(2*Math.PI*3956.8*pitch*t)*.085*Math.exp(-t*14)
                    +Math.sin(2*Math.PI*5744*pitch*t)*.055*Math.exp(-t*21)
                    +Math.sin(2*Math.PI*7792*pitch*t)*.025*Math.exp(-t*32)
                    +(noise-low)*.065*Math.exp(-t*180));
            }
            else if (kind === 'stone') v = (low * 1.3 + Math.sin(t * 2 * Math.PI * 75 * pitch) * .16) * softEnvelope;
            else if (kind === 'crackle') {
                for(const snap of snaps){
                    const age=t-snap.at;
                    if(age>=0&&age<snap.decay*6)
                        v+=(noise-low*.7)*snap.level*Math.min(1,age/.0008)*Math.exp(-age/snap.decay);
                }
            }
            else if (kind === 'chop') {
                // The former mining texture has the woody body of a small axe.
                const strike=Math.sin(Math.min(1,t/.0045)*Math.PI/2)**2;
                v=strike*((low*.8+noise*.10)*Math.exp(-t*95)
                    +Math.sin(t*2*Math.PI*1350*pitch)*.12*Math.exp(-t*65)
                    +Math.sin(t*2*Math.PI*540*pitch)*.065*Math.exp(-t*32));
            }
            else if (kind === 'mine') {
                // A miniature pick: light, dry and brief, without the axe's low body.
                const strike=Math.sin(Math.min(1,t/.0025)*Math.PI/2)**2;
                v=strike*((noise*.18+low*.25)*Math.exp(-t*180)
                    +Math.sin(t*2*Math.PI*2200*pitch)*.075*Math.exp(-t*125)
                    +Math.sin(t*2*Math.PI*890*pitch)*.025*Math.exp(-t*90));
            }
            else if (kind === 'build') v = (low*.7 + Math.sin(t*2*Math.PI*145*pitch)*.085)*softEnvelope;
            else if (kind==='collapse'||kind==='wonderLost') v=(slower*2+low*.6)*Math.sin(Math.PI*t/duration)**2*Math.exp(-t*2);
            else if (kind==='command'||kind==='commandAction') {
                // One light clapper strike on a small service handbell. Closely
                // spaced shell modes shimmer while the upper partials fade away.
                const hz=(kind==='commandAction'?1628:1450)*1.25;
                const onset=Math.sin(Math.min(1,t/.004)*Math.PI/2)**2;
                v=onset*(Math.sin(2*Math.PI*hz*t)*.095*Math.exp(-t*6)
                    +Math.sin(2*Math.PI*hz*1.006*t)*.04*Math.exp(-t*8)
                    +Math.sin(2*Math.PI*hz*2.71*t)*.055*Math.exp(-t*15)
                    +Math.sin(2*Math.PI*hz*3.93*t)*.022*Math.exp(-t*24)
                    +(noise-low)*.012*Math.exp(-t*180));
            }
            else if (notes) {
                for(let n=0;n<notes.length;n++) {
                    const age=t-n*(brass?brassStep:.18);
                    if(brass) {
                        const note=hornNotes[n], played=t-note.start;
                        const length=note.length??(n===notes.length-1?hornEnd-note.start:brassStep-.006);
                        if(played<0||played>=length)continue;
                        const attack=Math.sin(Math.min(1,played/note.attack)*Math.PI/2)**2;
                        const release=Math.sin(Math.min(1,(length-played)/.045)*Math.PI/2)**2;
                        const cursor=played*24,index=Math.floor(cursor),fraction=cursor-index;
                        const blend=fraction*fraction*(3-2*fraction);
                        const breathMotion=note.breath[index]*(1-blend)+note.breath[index+1]*blend;
                        // The reference briefly struggles in a lower register before
                        // the lips lock onto the main note. Keep that gesture miniature.
                        const settling=-.18*Math.exp(-played/.017);
                        note.phase+=2*Math.PI*notes[n]*.96*(fanfare?1.25:1)*note.tuning
                            *(1+settling+breathMotion*.007)/rate;
                        const pressure=attack*release*note.strength*(1+breathMotion*.13);
                        let body=0;
                        for(let h=1;h<=hornSpectrum.length;h++) {
                            const colour=Math.exp(-(h-1)*(1-pressure)*.22);
                            body+=Math.sin(note.phase*h)*hornSpectrum[h-1]*colour;
                        }
                        const lipBreak=Math.sin(note.phase*2/3)*.22*Math.exp(-played/.028);
                        note.air+=.30*(noise-note.air);
                        note.airLow+=.055*(note.air-note.airLow);
                        const breath=(note.air-note.airLow)*(.012+.065*Math.exp(-played/.035));
                        v+=pressure*((body+lipBreak)*.14+breath);

                    }
                    else if(age>=0) v += Math.sin(2*Math.PI*notes[n]*age)*.09
                        * Math.sin(Math.min(1,age/.065)*Math.PI/2)**2 * Math.exp(-age*5);
                }
            }
            else if (kind === 'harvest') v = low*.48*Math.sin(Math.PI*t/duration)**2;
            // Two gentle low-pass stages remove hard noise edges from the everyday
            // sounds. No click/thump oscillator in footsteps, even mid-envelope.
            // Hooves keep the same gentle surface texture at their faster cadence.
            if(kind.startsWith('hoof'))v*=.8;
            if (softTexture) {
                const cutoff=['command','commandAction'].includes(kind)?.6:brass?.65:kind==='crossbow'?.45:kind==='steel'?.8:kind==='mine'?.5:kind==='chop'?.32:.19;
                muffled += cutoff*(v-muffled); smooth += cutoff*(muffled-smooth);
                v=brass?(v+smooth)*.5:smooth; // Half-strength muffling for horns.
            }
            // Fade sample tails; looping textures have a short seam crossfade below.
            data[i] = v * Math.min(1, (duration-t) / .018);
        }
        if(brass) {
            // Small diffuse reflections supply the trailing bloom of a horn blast.
            // Baked once into each buffer: no extra live voices or runtime reverb.
            const dry=data.slice();
            const delays=[.023,.031,.043,.059].map(seconds=>({
                samples:new Float32Array(Math.round(seconds*rate)),position:0,low:0
            }));
            for(let i=0;i<data.length;i++) {
                let room=0;
                for(const tap of delays) {
                    const echo=tap.samples[tap.position];
                    tap.low+=.35*(echo-tap.low);
                    const softened=(echo+tap.low)*.5;
                    tap.samples[tap.position]=dry[i]+softened*.58;
                    tap.position=(tap.position+1)%tap.samples.length;
                    room+=softened;
                }
                data[i]=(dry[i]*.88+room*.11)*Math.min(1,(data.length-1-i)/(.025*rate));
            }
        }
        if(['crossbow','steel','chop','harvest','mine','build','built','research','trained','collapse','wonderLost','heal','command','commandAction','start','elimination','victory','defeat','warning'].includes(kind)) {
            let sum=0, peak=0,jump=0,previous=0;for(const v of data){sum+=v*v;peak=Math.max(peak,Math.abs(v));jump=Math.max(jump,Math.abs(v-previous));previous=v;}
            const level=kind==='heal'?.028:.055;
            const boost=Math.min(4,level/(Math.sqrt(sum/data.length)||1),.45/(peak||1),(kind==='steel'?.10:.035)/(jump||1));
            // The sustained harvesting rustle carries much more average energy
            // than short work impacts. Balance it after normalization, including samples.
            for(let i=0;i<data.length;i++)data[i]*=boost*(kind==='harvest'?.25:1);
        }
        if (kind === 'wind' || kind === 'fire') {
            const seam = 2400;
            for (let i=0;i<seam;i++) {
                const blend=i/seam;
                data[data.length-seam+i] = data[data.length-seam+i]*(1-blend)+data[i]*blend;
            }
            // The loop wraps to the end of the blended intro, not its beginning.
            buffer._loopStart = seam / rate;
        }
        if(brass) {
            // Distant, progressively muffled answers to the horn. Bake them into
            // the same voice so mute, spatial audio and notification limits apply.
            // 20% shorter than build 888; compensating lip frequency above keeps
            // the horn's settled pitch unchanged while the phrase/echoes shorten.
            const echoed=this.ctx.createBuffer(1,data.length+Math.round(.48*rate),rate/1.2);
            const out=echoed.getChannelData(0);out.set(data);
            for(const [delay,level,cutoff] of [[.16,.25,.24],[.32,.12,.16],[.48,.055,.11]]) {
                const offset=Math.round(delay*rate);let filtered=0;
                for(let i=0;i<data.length;i++) {
                    filtered+=cutoff*(data[i]-filtered);
                    out[i+offset]+=(data[i]+filtered)*.5*level;
                }
            }
            for(let i=Math.max(0,out.length-Math.round(.02*rate));i<out.length;i++)
                out[i]*=(out.length-1-i)/(.02*rate);
            // Overlapping echoes must retain the same gentle peak/edge limits.
            let peak=0,jump=0;
            for(let i=0;i<out.length;i++) {
                peak=Math.max(peak,Math.abs(out[i]));
                if(i)jump=Math.max(jump,Math.abs(out[i]-out[i-1]));
            }
            const trim=Math.min(1,.45/(peak||1),.035/(jump||1));
            if(trim<1)for(let i=0;i<out.length;i++)out[i]*=trim;
            return echoed;
        }
        return buffer;
    }

    loop(kind, frequency) {
        const source=this.ctx.createBufferSource(), filter=this.ctx.createBiquadFilter();
        const gain=this.ctx.createGain(), pan=this.ctx.createStereoPanner();
        source.buffer=this.seeded(WAR_AUDIO_SEEDS[kind],()=>this.makeBuffer(kind));source.loop=true;source.loopStart=source.buffer._loopStart || 0;
        filter.type='lowpass';filter.frequency.value=frequency;gain.gain.value=0;
        source.connect(filter);filter.connect(gain);gain.connect(pan);pan.connect(this.ambience);source.start();
        return {source,filter,gain,pan};
    }

    active() {
        return this.enabled && !document.hidden && !!this.game.gameStarted
            && this.game.pauseState !== 'paused' && !this.game.renderer?.replayMode
            && !!document.getElementById('gameScreen')?.classList.contains('active');
    }
    visible(entity) {
        if (!entity || entity.mesh?.visible === false || (entity.health != null && entity.health <= 0)) return false;
        if (entity.audioPreview && this.game._showcaseCivilization) return true;
        const fow=this.game.fogOfWar;
        // Spectators see every living entity. Players must have current vision;
        // explored land alone must not reveal new enemy activity through sound.
        return !!this.game.spectatorMode || !fow || fow.isPositionCurrentlyVisible(entity.x,entity.z);
    }
    spatial(entity) {
        const r=this.game.renderer, camera=r?.cameraTarget;
        const half=r?._halfH ?? 80, yaw=r?._yaw ?? 0;
        if (![entity?.x,entity?.z,camera?.x,camera?.z,half,yaw].every(Number.isFinite) || half<=0)
            return {gain:0,pan:0,invalid:true};
        const dx=entity.x-camera.x,dz=entity.z-camera.z;
        const distance=Math.hypot(dx,dz), radius=Math.min(150,Math.max(45,half*1.7));
        const gain=Math.max(0,1-distance/radius)**2 * Math.min(1,65/half);
        const pan=Math.max(-.85,Math.min(.85,(dx*Math.cos(r._yaw||0)-dz*Math.sin(r._yaw||0))/Math.max(25,half)));
        return Number.isFinite(gain)&&Number.isFinite(pan)?{gain,pan}:{gain:0,pan:0,invalid:true};
    }
    movementCadence() {
        const speed=this.game.effectiveSimSpeed?.() ?? this.game.simSpeed ?? 1;
        return speed>=4?2:speed>=2?1.5:speed>=1.5?1.25:1;
    }
    allow(kind,entity,now) {
        const cell=kind+':'+Math.floor(entity.x/14)+':'+Math.floor(entity.z/14);
        // Chopping and mining every 0.5 s (b1038, one gap for both in b1039): the gap is per
        // kind per 14-unit cell, so twenty miners on one node used to share one click a second.
        const spacing=['step','snow','gravel'].includes(kind) ? .42/this.movementCadence() : kind.startsWith('hoof') ? .28/this.movementCadence()
            : kind==='chop' || kind==='mine' ? .5 : kind==='harvest' ? 1.6 : kind==='build' ? 1.25 : kind==='heal' ? 1.8 : ['built','research','trained','collapse','wonderLost','heal','command','commandAction','start','elimination','victory','defeat','warning'].includes(kind) ? 1 : .11;
        if (now-(this.cells.get(cell) ?? -Infinity)<spacing) return false;
        this.recent=this.recent.filter(t=>now-t<1);
        if(this.recent.length>=18 || [...this.voices].filter(v=>!v.notice).length>=12) return this.suppressed('worldBudget');
        this.cells.set(cell,now);this.recent.push(now);
        return true;
    }
    suppressed(reason) { this.diagnostics.suppressed[reason]=(this.diagnostics.suppressed[reason]||0)+1; return false; }
    emit(kind,entity,volume=.35) {
        if(!this.ctx || !this.active() || this.ctx.state!=='running') return this.suppressed('inactiveOrMuted');
        if(!this.visible(entity))return this.suppressed('visibility');
        if(!Number.isFinite(volume) || volume<0 || volume>3.402823466e38)return this.suppressed('invalidVolume');
        const moving=['step','snow','gravel','hoof','hoofSnow','hoofGravel'].includes(kind);
        if(moving){
            volume*=.375;
            // Habituation, for movement only: the ear stops hearing a march that goes on
            // and on, so steps grow quieter the more of them there have just been, down
            // to half, and recover within seconds of quiet (review #12).
            const now0=this.ctx.currentTime, since=now0-(this.habitAt??now0);
            this.habit=(this.habit||0)*Math.pow(.5,since/4)+1;this.habitAt=now0;
            volume*=Math.max(.5,1/(1+.035*Math.max(0,this.habit-3)));   // the first few steps at full level
        }
        const spatial=this.spatial(entity), now=this.ctx.currentTime;
        if(spatial.invalid)return this.suppressed('invalidPosition');
        if(spatial.gain<.015)return this.suppressed('distance');
        if(!this.allow(kind,entity,now))return this.suppressed('cooldownOrBudget');
        const choices=this.buffers[kind];if(!choices)return;
        const source=this.ctx.createBufferSource(),gain=this.ctx.createGain(),pan=this.ctx.createStereoPanner();
        source.buffer=choices[Math.floor(this.random()*choices.length)];
        source.playbackRate.value=.96+this.random()*.08; // never multiplied by game speed
        gain.gain.value=spatial.gain*volume;pan.pan.value=spatial.pan;
        source.connect(gain);gain.connect(pan);
        pan.connect(['chop','harvest','mine','build'].includes(kind)?(this.workBus||this.ambience)
            :['crackle','heal'].includes(kind)?this.ambience:moving?(this.moveBus||this.effects):this.effects);
        const voice={source,gain,pan,entity,volume};this.voices.add(voice);
        source.onended=()=>{source.disconnect();gain.disconnect();pan.disconnect();this.voices.delete(voice);};
        source.start();this.diagnostics.played++;return true;
    }
    combat(attacker,target) {
        if(!this.enabled || !target)return;
        // Campaign: your own are being hit. Damage only -- a sighting is not an attack --
        // and at most once in twenty seconds.
        if(!this.game.spectatorMode&&target.owner==='player'&&attacker&&attacker.owner!=='player'&&this.ctx){
            const t0=this.ctx.currentTime;
            if(t0-(this.underAttackAt??-Infinity)>20){this.underAttackAt=t0;this.notify('underAttack',true);}
        }
        // Death hits still sound, but retain the actual target's visibility.
        const hit={x:target.x,z:target.z,mesh:target.mesh};
        // These are the two infantry meshes carrying swords. Militia retain
        // clubs; mounted units use javelins/spears/lances and keep their impact.
        const sword=attacker&&(attacker.type==='warrior'||attacker.type==='champion');
        const kind=target.unitType?(sword?'steel':'impact'):'stone';
        this.emit(kind,hit,kind==='steel'?.264:.28);
    }
    footstepKind(unit,theme) {
        const mounted=unit.unitType==='cavalry';
        if(typeof TexGen!=='undefined' && TexGen.grassCoverSampler) {
            if(this._stepTheme!==theme || !this._stepCover) {
                this._stepTheme=theme;
                this._stepCover=TexGen.grassCoverSampler(theme,TexGen.TERRAIN_SEED,TexGen.TERRAIN_WORLD);
            }
            // Match the dry pebble patches used by the ground/clutter renderer.
            const {x,z}=unit;
            const patch=Math.max(0,Math.min(1,(.5+.28*Math.sin(x*.047+z*.023)+.22*Math.sin(z*.061-x*.019)-.3)/.4));
            if((1-this._stepCover(x,z))*patch>.4)return mounted?'hoofGravel':'gravel';
        }
        return theme==='winter'||theme==='desert'?(mounted?'hoofSnow':'snow'):(mounted?'hoof':'step');
    }
    projectile(from,kind,shooter) {
        if(kind==='arrow'||kind==='fireArrow')this.emit(shooter?.type==='crossbowman'?'crossbow':'bow',from,.21);
    }
    async audition(kind) {
        if (!this.game._showcaseCivilization || !['step','snow','gravel','hoof','hoofSnow','hoofGravel','bow','crossbow','impact','steel','stone','crackle','chop','harvest','mine','build','built','research','trained','collapse','wonderLost','heal','command','commandAction','start','elimination','victory','defeat','warning'].includes(kind)) return;
        if (!this.enabled) return;
        await this.setEnabled(true);
        this.update();
        if(['built','research','trained','wonderLost','command','commandAction','start','elimination','victory','defeat','warning'].includes(kind))return this.notify(kind);
        const camera = this.game.renderer.cameraTarget;
        this.emit(kind, {x:camera.x,z:camera.z,audioPreview:true},
            ['step','snow','gravel','hoof','hoofSnow','hoofGravel'].includes(kind)?.13:['chop','harvest','mine','build'].includes(kind)?.32:kind==='heal'?.18:kind==='collapse'?.4:kind==='crackle'?.06:['bow','crossbow'].includes(kind)?.21:kind==='steel'?.264:['impact','stone'].includes(kind)?.28:.20);
    }
    notify(kind, persist=false, caption=null) {
        if(!this.enabled||!this.ctx||this.ctx.state!=='running'||document.hidden||this.game.renderer?.replayMode||(!persist&&!this.active()))return this.suppressed('inactiveNotice');
        const now=this.ctx.currentTime;
        if(now-(this.notices.get(kind)??-Infinity)<((kind==='command'||kind==='commandAction')?.18:1.5))return this.suppressed('noticeCooldown');
        const existing=[...this.voices].filter(v=>v.notice);
        if(existing.length>=2){
            const feedback=kind==='command'||kind==='commandAction';
            // A fresh click's acknowledgement should not be lost behind the
            // ringing tail of an earlier click or completion notification.
            if(persist||feedback)existing[0].source.stop();else return this.suppressed('noticeBudget');
        }
        const source=this.ctx.createBufferSource(),gain=this.ctx.createGain();
        // The four variants in turn, so a repeated announcement is not the identical sound.
        const turn=this.noticeTurn[kind]=((this.noticeTurn[kind]??-1)+1)%4;
        source.buffer=this.buffers[kind][turn];gain.gain.value=(kind==='command'||kind==='commandAction')?.18:.4;
        source.connect(gain);gain.connect(this.effects);
        const voice={source,gain,notice:true,persist};this.voices.add(voice);this.notices.set(kind,now);
        this.duckUntil=now+source.buffer.duration+.2;
        // Fake/test buffers may omit duration; the real AudioBuffer never does.
        if(!Number.isFinite(this.duckUntil))this.duckUntil=now+2;
        this.ramp(this.ambience.gain,this.levels.ambience*.4,.06);
        this.ramp(this.master.gain,this.levels.master,.04);
        source.onended=()=>{source.disconnect();gain.disconnect();this.voices.delete(voice);if(!this.active()&&![...this.voices].some(v=>v.notice))this.ramp(this.master.gain,0,.1);};
        source.start();this.diagnostics.played++;
        if(caption&&this.game.spectatorMode&&this.levels.master>0&&this.levels.effects>0)
            this.game.ui?.showSpectatorSoundCaption?.({kind,...caption});
        return true;
    }
    completed(kind, entity, owner, detail={}) {
        owner=owner||(entity?this.game.getOwnerByBuilding?.(entity):null)||(entity?.owner==='player'?this.game.player:null);
        const caption={civilization:owner?.civilization||entity?.civilization,name:entity?.name,...detail};
        if(!this.game.spectatorMode&&owner&&owner===this.game.player)return this.notify(kind);
        if(!entity)entity=(owner?.buildings||[]).filter(b=>!b.underConstruction&&this.visible(b)).sort((a,b)=>this.spatial(b).gain-this.spatial(a).gain)[0];
        // Spectators hear on-camera completions. Hidden enemy work never becomes
        // a global player notification.
        if(entity&&this.visible(entity)&&this.spatial(entity).gain>.015)return this.notify(kind,false,caption);
        return this.suppressed('offCameraCompletion');
    }
    buildingLost(building) {
        const point={x:building.x,z:building.z,mesh:{visible:building.mesh?.visible!==false}};
        if(building.isWonder&&(this.game.spectatorMode||building.owner==='player'))this.notify('wonderLost');
        else this.emit(building.isWonder?'wonderLost':'collapse',point,.4);
    }
    matchStart() {
        this.eliminations=new WeakSet();this.wonderStages=new WeakMap();this.notices.clear();this.ages=new WeakMap();
        this.notify('start',false,{});
    }
    matchEvents() {
        if(this.game._showcaseCivilization)return;
        // A new age: a rising stinger, for the seats a spectator watches or your own.
        this.ages=this.ages||new WeakMap();
        for(const owner of this.game.spectatorMode?(this.game.aiManager?.aiPlayers||[]):[this.game.player]){
            if(!owner)continue;
            const was=this.ages.get(owner);this.ages.set(owner,owner.age);
            if(was!==undefined&&was!==owner.age&&!this.game.isPlayerEliminated?.(owner))
                this.notify('ageUp',false,{civilization:owner.civilization,age:owner.age});
        }
        for(const owner of this.game.aiManager?.aiPlayers||[]) {
            if(this.game.isPlayerEliminated(owner)&&!this.eliminations.has(owner)){this.eliminations.add(owner);this.notify('elimination',false,{civilization:owner.civilization});}
        }
        const owners=this.game.spectatorMode?(this.game.aiManager?.aiPlayers||[]):[this.game.player];
        for(const owner of owners)for(const b of owner?.buildings||[]){
            if(!b.isWonder||b.underConstruction||b.health<=0)continue;
            const remaining=(this.game.wonderRequired||600)-(this.game.spectatorMode?(owner._wonderHold||0):(this.game.wonderTimer||0))/1000/(this.game.wonderPace||1);
            const stage=remaining<=10?3:remaining<=30?2:remaining<=60?1:0;
            if(this.wonderStages.get(b)!==stage){this.wonderStages.set(b,stage);this.notify('warning',false,{civilization:owner.civilization,seconds:Math.max(0,Math.ceil(remaining))});}
        }
    }
    workerSound(unit) {
        if(unit.type!=='worker' || unit.isMoving || unit.isAttacking || unit.carryingResource) return null;
        if(unit.isBuilding) {
            const site=unit.task==='building'?unit.buildTarget:unit.task==='repairing'?unit.repairTarget:null;
            if(site&&site.health>0&&(site.underConstruction||site.health<site.maxHealth))return 'build';
        }
        if(unit.task==='farm_work') {
            const farm=unit.farmRef;
            return farm && farm.health>0 && !farm.underConstruction && farm.foodAmount>=10
                && unit.harvestTimer>0 ? 'harvest' : null;
        }
        const node=unit.harvestTarget;
        if(unit.task!=='harvesting' || !unit.isHarvesting || !node || !(node.amount>0))return null;
        return {wood:'chop',food:'harvest',stone:'mine',gold:'mine'}[node.type] || null;
    }
    silence() {
        if(!this.ctx)return;
        this.master.gain.cancelScheduledValues(this.ctx.currentTime);
        this.master.gain.setValueAtTime(0,this.ctx.currentTime);
        for(const voice of this.voices){try{voice.source.stop();}catch(_){} }
        this.cells.clear();this.recent=[];this.positions=new WeakMap();this.wasActive=false;
    }

    update() {
        if(!this.ctx || !this.enabled)return;
        if(!this.active()) {
            if(document.hidden||!this.enabled){if(this.wasActive)this.silence();return;}
            for(const v of [...this.voices])if(!v.notice||!v.persist)v.source.stop();
            if(this.wind)this.ramp(this.wind.gain.gain,0,.1);if(this.fire)this.ramp(this.fire.gain.gain,0,.1);
            if(![...this.voices].some(v=>v.notice))this.ramp(this.master.gain,0,.1);
            this.wasActive=false;this.cells.clear();this.recent=[];this.positions=new WeakMap();return;
        }
        const now=this.ctx.currentTime;
        this.ramp(this.ambience.gain,this.levels.ambience*(now<(this.duckUntil||0)?.4:1),.2);
        if(!this.wasActive){this.wasActive=true;this.ramp(this.master.gain,this.levels.master,.25);this.nextUpdate=now;}
        if(now<this.nextUpdate)return;
        this.nextUpdate=now+.16/this.movementCadence(); // sample movement often enough for faster steps
        const r=this.game.renderer, theme=r._theme||'summer';
        const zoom=Math.min(1,100/(r._halfH||80));
        if(this.wind){
        this.ramp(this.wind.gain.gain,(theme==='winter'?.05:theme==='desert'?.04:.03)*zoom,.7);
        this.ramp(this.wind.filter.frequency,theme==='winter'?1250:theme==='desert'?750:950,.8);
        }
        // Reposition active effects when the director cuts; do not drag old battles
        // audibly into a new village. No delayed events or replay queues.
        for(const voice of this.voices){
            if(voice.notice)continue;
            const s=this.spatial(voice.entity);
            this.ramp(voice.gain.gain,this.visible(voice.entity)?s.gain*voice.volume:0,.06);
            this.ramp(voice.pan.pan,s.pan,.08);
        }
        let nearest=null,fireGain=0;
        for(const b of r.buildings||[]){
            if(b.underConstruction || !b._engine?.fire || !this.visible(b))continue;
            const [x,,z]=b._engine.fire, pos={x,z},s=this.spatial(pos);
            if(s.gain>fireGain){fireGain=s.gain;nearest=pos;}
        }
        if(this.fire)this.ramp(this.fire.gain.gain,fireGain*.08,.35);
        if(nearest){
            if(this.fire)this.ramp(this.fire.pan.pan,this.spatial(nearest).pan,.2);
            if(now>this.nextCrackle){this.emit('crackle',nearest,.06);this.nextCrackle=now+.4+this.random()*1.7;}
        }
        const groups=new Map(),workers=new Map();
        for(const u of r.units||[]){
            const old=this.positions.get(u);this.positions.set(u,{x:u.x,z:u.z});
            if(this.visible(u)) {
                const kind=this.workerSound(u),gain=this.spatial(u).gain;
                if(kind && gain>.025) {
                    const key=kind+':'+Math.floor(u.x/14)+':'+Math.floor(u.z/14);
                    if(!workers.has(key)||workers.get(key).gain<gain) workers.set(key,{unit:u,kind,gain});
                }
            }
            if(!old || !u.isMoving || !this.visible(u) || Math.hypot(u.x-old.x,u.z-old.z)<.08)continue;
            const s=this.spatial(u);if(s.gain<.025)continue;
            const key=Math.floor(u.x/14)+':'+Math.floor(u.z/14);
            if(!groups.has(key)||groups.get(key).gain<s.gain)groups.set(key,{unit:u,gain:s.gain});
        }
        for(const {unit} of [...groups.values()].sort((a,b)=>b.gain-a.gain).slice(0,4))
            this.emit(this.footstepKind(unit,theme),unit,.13);
        let played=0;
        const last=w=>this.cells.get(w.kind+':'+Math.floor(w.unit.x/14)+':'+Math.floor(w.unit.z/14))??-Infinity;
        for(const {unit,kind} of [...workers.values()].sort((a,b)=>(last(a)-last(b))||b.gain-a.gain)) {
            if(this.emit(kind,unit,.32)&&++played>=3)break;
        }
        for(const [key,time] of this.cells)if(now-time>3)this.cells.delete(key);
    }
}

// Optional sound is a presentation boundary: a device/API failure mutes audio,
// records one diagnostic and must not stop Game.gameLoop or the renderer.
for (const method of ['emit','notify','update','startAmbience']) {
    const operation=WarAudio.prototype[method];
    WarAudio.prototype[method]=function(...args) {
        try { return operation.apply(this,args); }
        catch(error) {
            this.enabled=false;
            this.diagnostics.lastError={operation:method,name:error?.name||'Error',message:String(error?.message||error).slice(0,300)};
            this.suppressed('audioFailure');
            try { this.silence(); } catch (_) {}
            try { this.ctx?.suspend().catch(()=>{}); } catch (_) {}
            console.warn('WAR audio muted after an error; the match continues.',error);
            return false;
        }
    };
}

// Generated by WarAudio.recordSeeds() -- see there. Do not edit by hand.
const WAR_AUDIO_SEEDS = Object.freeze({
    step: [5718354, 3229122452, 3812758310, 3748006024],
    snow: [3663274042, 520559836, 3577770702, 455480976],
    gravel: [574042274, 3622733209, 3239438372, 3303723827],
    hoof: [1605805302, 1911479000, 3993962250, 650632716],
    hoofSnow: [2645755998, 3738634912, 679298866, 2219432596],
    hoofGravel: [557667654, 3756857837, 3899836520, 1855565479],
    bow: [1077469658, 3666208817, 3862965660, 3041987339],
    crossbow: [2030220462, 4112960309, 3520253456, 4157880623],
    impact: [320288706, 3876355769, 3037692228, 2888952403],
    steel: [1517545494, 29289352, 1088429642, 3841515740],
    stone: [1934493630, 888720757, 2939635456, 2881423695],
    crackle: [295286930, 3774222303, 1269309449, 1255690738],
    chop: [2752844030, 1120887525, 3120993568, 1403870623],
    harvest: [4129706386, 1846922596, 265523078, 3192770680],
    mine: [1459223738, 607547569, 3594837180, 3720153035],
    build: [2993345550, 2024138869, 2569297968, 407884079],
    built: [18677922, 2331546510, 3984619962, 1082810150],
    research: [1513304018, 4211539163, 1935039608, 323042233],
    trained: [2402999022, 2538611790, 2645900718, 641869582],
    collapse: [3905871982, 3246506053, 475694064, 2466123359],
    wonderLost: [1444127170, 2907192377, 2957755972, 1615450835],
    heal: [1718417430, 1996186493, 420726200, 1134876855],
    command: [2276715946, 2634674545, 2980439500, 2262116523],
    commandAction: [1810748222, 3137499381, 3046738560, 1151202511],
    start: [483136530, 2646400734, 1700561130, 3153151542],
    elimination: [660650690, 2442942311, 993380928, 3251981981],
    victory: [3694880526, 1571983026, 2539107222, 323688890],
    defeat: [2297185566, 1773953429, 4032523744, 1481331439],
    warning: [193079538, 632301691, 764992664, 2503252569],
    ageUp: [1157769742, 927817042, 3216884182, 2016705434],
    underAttack: [616165022, 1763665416, 1305559362, 3954148044],
    wind: 4161167654,
    fire: 4023993421,
    after: 1710636872,
});
