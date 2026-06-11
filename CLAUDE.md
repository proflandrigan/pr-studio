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

Three backend modules, each a focused concern, wired together in `index.js`:

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
  with filesystem access.

**Permission modes** (`MODES` in `agent.js`) are the core safety boundary:
- `review` — read-only: `--allowedTools Read Glob Grep Bash(git*)`, Write/Edit
  explicitly disallowed.
- `fix` — `--permission-mode acceptEdits` with Write/Edit/full Bash allowed.

When changing what the agent can do, edit `MODES` — this is the single place that
governs agent capability. The agent always runs in the user's checkout; commits
and pushes stay manual (the tool never commits for the user).

### Frontend (`public/app.js`, vanilla JS, no framework)

Single global `state` object holding open PR tabs, persisted to `localStorage`
(`persist()`/`loadPersisted()`); tabs are keyed by `owner/repo#number` via
`keyOf()`. The agent console reads the streaming `/api/agent` response with a
`ReadableStream` reader and appends decoded chunks live. Diffs are rendered from
GitHub's per-file `patch` strings parsed client-side by `parsePatch()`.

### Request flow

Browser `fetch` → `/api/*` in `index.js` → `github.js` (GitHub data) or
`agent.js` (spawns `claude`). Diff data is GitHub's per-file patch, so unchanged
regions far from edits and large/binary files are omitted by design.
