# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PR Studio (package name `pr-studio`; the working directory is `pr-studio`) is a
local pull-request review tool. A single Node process serves a vanilla-JS UI,
proxies the GitHub REST API, and spawns `claude -p` (Claude Code headless mode)
inside a local repo checkout so the agent can read/edit files and stream output
back to the browser.

## Commands

```bash
npm install        # express (server) + marked (frontend markdown rendering, served statically)
npm start          # node server/index.js → http://localhost:4317
npm test           # node --test server/ — built-in test runner, no extra deps
```

There is no build step and no linter configured. The frontend is served as
static files; editing `public/*` and reloading the browser is the full dev loop.
`server/index.js` exports `app` and only calls `app.listen` when run directly,
so it's imported directly by `server/index.test.js` without binding the port.

## Configuration

Read from `.env` (loaded via Node's built-in `process.loadEnvFile`, no dotenv dep)
or the real environment:

- `GITHUB_TOKEN` — PAT (fine-grained needs Pull requests: read & write). If unset,
  `resolveToken()` in `github.js` falls back to the `gh` CLI login (`gh auth token`,
  or the `oauth_token` in gh's `hosts.yml` for older `gh`). Absent both = public PRs,
  read-only, no comment posting.
- `DEFAULT_REPO_PATH` — fallback local checkout the agent runs in when the UI has
  no per-PR path set.
- `PORT` — default 4317.
- `CLAUDE_BIN` — override the `claude` binary name/path (see `server/agent.js`).

## Architecture

Four backend modules, each a focused concern, wired together in `index.js`:

- **`server/index.js`** — Express app. JSON API + static file serving. The
  `wrap()` helper turns thrown errors (with optional `err.status`) into JSON
  responses. The agent endpoint is the one exception to the JSON pattern: it
  streams `text/plain` chunks and kills the child process on `req.close`.
- **`server/github.js`** — all GitHub REST access via built-in `fetch`. The `gh()`
  helper centralizes auth headers and error normalization. `parsePrRef()` accepts
  a full PR URL or `owner/repo#123`. Note the **two comment systems**: top-level
  conversation comments use the `/issues/{n}/comments` endpoint; inline code
  comments use `/pulls/{n}/comments` and require `commit_id` + `path` + `line`.
- **`server/agent.js`** — spawns Claude Code and translates its `stream-json`
  output (one JSON event per line) into readable console text via `formatEvent`.
  This is the part a browser fundamentally can't do — it needs a local process
  with filesystem access. `buildAgentArgs()` (exported, unit-tested) assembles
  the CLI args and threads **multi-turn session** flags: the first turn of a
  conversation passes `--session-id <uuid>` (the frontend mints the UUID), and
  later turns pass `--resume <uuid>` to continue the same Claude Code session —
  the two are mutually exclusive. `runAgent` takes `sessionId` + `resume`, which
  `/api/agent` reads from the request body.
- **`server/checks.js`** — detects the repo's test/lint command
  (`detectCheckCommand`: `package.json` scripts → README → CLAUDE.md → language
  markers; no CI parsing) and runs it (`runChecks`) by spawning a shell in the
  checkout, streaming output back. Exit code 0 = pass. Surfaced via
  `GET /api/checks/detect` and the streaming `POST /api/checks/run` (the second
  text/plain streaming endpoint besides `/api/agent`).

**Agent capability** is governed by `AGENT_TOOLS` in `agent.js` — there is no
review/fix toggle. The chat agent always gets the full, edit-capable tool set
(`--permission-mode acceptEdits` with Read/Write/Edit/Glob/Grep/full Bash) so it
can carry out whatever the user asks. A separate `READONLY_TOOLS` set
(`Read Glob Grep Bash(git*)`, Write/Edit disallowed) is used only by the internal
PR-breakdown task (`runBreakdown`), which just reads the checkout to emit JSON.

When changing what the chat agent can do, edit `AGENT_TOOLS` — this is the single
place that governs its capability. `resolveAgentCwd` runs the agent in the user's
checkout when the repo path is valid, and falls back to a temp dir otherwise so
question-only turns still work without a checkout. Commits and pushes stay manual
(the tool never commits for the user).

### Frontend (`public/app.js`, vanilla JS, no framework)

Single global `state` object holding open PR tabs, persisted to `localStorage`
(`persist()`/`loadPersisted()`); tabs are keyed by `owner/repo#number` via
`keyOf()`. The agent console reads the streaming `/api/agent` response with a
`ReadableStream` reader and appends decoded chunks live. Diffs are rendered from
GitHub's per-file `patch` strings parsed client-side by `parsePatch()`.

**Per-tab chat / sessions.** Each tab owns a conversation in
`state.conversations[key] = { sessionId, started, turns: [{ role, text, cls? }] }`
(`conversationFor()` lazily creates one with `crypto.randomUUID()`;
`resetConversation()` — wired to the **New chat** button — starts a fresh
thread). `runAgent()` records the user's turn, streams the reply (accumulating
it into one `agent` turn), and flips `started → true` on completion so the next
message resumes the session. Checks append their own `out` turns
(header/body/result, each with an optional `cls`) to the active tab so the
trust signal persists too. `renderTranscript(key)` rebuilds the console from
the stored turns and is called from `activate()`, so switching tabs swaps
threads; transcripts persist across reloads. Because the console is a single
global element shared by every tab, run output is routed through `emit()`: it
buffers each fragment on the module-level `liveRun = { key, pieces }` and only
paints to the DOM while that run's tab is on screen — so a run that keeps
streaming after a tab switch never bleeds into another tab, and switching back
replays its in-progress output. Chat is **turn-based** — headless
`claude -p` runs each turn to completion and can't pause mid-run, so the agent
"asks for input" by ending a turn with a question that the user's next message
answers. The **Clear** button only wipes the screen; **New chat** resets the
thread.

### Request flow

Browser `fetch` → `/api/*` in `index.js` → `github.js` (GitHub data),
`agent.js` (spawns `claude`), or `checks.js` (test/lint commands). Diff data is
GitHub's per-file patch, so unchanged regions far from edits and large/binary
files are omitted by design. The console header's test/lint command field
auto-fills from `/api/checks/detect`, and the override persists per repo path in
`localStorage`. Checks are run manually via the "Run checks" button.

**What triggers checks.** Checks run only via the "Run checks" button, handled by
`runChecksFlow()` (`app.js`). It's available any time and independent of the
agent.

Note the boundary: checks are **not** run by the Claude agent. The agent only
edits files; `runChecks()` in `checks.js` spawns the command directly via a shell
from the server, outside the agent's tool sandbox. Exit code 0 = pass.
