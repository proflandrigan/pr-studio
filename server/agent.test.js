import { test } from "node:test";
import assert from "node:assert";
import { extractJson, buildBreakdownPrompt } from "./agent.js";

test("extractJson parses a plain JSON array string", () => {
  const result = extractJson('[{"title":"a"}]');
  assert.deepStrictEqual(result, [{ title: "a" }]);
});

test("extractJson parses a ```json fenced array", () => {
  const text = "```json\n[{\"title\":\"a\"}]\n```";
  const result = extractJson(text);
  assert.deepStrictEqual(result, [{ title: "a" }]);
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
