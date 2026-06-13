# PR Studio

A stripped-down pull-request review tool that runs locally and hands tasks to
**Claude Code**. Open PRs as tabs, read the diffs, leave comments, and ask the
agent to make fixes against a local checkout — all from one window.

It's a single Node process: it serves the UI, talks to the GitHub API, and
spawns `claude -p` (Claude Code's headless mode) next to your repos. No build
step, no framework on the frontend, one dependency on the backend.

## Install

You need [Node.js](https://nodejs.org) 20.6+ and, for the agent features,
[Claude Code](https://docs.claude.com/en/docs/claude-code/overview) installed
and signed in (`claude` on your PATH).

Run it without installing:

```bash
GITHUB_TOKEN=ghp_xxx npx pr-studio
```

Or install globally:

```bash
npm install -g pr-studio
pr-studio
```

Either way it reads config from a `.env` file in the current directory or from
the real environment (see [Configure](#configure)). Open
<http://localhost:4317>.

### From a clone

```bash
git clone https://github.com/proflandrigan/pr-studio.git
cd pr-studio
npm install
cp .env.example .env     # then add your GitHub token
npm start
```

## Configure

Edit `.env`:

- `GITHUB_TOKEN` — a Personal Access Token. A fine-grained token with
  **Pull requests: read & write** lets you read private PRs and post comments.
  Without it you can still browse public PRs read-only.
- `DEFAULT_REPO_PATH` — optional. A local clone the agent works in when you
  haven't set a per-PR path in the UI.

## Use

1. Paste a PR URL (or `owner/repo#123`) in the top bar and press Enter. It opens
   as a tab. Open as many as you like.
2. Click a file to expand its diff. Click any added or context line to leave an
   inline comment. Use the box at the bottom of a PR for a general comment.
3. In the **Claude Code** console at the bottom, set the path to your local
   checkout of that repo and type a task. The agent can read, search, run `git`,
   and edit files, so it handles both "summarize the risky changes in this PR"
   and "address the review comments in src/auth.js." Chat is turn-based: each
   message runs to completion, and the agent "asks for input" by ending a turn
   with a question your next message answers. **New chat** starts a fresh thread.

The agent runs in *your* checkout, so after it edits, `git diff` in that repo
shows what it did. Pushing/committing stays in your hands.

### Run checks after an edit

The console header has a **test/lint command** field next to the repo path.
PR Studio auto-detects it from the checkout (your `package.json` `test`/`lint`
scripts, then `README`, then `CLAUDE.md`, then language markers like
`pytest`/`cargo test`/`go test`); you can edit it, and your override is
remembered per checkout. Click **Run checks** to run it and stream the output
into the console — it finishes with a green "✓ Checks passed" or red
"✗ Checks failed" banner. Checks run independently of the agent (the server
spawns the command directly, not through Claude), so you can run them any time —
including after an agent edit to confirm "edited and tests green" in one place.

## Add it to the macOS dock

Because it's a local web app, you can give it a real dock icon:

- **Safari** (Sonoma+): open the app, then **File → Add to Dock**.
- **Chrome / Edge**: the install icon in the address bar, or menu → **Install**.

It opens in its own window, no browser chrome.

## Notes & limits

- Inline comments are posted against the PR head commit on the **right** side of
  the diff (added/context lines). Commenting on removed lines isn't wired up yet.
- The diff view shows GitHub's per-file patch, which omits unchanged regions far
  from edits and very large/binary files.
- This holds your GitHub token in a local `.env` and only talks to
  api.github.com and your local `claude`. Don't expose the port publicly.

## License

[MIT](LICENSE) © proflandrigan

## Layout

```
server/
  index.js     Express server: serves UI + API, streams the agent
  github.js    GitHub REST helpers (PRs, files, comments)
  agent.js     spawns `claude -p` and streams its output
public/
  index.html   app shell
  app.js        tabs, diff rendering, commenting, console (vanilla JS)
  styles.css    styling
  manifest.json + icon.svg   PWA install metadata
```
