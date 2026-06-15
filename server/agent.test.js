import { test } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { extractJson, buildBreakdownPrompt, buildAgentArgs, resolveAgentCwd, isSessionNotFoundError, eventsFromStreamJson } from "./agent.js";

test("resolveAgentCwd falls back to a temp dir with no path", () => {
  const r = resolveAgentCwd({ repoPath: "" });
  assert.strictEqual(r.cwd, tmpdir());
  assert.strictEqual(r.error, undefined);
});

test("resolveAgentCwd falls back to a temp dir with a bogus path", () => {
  const r = resolveAgentCwd({ repoPath: "/no/such/dir/here" });
  assert.strictEqual(r.cwd, tmpdir());
  assert.strictEqual(r.error, undefined);
});

test("resolveAgentCwd uses a real directory", () => {
  const r = resolveAgentCwd({ repoPath: process.cwd() });
  assert.strictEqual(r.cwd, process.cwd());
  assert.strictEqual(r.error, undefined);
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
  const args = buildAgentArgs({ prompt: "hi" });
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("hi"));
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("stream-json"));
  assert.ok(!args.includes("--session-id"));
  assert.ok(!args.includes("--resume"));
});

test("buildAgentArgs grants the full edit-capable tool set", () => {
  const args = buildAgentArgs({ prompt: "hi" });
  assert.ok(args.includes("--permission-mode"));
  assert.ok(args.includes("acceptEdits"));
  assert.ok(args.includes("Write"));
  assert.ok(args.includes("Edit"));
  assert.ok(args.includes("Bash"));
  // No capability toggle anymore, so nothing is disallowed.
  assert.ok(!args.includes("--disallowedTools"));
});

test("buildAgentArgs uses --session-id for a new session", () => {
  const args = buildAgentArgs({ prompt: "hi", sessionId: "abc-123" });
  const i = args.indexOf("--session-id");
  assert.ok(i !== -1);
  assert.strictEqual(args[i + 1], "abc-123");
  assert.ok(!args.includes("--resume"));
});

test("buildAgentArgs uses --resume for a continued session", () => {
  const args = buildAgentArgs({ prompt: "hi", sessionId: "abc-123", resume: true });
  const i = args.indexOf("--resume");
  assert.ok(i !== -1);
  assert.strictEqual(args[i + 1], "abc-123");
  assert.ok(!args.includes("--session-id"));
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

test("eventsFromStreamJson maps an assistant text block to a text event", () => {
  const out = eventsFromStreamJson({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });
  assert.deepStrictEqual(out, [{ type: "text", text: "hello" }]);
});

test("eventsFromStreamJson maps a tool_use block to a tool event", () => {
  const out = eventsFromStreamJson({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.js" } }] } });
  assert.deepStrictEqual(out, [{ type: "tool", text: "Read(a.js)" }]);
});

test("eventsFromStreamJson keeps interleaved text and tool order", () => {
  const out = eventsFromStreamJson({ type: "assistant", message: { content: [
    { type: "text", text: "let me look" },
    { type: "tool_use", name: "Grep", input: { pattern: "emit" } },
  ] } });
  assert.deepStrictEqual(out, [
    { type: "text", text: "let me look" },
    { type: "tool", text: "Grep(emit)" },
  ]);
});

test("eventsFromStreamJson emits the final result text", () => {
  const out = eventsFromStreamJson({ type: "result", result: "the answer", total_cost_usd: 0.9 });
  assert.deepStrictEqual(out, [{ type: "result", text: "the answer" }]);
});

test("eventsFromStreamJson returns [] for the init banner and empty results", () => {
  assert.deepStrictEqual(eventsFromStreamJson({ type: "system", subtype: "init" }), []);
  assert.deepStrictEqual(eventsFromStreamJson({ type: "result", result: "" }), []);
});
