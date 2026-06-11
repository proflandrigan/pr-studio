import process from "node:process";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

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
  getFileContent,
  listMyPullRequests,
  hasToken,
  tokenSource,
} from "./github.js";
import { runAgent, runBreakdown, MODE_INFO, CLAUDE_BIN } from "./agent.js";
import { normalizeChunks } from "./breakdown.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(__dirname, "..", "public")));
app.use("/vendor/marked", express.static(join(__dirname, "..", "node_modules", "marked", "lib")));

const PORT = process.env.PORT || 4317;

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

app.get("/api/health", (req, res) => {
  res.json({
    githubToken: hasToken(),
    tokenSource: tokenSource(),
    defaultRepoPath: process.env.DEFAULT_REPO_PATH || null,
    claudeAvailable: checkClaudeAvailable(),
  });
});

app.get("/api/agent/modes", (req, res) => {
  res.json(MODE_INFO);
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
    const { owner, repo, number, body, path, line, commitId, side } = req.body;
    if (!body || !body.trim()) {
      res.status(400).json({ error: "Comment body is empty." });
      return;
    }
    let result;
    if (path && line && commitId) {
      result = await postInlineComment({ owner, repo, number, body, path, line, commitId, side: side || "RIGHT" });
    } else {
      result = await postConversationComment({ owner, repo, number, body });
    }
    res.json({ ok: true, url: result.html_url });
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

// Streams Claude Code output back as plain text chunks.
app.post("/api/agent", (req, res) => {
  const { prompt, repoPath, mode } = req.body || {};
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  const child = runAgent({
    prompt,
    repoPath: repoPath || process.env.DEFAULT_REPO_PATH,
    mode,
    onData: (text) => res.write(text),
    onError: (text) => res.write("\n\u26a0 " + text.replace(/\n/g, "\n\u26a0 ")),
    onClose: (code) => res.end(`\n[exit ${code}]\n`),
  });

  req.on("close", () => {
    if (child && !child.killed) child.kill("SIGTERM");
  });
});

export { app };

// Only start listening when run directly (node server/index.js), not when
// imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, () => {
    console.log(`\n  PR Studio running → http://localhost:${PORT}\n`);
    if (!hasToken()) {
      console.log("  ⚠  No GitHub token (GITHUB_TOKEN or `gh auth login`) — browse public PRs only, can't post comments.");
    }
    console.log("");
  });
}
