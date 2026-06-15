import { test, before, after } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.PR_STUDIO_STATE_DIR = mkdtempSync(join(tmpdir(), "indexroutes-state-"));

import { app } from "./index.js";
import { parsePrRef, repoFromUrl } from "./github.js";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function gitCmd(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "indexroutes-repo-"));
  gitCmd(dir, ["init", "-b", "main"]);
  gitCmd(dir, ["config", "user.email", "test@example.com"]);
  gitCmd(dir, ["config", "user.name", "Test User"]);

  writeFileSync(join(dir, "foo.txt"), "line one\nline two\n");
  gitCmd(dir, ["add", "foo.txt"]);
  gitCmd(dir, ["commit", "-m", "Initial commit"]);

  gitCmd(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "foo.txt"), "line one\nline two\nline three\n");
  writeFileSync(join(dir, "bar.txt"), "new file content\n");
  gitCmd(dir, ["add", "foo.txt", "bar.txt"]);
  gitCmd(dir, ["commit", "-m", "Add bar.txt and update foo.txt"]);

  return dir;
}

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("GET /api/health returns expected shape", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(typeof body.githubToken, "boolean");
  assert.ok(body.tokenSource === null || typeof body.tokenSource === "string");
  assert.ok(body.defaultRepoPath === null || typeof body.defaultRepoPath === "string");
  assert.strictEqual(typeof body.claudeAvailable, "boolean");
  assert.strictEqual(typeof body.bootId, "string");
  assert.ok(body.bootId.length > 0);
});

test("parsePrRef parses a full PR URL", () => {
  const ref = parsePrRef("https://github.com/octocat/hello-world/pull/42");
  assert.deepStrictEqual(ref, { owner: "octocat", repo: "hello-world", number: 42 });
});

test("parsePrRef parses owner/repo#123 shorthand", () => {
  const ref = parsePrRef("octocat/hello-world#42");
  assert.deepStrictEqual(ref, { owner: "octocat", repo: "hello-world", number: 42 });
});

test("GET /api/fs/list returns path, parent and dir entries", async () => {
  const res = await fetch(
    `${baseUrl}/api/fs/list?path=${encodeURIComponent(projectRoot)}`
  );
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(typeof body.path, "string");
  assert.ok(body.parent === null || typeof body.parent === "string");
  assert.ok(Array.isArray(body.entries));
  const names = body.entries.map((e) => e.name);
  assert.ok(names.includes("server"));
  assert.ok(names.includes("public"));
  for (const e of body.entries) {
    assert.strictEqual(typeof e.name, "string");
    assert.ok(e.path.endsWith(e.name));
  }
});

test("GET /api/fs/list with a bad path returns 400 JSON error", async () => {
  const res = await fetch(
    `${baseUrl}/api/fs/list?path=${encodeURIComponent("/no/such/dir/xyz")}`
  );
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(typeof body.error, "string");
});

test("GET /api/fs/list with no path defaults to a directory", async () => {
  const res = await fetch(`${baseUrl}/api/fs/list`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(typeof body.path, "string");
});

test("parsePrRef throws with status 400 on invalid input", () => {
  assert.throws(
    () => parsePrRef("not a pr reference"),
    (err) => err.status === 400
  );
});

test("repoFromUrl extracts owner and repo from a repository_url", () => {
  assert.deepStrictEqual(
    repoFromUrl("https://api.github.com/repos/octocat/hello-world"),
    { owner: "octocat", repo: "hello-world" }
  );
});

test("repoFromUrl tolerates a trailing slash", () => {
  assert.deepStrictEqual(
    repoFromUrl("https://api.github.com/repos/octocat/hello-world/"),
    { owner: "octocat", repo: "hello-world" }
  );
});

test("repoFromUrl returns null for unmatched input", () => {
  assert.strictEqual(repoFromUrl("garbage"), null);
  assert.strictEqual(repoFromUrl(""), null);
  assert.strictEqual(repoFromUrl(null), null);
});

test("GET /api/pr with missing url returns 400 JSON error", async () => {
  const res = await fetch(`${baseUrl}/api/pr`);
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(typeof body.error, "string");
});

test("GET /api/pr with unparsable url returns 400 JSON error", async () => {
  const res = await fetch(`${baseUrl}/api/pr?url=garbage`);
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(typeof body.error, "string");
});

test("GET /api/pr/file with missing params returns 400 JSON error", async () => {
  const res = await fetch(`${baseUrl}/api/pr/file?owner=octocat&repo=hello-world`);
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(typeof body.error, "string");
});

test("POST /api/pr/thread/resolve without threadId returns 400", async () => {
  const res = await fetch(`${baseUrl}/api/pr/thread/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolved: true }),
  });
  assert.equal(res.status, 400);
});

test("POST /api/pr/comment with empty body returns 400", async () => {
  const res = await fetch(`${baseUrl}/api/pr/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner: "octocat", repo: "hello-world", number: 1, body: "" }),
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(typeof body.error, "string");
});

