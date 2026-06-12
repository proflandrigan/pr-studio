import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCheckCommand } from "./checks.js";

function tmpRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "checks-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test("package.json with test and lint scripts", () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({ scripts: { test: "jest", lint: "eslint ." } }),
  });
  assert.deepStrictEqual(detectCheckCommand(dir), {
    command: "npm test && npm run lint",
    source: "package.json",
  });
});

test("package.json with test script only", () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({ scripts: { test: "jest" } }),
  });
  assert.deepStrictEqual(detectCheckCommand(dir), {
    command: "npm test",
    source: "package.json",
  });
});

test("package.json with npm default placeholder test falls through to language", () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }),
  });
  assert.deepStrictEqual(detectCheckCommand(dir), {
    command: "npm test",
    source: "language",
  });
});

test("Cargo.toml only detects cargo test", () => {
  const dir = tmpRepo({ "Cargo.toml": "[package]\nname = \"foo\"\n" });
  assert.deepStrictEqual(detectCheckCommand(dir), {
    command: "cargo test",
    source: "language",
  });
});

test("go.mod only detects go test", () => {
  const dir = tmpRepo({ "go.mod": "module example.com/foo\n" });
  assert.deepStrictEqual(detectCheckCommand(dir), {
    command: "go test ./...",
    source: "language",
  });
});

test("pyproject.toml only detects pytest", () => {
  const dir = tmpRepo({ "pyproject.toml": "[tool.poetry]\nname = \"foo\"\n" });
  assert.deepStrictEqual(detectCheckCommand(dir), {
    command: "pytest",
    source: "language",
  });
});

test("Makefile with test target detects make test", () => {
  const dir = tmpRepo({ Makefile: "test:\n\tpytest\n" });
  assert.deepStrictEqual(detectCheckCommand(dir), {
    command: "make test",
    source: "language",
  });
});

test("CLAUDE.md command scan strips $ prompt", () => {
  const dir = tmpRepo({
    "CLAUDE.md": "Run tests with:\n```\n$ npm test\n```\n",
  });
  assert.deepStrictEqual(detectCheckCommand(dir), {
    command: "npm test",
    source: "CLAUDE.md",
  });
});

test("README scan finds pytest command", () => {
  const dir = tmpRepo({
    "README.md": "## Testing\n\npytest -q\n",
  });
  const result = detectCheckCommand(dir);
  assert.ok(result.command.startsWith("pytest"));
  assert.strictEqual(result.source, "README");
});

test("returns null when nothing is found", () => {
  const dir = tmpRepo({});
  assert.strictEqual(detectCheckCommand(dir), null);
});

test("returns null for a non-existent path without throwing", () => {
  assert.strictEqual(detectCheckCommand("/no/such/dir"), null);
});
