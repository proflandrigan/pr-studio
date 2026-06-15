#!/usr/bin/env node
import process from "node:process";
import express from "express";
import { fileURLToPath } from "node:url";
import { realpathSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, parse as parsePath } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Load .env if present (built-in, no dependency). Safe to ignore if missing.
try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"));
} catch {
  /* no .env file — rely on real environment variables */
}
import {
  parsePrRef,
  getPullRequest,
  getComments,
  postConversationComment,
  postInlineComment,
  replyToReviewComment,
  setReviewThreadResolved,
  getFileContent,
  listMyPullRequests,
  hasToken,
  tokenSource,
} from "./github.js";
import { runAgent, runBreakdown, CLAUDE_BIN } from "./agent.js";
import { detectCheckCommand, runChecks } from "./checks.js";
import { normalizeChunks } from "./breakdown.js";
import { listBranches, getBranchDiff } from "./localreview.js";
import {
  readReview,
  addInlineComment,
  addReply,
  addConversationComment,
  setThreadResolved,
  toCommentsView,
} from "./reviewstore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(__dirname, "..", "public")));
app.use("/vendor/marked", express.static(join(__dirname, "..", "node_modules", "marked", "lib")));

const PORT = process.env.PORT || 4317;

// A fresh id per server process. The frontend compares it against the last
// value it saw; a change means `npm start` was re-run, which is the signal to
// start every PR tab's chat fresh (clean session, no restored transcript).
const BOOT_ID = randomUUID();

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || "Server error" });
    }
  };
}

function checkClaudeAvailable() {
  try {
    execFileSync(CLAUDE_BIN, ["--version"], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// Open the default browser at `url` on startup. Best-effort and fire-and-forget:
// pick the platform opener, ignore failures (headless/SSH), and never block or
// crash the server. Suppressed when PR_STUDIO_NO_OPEN is set (any truthy value).
function openBrowser(url) {
  if (process.env.PR_STUDIO_NO_OPEN) return;
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // swallow ENOENT etc. — opening is optional
    child.unref();
  } catch {
    /* opening the browser is best-effort; never fail startup over it */
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    githubToken: hasToken(),
    tokenSource: tokenSource(),
    defaultRepoPath: process.env.DEFAULT_REPO_PATH || null,
    claudeAvailable: checkClaudeAvailable(),
    bootId: BOOT_ID,
  });
});

app.get(
  "/api/pr",
  wrap(async (req, res) => {
    const ref = parsePrRef(req.query.url);
    const pr = await getPullRequest(ref);
    res.json(pr);
  })
);

app.get(
  "/api/my-prs",
  wrap(async (req, res) => {
    const prs = await listMyPullRequests();
    res.json({ prs });
  })
);

app.get(
  "/api/pr/comments",
  wrap(async (req, res) => {
    const { owner, repo, number } = req.query;
    const comments = await getComments({ owner, repo, number: Number(number) });
    res.json(comments);
  })
);

app.post(
  "/api/pr/comment",
  wrap(async (req, res) => {
    const { owner, repo, number, body, path, line, commitId, side, replyTo } = req.body;
    if (!body || !body.trim()) {
      res.status(400).json({ error: "Comment body is empty." });
      return;
    }
    let result;
    if (replyTo) {
      result = await replyToReviewComment({ owner, repo, number, commentId: replyTo, body });
    } else if (path && line && commitId) {
      result = await postInlineComment({ owner, repo, number, body, path, line, commitId, side: side || "RIGHT" });
    } else {
      result = await postConversationComment({ owner, repo, number, body });
    }
    res.json({ ok: true, url: result.html_url });
  })
);

app.post(
  "/api/pr/thread/resolve",
  wrap(async (req, res) => {
    const { threadId, resolved } = req.body || {};
    if (!threadId) {
      res.status(400).json({ error: "threadId is required." });
      return;
    }
    const result = await setReviewThreadResolved({ threadId, resolved: resolved !== false });
    res.json({ ok: true, ...result });
  })
);

app.get(
  "/api/pr/file",
  wrap(async (req, res) => {
    const { owner, repo, path, ref } = req.query;
    if (!owner || !repo || !path || !ref) {
      throw Object.assign(new Error("owner, repo, path, ref required"), { status: 400 });
    }
    res.json(await getFileContent({ owner, repo, path, ref }));
  })
);

app.post(
  "/api/pr/breakdown",
  wrap(async (req, res) => {
    const { files, title, repoPath } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      throw Object.assign(new Error("No changed files provided."), { status: 400 });
    }
    const raw = await runBreakdown({
      files,
      title: title || "",
      repoPath: repoPath || process.env.DEFAULT_REPO_PATH,
    });
    const chunks = normalizeChunks(raw, files);
    res.json({ chunks });
  })
);

// ---- Local branch review (no GitHub PR) ----

app.get(
  "/api/branches",
  wrap(async (req, res) => {
    const repoPath = req.query.repoPath || process.env.DEFAULT_REPO_PATH;
    res.json(listBranches(repoPath));
  })
);

app.get(
  "/api/branch/diff",
  wrap(async (req, res) => {
    const repoPath = req.query.repoPath || process.env.DEFAULT_REPO_PATH;
    const { base, head } = req.query;
    if (!base || !head) {
      throw Object.assign(new Error("base and head are required."), { status: 400 });
    }
    const diff = getBranchDiff(repoPath, base, head);
    res.json({ ...diff, repoPath, base, head });
  })
);

app.get(
  "/api/branch/comments",
  wrap(async (req, res) => {
    const repoPath = req.query.repoPath || process.env.DEFAULT_REPO_PATH;
    const { base, head } = req.query;
    if (!base || !head) {
      throw Object.assign(new Error("base and head are required."), { status: 400 });
    }
    res.json(toCommentsView(readReview(repoPath, base, head)));
  })
);

