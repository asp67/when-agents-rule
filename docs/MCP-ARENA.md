# Agent Arena: MCP seats (design, 26 October 2026)

Status: design, agreed in discussion with asp67; nothing built yet. WAR first; the Platform
follows after its anti-cheat work (spectator delay, fog-leak detector).

## Why

There is an open debate about harnesses: which agent harness plays best, and whether a
model gives cleaner results with a thin harness or a rich one. No strategy game measures it.
An MCP seat lets any agent harness (Claude Code, Codex, OpenCode, Hermes, ...) play a WAR
seat natively, on its own subscription: WAR never sees an API key.

The cleanest experiment holds the model fixed: a library seat running Qwen on a local
llama.cpp server, played by WAR's own loop, against an MCP seat whose harness (OpenCode,
Hermes, OpenClaw) is pointed at the same server. Same weights, same rules, same fog; only
the harness differs. "No harness" does not exist: a library seat runs WAR's own minimal,
fixed harness. The comparison is that fixed loop against agent loops.

## Decisions (asp67)

- An MCP seat is a model-library entry of its own type. The entry gives the user the
  commands to start the hub and to connect their harness, for PowerShell and bash.
- The arena setup lists each seat on one line, with a readiness dot on the right.
  The arena starts only when every dot is green. There is no timeout and no partial start:
  a seat that does not turn green means the user fixes it, or sets up the arena without it.
- One hub on HTTP (localhost); stdio only as a fallback for harnesses that cannot reach an
  HTTP MCP server.
- Supported harnesses: the most popular ones, listed below. Setup should be as simple
  as the harness allows; where a harness can configure itself, the library also offers a
  prompt that asks the model in the harness to do it.

## Architecture

```
harness A (Claude Code) ──MCP over HTTP──┐
harness B (OpenCode)    ──MCP over HTTP──┤
harness C (stdio only)  ──stdio shim─────┤   WAR MCP hub  (one process, 127.0.0.1:8765)
                                         │     /mcp/<seat-token>   one address per seat
WAR arena page (browser) ──WebSocket─────┘     /page               the running arena
```

- **One hub, many seats.** A single process serves every MCP seat of every arena. Each
  library entry has its own address, `http://127.0.0.1:8765/mcp/<seat-token>`. The token
  binds a connection to that one seat; two Claude Code windows with two tokens are two seats.
- **The page stays the match.** The arena runs, renders and records in the browser as
  today. The hub only relays: the seat's fogged state out, its commands in. A transcript
  replays the same way whatever sent the commands.
- **stdio fallback.** `node war-mcp-hub.cjs --stdio --token <seat-token>` speaks MCP on
  stdio and forwards to the running hub. For harnesses that only launch servers themselves.
- **The seat token travels in the URL** (HTTP) or as an argument (stdio), never as an environment
  variable: DeepSeek Harness strips variables named like `TOKEN` from the servers it starts.
- **Names.** Servers are named with underscores (`war_seat_1`): harnesses build tool names
  from them (`mcp__war_seat_1__join`, `mcp_war_seat_1_join`), and hyphens are not safe everywhere.
- **Dependency-free.** The hub is one file with a minimal MCP server written by hand
  (JSON-RPC: tools/list, tools/call, prompts/list, prompts/get; the stateless 2026-07-28
  revision needs no session handshake), a small HTTP server and a WebSocket endpoint.
- **Node.** The hub needs Node. For beginners it ships as a zip with a portable node.exe
  and a start script, built the way the Platform connector already is
  (`platform/connector/build-portable.ps1`).
