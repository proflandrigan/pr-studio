import { test } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { extractJson, buildBreakdownPrompt, buildAgentArgs, formatEvent, resolveAgentCwd, isSessionNotFoundError } from "./agent.js";

test("resolveAgentCwd falls back to a temp dir for review with no path", () => {
  const r = resolveAgentCwd({ repoPath: "", mode: "review" });
  assert.strictEqual(r.cwd, tmpdir());
  assert.strictEqual(r.error, undefined);
});

test("resolveAgentCwd falls back to a temp dir for review with a bogus path", () => {
  const r = resolveAgentCwd({ repoPath: "/no/such/dir/here", mode: "review" });
  assert.strictEqual(r.cwd, tmpdir());
  assert.strictEqual(r.error, undefined);
});

test("resolveAgentCwd errors for fix mode with no valid checkout", () => {
  const empty = resolveAgentCwd({ repoPath: "", mode: "fix" });
  assert.strictEqual(empty.cwd, undefined);
  assert.match(empty.error, /Repo path not found/);

  const bogus = resolveAgentCwd({ repoPath: "/no/such/dir/here", mode: "fix" });
  assert.strictEqual(bogus.cwd, undefined);
  assert.match(bogus.error, /Repo path not found/);
});

test("resolveAgentCwd uses a real directory in any mode", () => {
  const review = resolveAgentCwd({ repoPath: process.cwd(), mode: "review" });
  assert.strictEqual(review.cwd, process.cwd());
  assert.strictEqual(review.error, undefined);

  const fix = resolveAgentCwd({ repoPath: process.cwd(), mode: "fix" });
  assert.strictEqual(fix.cwd, process.cwd());
  assert.strictEqual(fix.error, undefined);
});

test("extractJson parses a plain JSON array string", () => {
  const result = extractJson('[{"title":"a"}]');
  assert.deepStrictEqual(result, [{ title: "a" }]);
});

test("extractJson parses a ```json fenced array", () => {
  const text = "```json\n[{\"title\":\"a\"}]\n```";
  const result = extractJson(text);
  assert.deepStrictEqual(result, [{ title: "a" }]);
});

test("buildAgentArgs omits session flags when no sessionId", () => {
  const args = buildAgentArgs({ prompt: "hi", mode: "review" });
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("hi"));
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("stream-json"));
  assert.ok(!args.includes("--session-id"));
  assert.ok(!args.includes("--resume"));
  assert.ok(args.includes("--disallowedTools"));
});

test("buildAgentArgs uses --session-id for a new session", () => {
  const args = buildAgentArgs({ prompt: "hi", mode: "fix", sessionId: "abc-123" });
  const i = args.indexOf("--session-id");
  assert.ok(i !== -1);
  assert.strictEqual(args[i + 1], "abc-123");
  assert.ok(!args.includes("--resume"));
  assert.ok(args.includes("--permission-mode"));
  assert.ok(args.includes("acceptEdits"));
});

test("buildAgentArgs uses --resume for a continued session", () => {
  const args = buildAgentArgs({ prompt: "hi", mode: "fix", sessionId: "abc-123", resume: true });
  const i = args.indexOf("--resume");
  assert.ok(i !== -1);
  assert.strictEqual(args[i + 1], "abc-123");
  assert.ok(!args.includes("--session-id"));
});

test("buildAgentArgs falls back to review flags for unknown mode", () => {
  const args = buildAgentArgs({ prompt: "hi", mode: "nonexistent" });
  assert.ok(args.includes("--disallowedTools"));
});

test("extractJson parses an array embedded in surrounding prose", () => {
  const text = 'Here is the breakdown:\n[{"title":"a"}]\nDone.';
  const result = extractJson(text);
  assert.deepStrictEqual(result, [{ title: "a" }]);
});

test("extractJson throws on non-JSON garbage", () => {
  assert.throws(() => extractJson("not json at all"), /Could not parse JSON from agent output/);
});

test("extractJson throws when passed a non-string", () => {
  assert.throws(() => extractJson(null), /No agent output to parse/);
});

test("buildBreakdownPrompt includes title, filenames, and JSON array instruction", () => {
  const prompt = buildBreakdownPrompt({
    title: "My PR",
    files: [{ filename: "a.js", status: "modified", additions: 1, deletions: 0, patch: "@@ x" }],
  });
  assert.ok(prompt.includes("My PR"));
  assert.ok(prompt.includes("a.js"));
  assert.ok(prompt.includes("JSON array"));
});

test("formatEvent drops the result/cost footer", () => {
  assert.equal(formatEvent({ type: "result", total_cost_usd: 0.94 }), "");
});

test("formatEvent drops the session-init banner", () => {
  assert.equal(formatEvent({ type: "system", subtype: "init", session_id: "abc" }), "");
});

test("formatEvent renders assistant text", () => {
  const out = formatEvent({
    type: "assistant",
    message: { content: [{ type: "text", text: "hello" }] },
  });
  assert.equal(out, "hello");
});

test("formatEvent renders tool_use lines", () => {
  const out = formatEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.js" } }] },
  });
  assert.equal(out, "\n  → Read(a.js)\n");
});

test("isSessionNotFoundError matches Claude's resume-not-found message", () => {
  assert.ok(isSessionNotFoundError("No conversation found with session ID: abc-123"));
});

test("isSessionNotFoundError is case-insensitive and tolerates surrounding text", () => {
  assert.ok(isSessionNotFoundError("Error: NO CONVERSATION FOUND with Session Id 9f8e"));
  assert.ok(isSessionNotFoundError("\n[banner]\nno conversation found with session id deadbeef\n"));
});

test("isSessionNotFoundError returns false for unrelated errors and empty input", () => {
  assert.ok(!isSessionNotFoundError(""));
  assert.ok(!isSessionNotFoundError(null));
  assert.ok(!isSessionNotFoundError(undefined));
  assert.ok(!isSessionNotFoundError("Permission denied"));
  assert.ok(!isSessionNotFoundError("session id provided but conversation loaded fine"));
});