test("POST /api/pr/breakdown with no files returns 400", async () => {
  const res = await fetch(`${baseUrl}/api/pr/breakdown`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: [] }),
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});

// ---- Local branch review routes ----

test("GET /api/branch/diff with missing base/head returns 400 JSON", async () => {
  const res = await fetch(`${baseUrl}/api/branch/diff?repoPath=${encodeURIComponent(projectRoot)}`);
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(typeof body.error, "string");
});

test("GET /api/branch/comments with missing base/head returns 400 JSON", async () => {
  const res = await fetch(`${baseUrl}/api/branch/comments?repoPath=${encodeURIComponent(projectRoot)}`);
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(typeof body.error, "string");
});

test("POST /api/branch/comment with empty body returns 400", async () => {
  const res = await fetch(`${baseUrl}/api/branch/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPath: projectRoot, base: "main", head: "feature", body: "" }),
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(typeof body.error, "string");
});

test("POST /api/branch/thread/resolve with missing threadId returns 400", async () => {
  const res = await fetch(`${baseUrl}/api/branch/thread/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPath: projectRoot, base: "main", head: "feature", resolved: true }),
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(typeof body.error, "string");
});

test("branch review happy path: branches, diff, comment, resolve", async () => {
  const repoPath = makeTempRepo();

  // GET /api/branches
  const branchesRes = await fetch(`${baseUrl}/api/branches?repoPath=${encodeURIComponent(repoPath)}`);
  assert.strictEqual(branchesRes.status, 200);
  const branchesBody = await branchesRes.json();
  assert.strictEqual(branchesBody.current, "feature");
  assert.ok(branchesBody.branches.includes("main"));
  assert.ok(branchesBody.branches.includes("feature"));
  assert.strictEqual(branchesBody.defaultBase, "main");

  // GET /api/branch/diff
  const diffRes = await fetch(
    `${baseUrl}/api/branch/diff?repoPath=${encodeURIComponent(repoPath)}&base=main&head=feature`
  );
  assert.strictEqual(diffRes.status, 200);
  const diffBody = await diffRes.json();
  assert.strictEqual(diffBody.headRef, "feature");
  assert.strictEqual(diffBody.baseRef, "main");
  assert.ok(Array.isArray(diffBody.files));
  assert.ok(diffBody.files.length > 0);
  assert.strictEqual(diffBody.repoPath, repoPath);
  assert.strictEqual(diffBody.base, "main");
  assert.strictEqual(diffBody.head, "feature");

  const changedFile = diffBody.files[0].filename;

  // POST /api/branch/comment (inline)
  const commentRes = await fetch(`${baseUrl}/api/branch/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repoPath,
      base: "main",
      head: "feature",
      path: changedFile,
      line: 1,
      body: "note",
    }),
  });
  assert.strictEqual(commentRes.status, 200);
  const commentBody = await commentRes.json();
  assert.strictEqual(commentBody.ok, true);

  // GET /api/branch/comments
  const commentsRes = await fetch(
    `${baseUrl}/api/branch/comments?repoPath=${encodeURIComponent(repoPath)}&base=main&head=feature`
  );
  assert.strictEqual(commentsRes.status, 200);
  const commentsBody = await commentsRes.json();
  assert.strictEqual(commentsBody.inline.length, 1);
  assert.strictEqual(commentsBody.inline[0].body, "note");
  const threadId = commentsBody.inline[0].threadId;
  assert.ok(threadId);

  // POST /api/branch/thread/resolve
  const resolveRes = await fetch(`${baseUrl}/api/branch/thread/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPath, base: "main", head: "feature", threadId, resolved: true }),
  });
  assert.strictEqual(resolveRes.status, 200);
  const resolveBody = await resolveRes.json();
  assert.strictEqual(resolveBody.ok, true);

  // Re-GET comments — resolved should now be true
  const commentsRes2 = await fetch(
    `${baseUrl}/api/branch/comments?repoPath=${encodeURIComponent(repoPath)}&base=main&head=feature`
  );
  const commentsBody2 = await commentsRes2.json();
  assert.strictEqual(commentsBody2.inline[0].resolved, true);
});