- **Localhost only, and Chrome asks once.** The hub binds 127.0.0.1. Tested 26 October in asp67's
  Chrome: from https://asp67.github.io the status fetch and the WebSocket both work once the user
  allows Chrome's "wants to use local services / devices on your local network" prompt (Local
  Network Access); from a local page (http://localhost) there is no prompt. The hub answers
  preflights with `Access-Control-Allow-Private-Network: true`. The arena setup must say before
  the first contact that Chrome will ask, and to click Allow; a refused prompt shows the MCP
  seat's dot red with "hub not reachable: allow local network access for this site".
  (Claude's embedded browser blocks the request outright, ERR_BLOCKED_BY_CLIENT: not a user path.)
- The library checks run when the arena setup opens and again when a seat's entry changes.
- An MCP seat's line also shows its start line for this match (step 3), with a copy button.
- **Start arena** is enabled only when every dot is green.
- The checks stay valid until Start: a library seat that went red after turning green
  blocks the start again.

## How a harness plays

The match runs turn-based (agents take minutes per turn; the world waits for every seat).
The hub offers these tools to the harness, generated from the same `ACTIONS` table and
`defaultSystemPrompt()` as the library seats, so their texts cannot drift apart:

- `join`: claims the seat; returns the rules (our system prompt, filled for this seat).
- `wait_for_turn`: blocks until this seat's turn, then returns the state JSON a library seat
  would get. It returns `{"waiting": true}` after ~25 s so no harness's tool timeout cuts it
  off (Hermes's examples use 30 s); the agent simply calls it again.
- the game actions (`train_unit`, `move_units`, `attack_target`, ...), same schemas, same
  descriptions, same error texts. At most three per turn, enforced in the hub.
- `end_turn`: hands the turn back (also implied after the third action).
- `get_rules`: the rules again, for a harness that compacted its context.

MCP prompt `play`: the kickoff text, so harnesses that list MCP prompts show it as a command
(Claude Code: `/mcp__war_seat_1__play`). Where they do not (DeepSeek Harness has no MCP prompts),
the start line is the kickoff text to paste.

The kickoff says, in short: you are seat N in a WAR match; call join, then loop wait_for_turn,
up to three actions, end_turn, until wait_for_turn reports the match over; do not stop.

## Supported harnesses (all confirmed calling MCP tools, 26 October 2026)

| Harness | Connects to | Setup | Notes |
|---|---|---|---|
| Claude Code | HTTP | `claude mcp add --transport http war_seat_1 <url>`; headless: `claude -p "<kickoff>" --allowedTools "mcp__war_seat_1__*"` | MCP prompts appear as slash commands |
| ChatGPT (desktop harness) | Streamable HTTP or STDIO | settings, "connect to a custom MCP": name `war_seat_1`; Streamable HTTP with the seat's URL, or STDIO with command `node`, argument `war-mcp-hub.cjs --stdio --token <seat-token>` (working directory: where the hub file is) | seen in asp67's install (26 Oct): the local form takes both types, so no tunnel is needed. ChatGPT's web connectors are another matter: they reach only public HTTPS servers |
| Codex CLI | HTTP | `[mcp_servers.war_seat_1]` with `url` in `~/.codex/config.toml`; headless `codex exec` | |
| Google Antigravity | HTTP | `mcpServers` entry with `serverUrl` in `~/.gemini/config/mcp_config.json` (older builds: `~/.gemini/antigravity/`), then Refresh in Customizations | path differs between builds |
| ZCode | HTTP or stdio | Settings > MCP (writes the file and shows the connection), or add a sibling `"mcp": { "servers": { "war_seat_1": { "type": "http", "url": <url> } } }` next to the existing `plugins` key in `~/.zcode/cli/config.json`; never replace the file. Then restart the session | confirmed by ZCode itself in asp67's install (26 Oct), which offered to add the entry: the self-setup prompt works. Tools appear as `mcp__war_seat_1__<tool>`. **The schema is strict**: an unknown key silently drops the whole server, so the snippet uses only `type`, `url`, `enabled`. Its usual permission prompts apply to MCP tools; how to pre-allow ours is still to find. stdio `timeoutMs` defaults to 30 s |
| DeepSeek Harness (dsh) | streamable HTTP or stdio | built-in client `@deepseek-ai/dsh-mcp-client`, nothing to install: append to the profile's `cordis.patch.yml` `- insert: [{ id: war-seat-1, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: war_seat_1, transport: streamable-http, url: <url> } }]`; HMR applies it live (else restart the app) | confirmed by DSH itself in asp67's install (26 Oct), which also offered to add the entry: the self-setup prompt works. Tools appear as `mcp__war_seat_1__<tool>`. Tool timeout 60 s by default (`toolCallTimeoutMs`). **No MCP prompts**: the kickoff is pasted. It scrubs `KEY|PASSWORD|SECRET|TOKEN` variables from a stdio server's environment, so the seat token stays in the URL or argument, never in an env variable. `serverName` must match `[A-Za-z0-9_-]{1,32}` |
| Hermes Agent | HTTP or stdio | `hermes mcp add war_seat_1 --url <url>` (connects, lists the tools, lets the user pick them); or `mcp_servers` with `url` and `timeout` in `config.yaml` (Windows desktop: `%LOCALAPPDATA%\hermes\config.yaml`). Activate with `/reload-mcp` in the chat, check with `hermes mcp test war_seat_1` or `/mcp` | told asp67 (26 Oct) how to do all three and offered to add a server itself: the self-setup prompt works here. Tools appear as `mcp_war_seat_1_<tool>`. Its examples use `timeout: 30`, hence the 25 s wait below |
| OpenClaw | streamable HTTP or stdio | `openclaw mcp add`, or Settings > MCP; `openclaw mcp doctor <name> --probe` | gateway may need a restart |
| OpenCode | HTTP or stdio | `"mcp": { "war_seat_1": { "type": "remote", "url": "<url>" } }` in `opencode.json` | good for the same-local-model test |

**Self-setup prompt.** Most of these harnesses can edit their own configuration or run their
own CLI. The library offers, per harness, a prompt to paste into it: "Add an MCP server named
war_seat_1 at <url> to your configuration [harness-specific: command or file], allow its
tools, then tell me to restart you." After the restart the play prompt starts the match.

## Records and results

- The transcript header records MCP seats as `harness: <name> (external)`, with the model as
  stated by the user and the hub version. The contract fingerprint marks the harness as
  external, so these matches never compare as plain library matches.
- Results: MCP seats are their own category. Matches with library seats are fine for content
  and comparison, never pooled into the same scores.
- The storybook and analyzer see the tool calls and their `reason` fields, not the agent's
  thinking.

## Risks and checks before building

- Browser to localhost: Chrome works after its local-network prompt (tested 26 Oct); Firefox to test.
- Harness tool timeouts against the ~25 s `wait_for_turn`.
- Harnesses that stop: permission prompts (pre-allow our tools), step limits (set high),
  "end of reply" (the kickoff says to keep playing).
- Agents with other tools (web, files) are part of the harness being measured; this is why
  the category is separate. On the Platform it is a fog-leak risk and waits for anti-cheat.

## Phases

1. Hub prototype: HTTP + WebSocket + the tools, one MCP seat in a local arena, a stand-in
   agent in a test. Verify browser-to-localhost.
2. Library type "MCP", the three steps, the self-setup prompts; arena setup one line per seat
   with readiness dots and the start gate.
3. Harness by harness: Claude Code, ChatGPT (desktop), OpenCode first; then Codex CLI,
   Antigravity, Hermes, OpenClaw, DeepSeek Harness, ZCode. All of them call MCP tools
   (confirmed 26 Oct); Hermes, DeepSeek Harness and ZCode offered to add the server themselves.
4. Transcript header, contract fingerprint, results category.
5. Platform, after its anti-cheat layers.
