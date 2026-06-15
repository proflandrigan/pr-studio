import { test, before, after } from "node:test";
import assert from "node:assert";
import { app } from "./index.js";
import { parsePrRef, repoFromUrl } from "./github.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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