app.post(
  "/api/branch/comment",
  wrap(async (req, res) => {
    const { base, head, body, path, line, side, replyTo } = req.body || {};
    const repoPath = req.body?.repoPath || process.env.DEFAULT_REPO_PATH;
    if (!repoPath || !base || !head) {
      throw Object.assign(new Error("repoPath, base, and head are required."), { status: 400 });
    }
    if (!body || !body.trim()) {
      res.status(400).json({ error: "Comment body is empty." });
      return;
    }
    let result;
    if (replyTo) {
      result = addReply({ repoPath, base, head, threadId: replyTo, body });
    } else if (path && line) {
      result = addInlineComment({ repoPath, base, head, path, line: Number(line), side: side || "RIGHT", body });
    } else {
      result = addConversationComment({ repoPath, base, head, body });
    }
    res.json({ ok: true, ...result });
  })
);

app.post(
  "/api/branch/thread/resolve",
  wrap(async (req, res) => {
    const { base, head, threadId, resolved } = req.body || {};
    const repoPath = req.body?.repoPath || process.env.DEFAULT_REPO_PATH;
    if (!repoPath || !base || !head || !threadId) {
      throw Object.assign(new Error("repoPath, base, head, and threadId are required."), { status: 400 });
    }
    const result = setThreadResolved({ repoPath, base, head, threadId, resolved: resolved !== false });
    res.json({ ok: true, ...result });
  })
);

// Streams Claude Code output back as plain text chunks.
app.post("/api/agent", (req, res) => {
  const { prompt, repoPath, sessionId, resume } = req.body || {};
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  const child = runAgent({
    prompt,
    repoPath: repoPath || process.env.DEFAULT_REPO_PATH,
    sessionId,
    resume,
    onData: (ev) => res.write(JSON.stringify(ev) + "\n"),
    onError: (text) => res.write(JSON.stringify({ type: "notice", level: "error", text }) + "\n"),
    onClose: (code) => res.end(JSON.stringify({ type: "end", code }) + "\n"),
  });

  // Kill the agent only on a genuine client disconnect. Listen on `res`, not
  // `req`: in modern Node the request stream emits "close" as soon as its body
  // is consumed (express.json() reads it up front), which would otherwise tear
  // the child down before it produced any output (seen as "[exit null]").
  res.on("close", () => {
    if (!res.writableFinished && child && !child.killed) child.kill("SIGTERM");
  });
});

app.get(
  "/api/checks/detect",
  wrap(async (req, res) => {
    const repoPath = req.query.repoPath || process.env.DEFAULT_REPO_PATH;
    const detected = detectCheckCommand(repoPath); // { command, source } | null
    res.json(detected || { command: null, source: null });
  })
);

app.get(
  "/api/fs/list",
  wrap(async (req, res) => {
    // Default to the configured checkout, else the user's home dir.
    const raw = req.query.path || process.env.DEFAULT_REPO_PATH || homedir();
    const dir = resolve(raw);

    // Reject non-directories up front with a clean 400.
    let st;
    try {
      st = statSync(dir);
    } catch {
      throw Object.assign(new Error(`Cannot open: ${dir}`), { status: 400 });
    }
    if (!st.isDirectory()) {
      throw Object.assign(new Error(`Not a directory: ${dir}`), { status: 400 });
    }

    // Subdirectories only. Skip entries we can't stat (permission errors) and
    // hidden dotfolders are kept (useful for repos like .config checkouts) but
    // not the . / .. pseudo-entries (readdirSync already omits those).
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => {
          try {
            return e.isDirectory() ||
              (e.isSymbolicLink() && statSync(resolve(dir, e.name)).isDirectory());
          } catch {
            return false;
          }
        })
        .map((e) => ({ name: e.name, path: resolve(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      throw Object.assign(new Error(`Cannot read: ${dir}`), { status: 400 });
    }

    // parent is null when already at the filesystem root.
    const parent = parsePath(dir).root === dir ? null : dirname(dir);
    res.json({ path: dir, parent, entries });
  })
);

// Streams the repo's check/lint command output back as plain text.
app.post("/api/checks/run", (req, res) => {
  const { command, repoPath } = req.body || {};
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  const child = runChecks({
    command,
    repoPath: repoPath || process.env.DEFAULT_REPO_PATH,
    onData: (text) => res.write(text),
    onError: (text) => res.write("\n⚠ " + text.replace(/\n/g, "\n⚠ ")),
    onClose: (code) => res.end(`\n[exit ${code}]\n`),
  });

  // See the /api/agent handler: kill on real client disconnect (res "close"),
  // not on req "close", which now fires as soon as the request body is read.
  res.on("close", () => {
    if (!res.writableFinished && child && !child.killed) child.kill("SIGTERM");
  });
});

export { app };

// Only start listening when run directly (node server/index.js or the global
// `pr-studio` bin), not when imported by a test. When installed globally the
// bin is a symlink, so process.argv[1] is the symlink path while
// import.meta.url resolves to the real file — resolve both before comparing.
const invokedPath = (() => {
  if (!process.argv[1]) return "";
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
})();
if (invokedPath && realpathSync(fileURLToPath(import.meta.url)) === invokedPath) {
  app.listen(PORT, () => {
    console.log(`\n  PR Studio running → http://localhost:${PORT}\n`);
    if (!hasToken()) {
      console.log("  ⚠  No GitHub token (GITHUB_TOKEN or `gh auth login`) — browse public PRs only, can't post comments.");
    }
    console.log("");
    openBrowser(`http://localhost:${PORT}`);
  });
}
