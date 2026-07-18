<div align="center">

# 🏛️ When Agents Rule

### Where language models battle for the crown in antiquity.

**Up to four LLMs. One map. One winner.**
A browser-based, Age-of-Empires-style real-time strategy game in which competing language models play *against each other* — while you watch, coach, and score them.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![No build step](https://img.shields.io/badge/build-none%20required-success)
![Zero dependencies](https://img.shields.io/badge/dependencies-zero%20%C2%B7%20in--house%20engine-blue)
![Providers](https://img.shields.io/badge/providers-OpenAI%20%C2%B7%20Anthropic%20%C2%B7%20Ollama%20%C2%B7%20Google-purple)

<br>

[![When Agents Rule — a typical match (click to watch)](Screenshots/ArenaPoster.png)](Screenshots/Arena.gif)

<sub><i>A typical match: models giving orders turn by turn, economies growing, an age advancing before your eyes — <b>click the image for the animated tour</b>.</i></sub>

</div>

---

## What is this?

When Agents Rule is a **sandbox arena for pitting language models against one another** at a task they were never trained for: running an economy and an army, in real time, inside a small RTS they've never seen. Every player is an autonomous model agent governing its own civilization — and every match ends one of two ways: a rival razed to the ground, or a Wonder held in peace.

It is **not** a leaderboard and not a peer-reviewed benchmark. It *is* a hands-on testbed — non-scientific, but more than a toy: with the setup held steady (same civilization, a fixed map seed, and a resource layout that is now equal for every player), a match isolates the model as the variable well enough for **narrow, controlled comparisons**. Loosen those controls and it stays a fun, surprisingly revealing way to watch how different models behave when you drop them into an **unfamiliar framework** and ask them to **act**, not chat.

Each model is handed:

- a compact **JSON snapshot** of its situation every turn (resources, buildings, units, fog-of-war discoveries, threats, tech tree, the map bounds…),
- a **fixed set of tools** (`train_unit`, `build_structure`, `research_tech`, `upgrade_age`, `attack_target`, `explore`, …),
- and a single instruction: **win.**

Then it has to keep doing that, turn after turn, for an entire match.

<div align="center">

![A live When Agents Rule match](Screenshots/Scene1.png)

<sub><i>A live match on the Winter map — the fog-limited 3D world, the streaming decision log (left), the ranked leaderboard with advice inputs (right), and the minimap. Both seats here are ornith:9b, one a full age ahead of the other.</i></sub>

</div>

## Why it's an interesting (if unscientific) eval

Most quick LLM demos reward a single clever answer. A full match of When Agents Rule rewards something harder, and it stresses exactly the capabilities people care about in agents:

- **⚔️ Models develop their own doctrine.** Run enough matches and temperaments emerge: the same rules and the same prompt produce pure economists that race for a Wonder and barely raise a guard, next to warlords that field a comically strong military absurdly early and go hunting. Which one a model turns out to be is part of what you're evaluating.
- **🧨 Pressure changes their play.** A model that feels challenged — raided, out-scouted, slipping down the leaderboard — will often genuinely switch tactics instead of doubling down: economists start drafting armies, aggressors pull back and wall up. Watching a model *notice* it is losing is worth the match on its own.
- **🎯 Precise tool calling under pressure.** Every move must be a single, valid JSON action with the right parameters. Hallucinate a tool, fumble the schema, or wrap it in prose and the turn is wasted. You can literally *watch* a model's format discipline hold or crumble.
- **🧭 Operating in a loose, unfamiliar framework.** There's no fine-tuning, no examples of "good play." The model only has the rules in its system prompt and the state in front of it. Can it infer a working strategy for a system it has never encountered?
- **🧠 Long-context, long-horizon strategy.** Economy → technology → military → conquest is a chain that plays out over dozens of turns. Models that optimize their economy forever and never build an army lose. Models that remember their plan, adapt to scouting, and convert resources into pressure win. (The harness gives each model a persistent **objective + plan** it can carry across turns — but it's up to the model to actually maintain and follow it.)
- **🔁 Error recovery.** When an action is rejected, the model gets a precise reason back (e.g. *"barracks not built yet — research it first"*). Does it correct course, or bang on the same locked door?
- **🗺️ Spatial & resource reasoning.** Fog of war hides the map. Resources and enemies must be **scouted** before they can be used or attacked. Good play means exploring, not guessing.
- **⏱️ Latency vs. quality.** Each model runs its **own independent loop** — faster models simply act more often. A brilliant-but-slow model can be out-tempoed by a decent-but-fast one, just like in the real world.

You won't get a p-value, and a single match is an anecdote. But the map is no longer a confound — pin the civilization and the seed, and what's left to explain the result is mostly the models themselves. Within those bounds it stands up as a *comparative* testbed for narrow questions; outside them, it's still an immediate, surprisingly revealing feel for which models can actually *play*.

<div align="center">

![An iron-age model overruns a stone-age rival](Screenshots/Clash.gif)

<sub><i>Doctrine, decided: an iron-age model marches on a rival still in the stone age, wipes it from the map, and the results screen calls the match.</i></sub>

</div>

## ✨ Features

- **🤖 2–4 models, fighting live** — pick the participant count; each model runs its own asynchronous decision pipeline, so faster models genuinely move more often.
- **🔌 Bring any model** — OpenAI-compatible (OpenAI, vLLM, LM Studio, LiteLLM, Groq, OpenRouter, …), **Anthropic**, **Ollama**, and **Google (Gemini)**, with auto-detection. Mix local and cloud in the same match.
- **🔐 Every auth style** — none, API key (Bearer), header secret, Basic, or OAuth2 (paste a token or fetch via client-credentials).
- **🧰 Model library** — add, **test connection**, pick the served model, set per-model **max tokens**, **reasoning language**, and a **context budget** (all providers; also Ollama's `num_ctx`) with a **↺ Max** auto-fill and a **minimize-tokens** toggle. Saved locally and **exportable/importable** as a file.
- **🧠 Rolling context that scales with the model** — history is sized to each model's context budget: big-context models remember more of the match. Default is a true **multi-turn conversation** with per-turn state recaps; the minimize-tokens toggle switches to a compact one-line move history.
- **🪙 Token accounting** — provider-reported usage per model (prompt + completion) on the summary card and in the results file, next to latency. Speed *and* cost, side by side.
- **🌱 Seeded maps** — optional map seed: the same seed reproduces the exact same resource layout, for fair A/B comparisons between models.
- **⚖️ Fair resource placement** — food and wood fill an even 7×7 grid, while the scarce **stone and gold are laid out identically for every player** (same counts, same distances from home, never beside a Town Center). With same-civ seats and a fixed seed, the map stops being a confounding variable — the outcome is left to the models.
- **🌙 Keeps running in a background tab** — a Web-Worker driver keeps the simulation and the models' turns going while the tab is hidden (rendering pauses, the match doesn't). A discarded tab or a sleeping machine still pauses play.
- **🎬 A battlefield worth watching** — soft feathered fog of war, visible arrows and tower stones, hit flashes, animated deaths and crumbling buildings, battle pings in the world and on the minimap, themed ground cover per map (lush summer, frosted winter, dry desert), and an optional **action camera** that automatically follows the fighting.
- **📄 Results export** — one click saves the full match evaluation as a self-describing `results_<datetime>.md` (winner, per-model scores, stats, each model's config, difficulty, seed).
- **📝 Per-player system prompts** — give each seat its own brain (aggressive vs. economic, terse vs. verbose) from one editable template, and watch the styles collide.
- **🛰️ Live spectator dashboard** — a ranked leaderboard, a streaming **decision log** (every move + the model's stated reason, rejected actions flagged), per-model **advice chat**, and **play/pause** for any model (handy when one hits a quota).
- **📊 End-of-match model evaluation** — latency, decision count, action-success rate, JSON format fidelity, reasoning rate, error breakdown, behavior tags, and a transparent 0–100 **strategy score**.
- **🌍 Fully localized UI** — English, German, Spanish, Simplified Chinese — with the **model's** language chosen **separately** from the interface language.
- **🎮 Also human-playable** — a **Campaign** mode: pick your civilization and face **1–5 opponents**, each controlled by one of your models or the built-in rule-based AI, on three difficulty maps (Summer Valley / Winter Valley / Desert). If a model's endpoint goes unreachable mid-game, that opponent **falls back to the rule-based AI** so your match stays alive — and a footer always shows who controls each rival.
- **🚫 No build step, no dependencies** — plain HTML/CSS/JS with an **in-house WebGL engine** (every texture painted procedurally at load — no asset downloads, no CDN, no external code at all). Clone, serve, play.

## 🚀 Quick start

No install, no bundler. You just need to serve the folder over HTTP (the app uses `fetch`, so opening `index.html` from `file://` won't work).

```bash
git clone https://github.com/asp67/when-agents-rule.git
cd when-agents-rule

# pick any static server:
npx http-server . -p 8080 -o          # Node
# python3 -m http.server 8080         # Python
# php -S localhost:8080               # PHP
```

Then open **http://localhost:8080** and click **Play → 🏟️ Arena**.

> 💡 **Fastest path to a match:** install [Ollama](https://ollama.com), pull a small, quick model (`ollama pull qwen2.5:7b`), and point a couple of arena seats at `http://localhost:11434`. Small + fast beats large + slow in a real-time arena.

> 🐦 **Easy first pick:** `ollama pull ornith:9b` — it needs only ~6 GB of VRAM, so it runs on many consumer graphics cards, and it turns out to be a **surprisingly strong player** for its size.

## 🏟️ Setting up the Arena

1. **Model Library** → add your models. For each: set the **endpoint**, pick the **protocol/provider** (or leave on auto-detect), choose an **auth** method, hit **🔌 Test connection**, and select the served model. Optionally set **max tokens**, the **model language**, and the **context budget** (press **↺ Max** to fill in the model's maximum).
2. **Arena participants** → choose **how many participants (2–4)**, then give each seat a **civilization** and a **controller** (one of your models, or the rule-based AI). An optional **map seed** makes the terrain reproducible for fair rematches.
3. **System prompt** → tweak the shared template, or give individual seats their own prompt.
4. **⚔️ Start Arena** and watch.

<div align="center">

![Adding a model in 30 seconds](Screenshots/ManageModels.gif)

<sub><i>Hands-on in 30 seconds: add a model, paste the Ollama endpoint, auto-detect the served models, pick <code>ornith:9b</code>, set its options — and back to the arena setup.</i></sub>

</div>

While spectating you can **click a card** to fly the camera to that base, **drag** to pan, send a model **advice**, or **pause** a model entirely. The **decision log** streams every move alongside the model's own stated reason, and flags any rejected action:

<div align="center">

![The streaming decision log](Screenshots/Scene2.png)

<sub><i>The decision log in action: attack orders with the model's own reasoning, worker reassignments — and a rejected action (an archery range attempted before its age) flagged in red.</i></sub>

</div>

> 💡 **The context budget is a real lever — history scales with it.** Each model has a **context budget** (default **32768** tokens; press **↺ Max** to fill in the model's true maximum). The harness sizes the rolling match history to that budget: a 128K-context model literally remembers more of the game than a 32K one. Two history modes per model:
> - **Multi-turn (default):** a genuine conversation — past turns replayed as compact state recaps + the model's own replies + each action's outcome. Richest memory; uses more of the budget.
> - **Minimize token spending:** every past move compressed to one line (`action ("reason") → OK/FAILED: outcome`). Cheapest, and still enough for coherent play.
>
> Either way the prompt is rebuilt from scratch every turn with conservative token estimates and safety headroom, and if an endpoint ever rejects a request as too large the harness shrinks the window automatically and keeps playing. **Lower budgets are much faster** — especially on Ollama, where the budget also sets `num_ctx` and an oversized window (e.g. 128K) can spill the model onto the CPU. For small local models, 32K remains a great default.
>
> If a model is a heavy **reasoning / "thinking"** type that tends to overthink, raise its **max tokens** (the *output* budget) — not its context — so it has room to finish reasoning *and* still emit the final JSON action. Watch latency too: more thinking means slower turns, and a slow turn can hit the request timeout before context ever becomes an issue.

## 🧮 How a model is scored

<div align="center">

![End-of-match model evaluation](Screenshots/ModelEvaluation.png)

<sub><i>End-of-match evaluation of a four-model match (won by Wonder) — each model's 0–100 strategy score and the raw stats behind it: latency, decisions, success rate, format fidelity, reasoning rate, token usage, the full error breakdown (including no-action replies), and behavior tags.</i></sub>

</div>

The match-end **Strategy Score** (0–100) is a transparent composite — no black box:

| Weight | Factor |
|:---:|---|
| 34% | Action success rate (valid, accepted moves) |
| 20% | Progression (age advanced · buildings · military) |
| 18% | Format fidelity (well-formed JSON the engine could parse) |
| 15% | Reliability (no timeouts / network errors) |
| 13% | Action diversity (used the toolset, didn't loop one move) |

Alongside it you get raw stats — average/min/max latency, decisions made, success ratio, reasoning rate, **token usage** (prompt + completion, as reported by the provider), and a full **error breakdown** (timeouts · parse fails · **no-action replies** (the model answered in prose without a JSON action — nothing is guessed or executed) · invalid actions · rejected · context overflows) — plus quick **behavior tags** like *Aggressive*, *Economy-focused*, *Format issues*, or *Invents actions*. **💾 Save results** exports it all as a self-describing Markdown file (including each model's config, the difficulty, and the map seed).

## 🛠️ How it works

```
Browser (no backend, no external code)
├── In-house engine (js/engine) — WebGL: locked dimetric camera, procedural textures,
│                                 composed meshes, fog plane, effects
├── Game engine               — economy, combat, fog of war, ages, win conditions
├── Provider adapters         — OpenAI / Anthropic / Ollama / Google request shaping + auth
└── Per-model agent loop       — builds the JSON game-state, calls the model, parses ONE action,
                                 applies it, feeds the result back next turn
```

Each turn a model receives a structured snapshot and must return exactly one action:

```json
{ "action": "build_structure", "params": { "buildingType": "barracks", "reason": "need infantry to pressure the leader" } }
```

The engine validates it against the **advancement chain** (advance → research → build → resources → train) and returns a precise, actionable error if it can't be done — which becomes part of the model's context on the next turn. The full state contract is in [`game-state-schema.json`](game-state-schema.json).

**Budget-bounded rolling context, by design.** The model is stateless across turns from the harness's point of view — every turn the prompt is rebuilt from scratch, so the harness (not each server's truncation rules) decides exactly what the model sees. The match history is a **rolling window sized to the model's context budget**: in the default **multi-turn mode** past turns are replayed as real conversation turns (a compact, schema-keyed `pastTurnRecap` of the state + the model's reply + that action's outcome), oldest rolling off first; with **minimize tokens** on, history is instead the last N moves as one-liners (`action ("reason") → OK/FAILED: outcome`), N chosen to fit the budget. Either way the model *always* gets the result of its previous action (so a rejected command is never silently repeated), the full current state last, and a model-authored **standing objective + plan** that persists until the model rewrites it — so a multi-step intent like *"scout the enemy base → mass cavalry → attack"* survives beyond the visible history. The harness only stores and echoes these back; it never plans for the model, so the eval still measures the model's own strategic reasoning.

**Action set:** `train_worker` · `train_unit` · `research_tech` · `upgrade_age` · `build_structure` · `build_wonder` · `assign_workers` · `repair_building` · `explore` · `move_units` · `attack_target` · `delete_unit` · `destroy_building` · `wait`.

## ⚔️ Game rules in a nutshell

- **Win** by either **eliminating every** rival, **or** building a **Wonder** and holding it for the countdown (**600 s**). A rival is only out when it has no army, no military building it can afford to produce from, and no Town Center (nor a worker + the resources to rebuild one) — so raze their base *and* mop up, or they can come back.
- **Advance the ages** — Stone → Neolithic → Bronze → Iron — to unlock stronger units, tech, and (eventually) the Wonder. Buildings get an epoch-appropriate look and +50% HP per age.
- **Economy first, but not forever:** workers gather food/wood/stone/gold; houses raise the population cap (hard cap 100). **Resource nodes deplete** (food 500 · wood 300 · stone 1000 · gold 2000 per node) — scout for fresh ones; only **farms regenerate**, and only while a worker mans them. Placement is built for fairness: food and wood fill an even **7×7 grid**, while scarce **stone and gold are placed identically for every player** — same counts, same distances from home, none beside a Town Center. No start is advantaged, and scouting any direction pays.
- **Counters:** cavalry > ranged > infantry > cavalry; infantry raze buildings best; towers defend.
- **Fog of war:** scout to reveal resources and enemies — a model can't harvest or attack what it hasn't discovered.
- **4 civilizations** — Egyptians, Greeks, Persians, Yamato — each with a unique bonus and Wonder.

## 🔒 Privacy & security

This is a **fully client-side** app with no backend of its own.

- API keys and other secrets you enter live in your **browser's `localStorage`** and are sent **directly from your browser** to the endpoints you configure — nothing is proxied through any third party.
- That's fine for **local, single-user testing**. Don't enter credentials on a shared or public machine, and scope/limit any keys you use.
- **Exporting** the model catalogue writes a JSON file that contains your keys **in plain text** (the app warns you). Keep that file private — never share it or commit it. (`*.secrets.json`, `when-agents-rule-models.json`, and `arenaConfig*.json` are git-ignored by default.)

## 🌍 Languages

The **interface** ships in English, German, Spanish, and Simplified Chinese. Separately, each **model** has its own language for how it reasons and writes its `reason` field — so you can run, say, a Chinese UI with English-thinking models, or vice versa. Defaults are English / English.

## 📁 Project structure

```
index.html              # screens, HUD, arena & library UI
css/styles.css          # all styling
js/
├── game.js             # core loop, economy, combat, win conditions
├── openai-ai.js        # LLM arena harness: provider adapters, agent loop, metrics
├── ai.js               # rule-based AI opponent
├── ui.js               # menus, model library, spectator dashboard
├── engine/             # the in-house WebGL engine: math3d, glcore, texgen,
│                       #   mesh, buildings, units, gamerenderer
├── i18n.js             # 4-language UI dictionary + game-content translations
├── civilizations.js    # civs, units, buildings, tech trees
├── buildings.js / units.js / resources.js / terrain.js / fogofwar.js / input.js
game-state-schema.json  # the JSON contract handed to every model each turn
```

## 🧰 Tech stack

Plain **HTML + CSS + JavaScript** — and nothing else. The 3D world is drawn by an **in-house WebGL engine** (`js/engine/`): a locked dimetric camera in the classic RTS style, every material **painted procedurally** into canvases at load (masonry, thatch, roof tiles, cloth, the whole terrain mega-texture), meshes composed from first-principles primitives. No framework, no bundler, no transpile step, no CDN, no assets to download. Cache-busting is done with a `?v=` query on each script tag.

## 🧭 Related projects

Similar arenas, different games — worth knowing, and worth crediting:

- **[llm-colosseum](https://github.com/OpenGenerativeAI/llm-colosseum)** — the project that popularized LLM-vs-LLM gaming: models fight in *Street Fighter III*, making reflex-scale decisions seconds apart, ranked by ELO. *When Agents Rule* probes the opposite end of the spectrum: long-horizon statecraft over matches half an hour long — economy, tech, fog of war, persistent plans — with a **peaceful** road to victory next to the military one.
- **[LMSYS Chatbot Arena](https://lmarena.ai)** — humans vote on chat answers. Here nobody votes: the game itself is the judge, and the scoreboard is razed bases and held Wonders.
- **[Stratagem](https://github.com/KaliBomaye/stratagem)** — turn-based LLM strategy with natural-language diplomacy on a province graph. Ours is real-time, 3D, browser-only with no install, no build step and **zero external code** (the WebGL engine is in-house), and instruments every model as it plays (behavior metrics, latency, token accounting).
- **[Age of Agents](https://github.com/agentsmill/age-of-agents)** — renders your AI *coding* sessions as a peaceful, AoE-style pixel kingdom: a lovely visualization with no combat and no winners. Here the agents don't decorate the kingdom — they run it, and only one keeps it.
- **[LLM-Game-Benchmark](https://github.com/research-outcome/LLM-Game-Benchmark)** — an academic benchmark of LLMs in grid-based games, with a leaderboard. We trade that rigor for richness: one sprawling, unfamiliar game instead of many small ones — see the disclaimers below.

## ⚠️ Disclaimers

- **Non-scientific.** Not a peer-reviewed benchmark, and no single match is evidence of anything: sample sizes are tiny and tempo (latency) heavily influences who wins. Don't cite match results as model capability. Within a **controlled setup** — same civilization, a fixed seed, and the resource layout now equal for every player — a match does isolate the model as the main variable and gives a genuine, if narrow, comparative read. Treat that as informed intuition, not data.
- **Not affiliated** with LMSYS / Chatbot Arena, OpenAI, Anthropic, Google, or any model provider. "When Agents Rule" is meant literally: autonomous model agents governing rival civilizations — by wonder or by war.
- Built as a hobby project, with a generous assist from AI pair-programming.

## 🤝 Contributing

Issues and PRs welcome — new providers, civilizations, balance tweaks, better metrics, or translations. Keep it dependency-free and build-step-free where possible.

## 📜 License

[MIT](LICENSE) © 2026 asp67

---

<div align="center">
Made for the simple joy of watching language models try to out-think each other.
</div>
