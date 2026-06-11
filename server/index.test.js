import { test, before, after } from "node:test";
import assert from "node:assert";
import { app } from "./index.js";
import { parsePrRef } from "./github.js";

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
});

test("GET /api/agent/modes returns expected mode info shape", async () => {
  const res = await fetch(`${baseUrl}/api/agent/modes`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  for (const mode of ["review", "fix"]) {
    assert.ok(body[mode], `expected ${mode} in mode info`);
    assert.strictEqual(typeof body[mode].label, "string");
    assert.strictEqual(typeof body[mode].description, "string");
    assert.ok(Array.isArray(body[mode].allowed));
    assert.ok(Array.isArray(body[mode].disallowed));
  }
});

test("parsePrRef parses a full PR URL", () => {
  const ref = parsePrRef("https://github.com/octocat/hello-world/pull/42");
  assert.deepStrictEqual(ref, { owner: "octocat", repo: "hello-world", number: 42 });
});

test("parsePrRef parses owner/repo#123 shorthand", () => {
  const ref = parsePrRef("octocat/hello-world#42");
  assert.deepStrictEqual(ref, { owner: "octocat", repo: "hello-world", number: 42 });
});

test("parsePrRef throws with status 400 on invalid input", () => {
  assert.throws(
    () => parsePrRef("not a pr reference"),
    (err) => err.status === 400
  );
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
