import process from "node:process";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  hasToken,
} from "./github.js";
import { runAgent } from "./agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(__dirname, "..", "public")));

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

app.get("/api/health", (req, res) => {
  res.json({
    githubToken: hasToken(),
    defaultRepoPath: process.env.DEFAULT_REPO_PATH || null,
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
    const { owner, repo, number, body, path, line, commitId } = req.body;
    if (!body || !body.trim()) {
      res.status(400).json({ error: "Comment body is empty." });
      return;
    }
    let result;
    if (path && line && commitId) {
      result = await postInlineComment({ owner, repo, number, body, path, line, commitId });
    } else {
      result = await postConversationComment({ owner, repo, number, body });
    }
    res.json({ ok: true, url: result.html_url });
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
