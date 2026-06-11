# PR Studio — Feedback v1

What would make PR Studio more attractive to developers. Ordered most-impactful
first. The throughline: deepen the local **review → fix → verify** loop without
breaking the `MODES` trust boundary that makes the agent safe to run.

---

## 1. Close the review → fix → verify loop

The agent can read (`review` mode) or edit (`fix` mode), but the developer still
has to mentally bridge "the agent changed files" and "is the PR actually better."

- **Show the agent's diff inline against the PR diff.** After a `fix` run,
  render `git diff` from the checkout in the same diff UI already used for GitHub
  patches — same visual language, no context switch.
- **One-click "address this comment."** Turn an inline comment into an agent
  prompt scoped to that file/line with the comment text as context. Highest-
  leverage feature for a review tool: feedback → action in one click. (The
  `pr-comment-review` skill is this workflow; bring it into the UI.)
- **Run checks after a fix.** Let the agent run the repo's test/lint command in
  `fix` mode and stream pass/fail back. "Edited and tests green" is the trust
  signal that makes people accept the edits.

## 2. Kill remaining friction in the core flow

- **Wire up LEFT-side / removed-line comments** (known gap). Reviewers comment on
  deleted lines constantly; not supporting it makes the tool feel partial.
- **Full-file context on demand.** GitHub patches omit unchanged regions. Running
  in a local checkout means the actual file can be read and context expanded —
  something the GitHub web UI can't do as fluidly.
- **Keyboard-driven navigation** (next file, next comment, j/k through hunks).
  Cheap to build, disproportionately loved by power reviewers.

## 3. Make trust legible

The `MODES` permission boundary is the best feature — but it's invisible.

- **Surface the active permission mode prominently** and show which tools the
  agent is allowed before a run. "Read-only" vs "can edit + run bash" should be
  unmissable.
- **Persist a replayable agent transcript per PR.** The `stream-json` → console
  text formatting already exists; saving it lets developers scroll back through
  exactly what the agent did and why.

## 4. Lower the activation cost

- **First-run setup check:** detect token state (PAT vs `gh` CLI vs none) and
  tell the user what they can/can't do before they hit a 403 on comment posting.
- **Multi-PR / review queue view:** a list of open PRs assigned to you, so it
  becomes a daily driver instead of a per-URL tool.

## 5. Earn credibility

- **Add a test suite.** `index.js` is already structured for it (`app` exported,
  no auto-listen). A tool that edits your code while having zero tests of its own
  is a hard sell to the exact audience it targets. Cheapest trust signal here.

---

## Task list

### 1. Review → fix → verify loop
- [ ] Render the agent's `git diff` from the checkout in the existing diff UI after a `fix` run
- [ ] Add "address this comment" — turn an inline comment into a scoped agent prompt
- [ ] Run the repo's test/lint command after a fix and stream pass/fail to the UI

### 2. Core-flow friction
- [x] Wire up LEFT-side / removed-line inline comments
- [ ] Expand full-file context on demand from the local checkout
- [x] Add keyboard navigation (next file, next comment, j/k through hunks)

### 3. Legible trust
- [x] Surface the active permission mode and allowed tools prominently in the UI
- [ ] Persist a replayable agent transcript per PR

### 4. Activation cost
- [x] First-run setup check that reports token state and resulting capabilities
- [ ] Multi-PR / review queue view of PRs assigned to the user

### 5. Credibility
- [x] Add an automated test suite (start with `index.js` API endpoints)
