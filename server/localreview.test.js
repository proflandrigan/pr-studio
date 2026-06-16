import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitDiff, synthUntrackedDiff, listBranches, getBranchDiff, getFileAtRef, getWorkingFile } from "./localreview.js";

// --- A. parseGitDiff (pure) ----------------------------------------------

test("parseGitDiff: modified file", () => {
  const raw = `diff --git a/foo.txt b/foo.txt
index 1234567..89abcde 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,2 +1,3 @@
 line one
-old line
+new line
+added line
`;
  const files = parseGitDiff(raw);
  assert.strictEqual(files.length, 1);
  const f = files[0];
  assert.strictEqual(f.filename, "foo.txt");
  assert.strictEqual(f.status, "modified");
  assert.strictEqual(f.additions, 2);
  assert.strictEqual(f.deletions, 1);
  assert.ok(f.patch.startsWith("@@"));
});

test("parseGitDiff: added file", () => {
  const raw = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+line one
+line two
`;
  const files = parseGitDiff(raw);
  assert.strictEqual(files.length, 1);
  const f = files[0];
  assert.strictEqual(f.filename, "new.txt");
  assert.strictEqual(f.status, "added");
  assert.strictEqual(f.additions, 2);
  assert.strictEqual(f.deletions, 0);
  assert.ok(f.patch.startsWith("@@"));
});

test("parseGitDiff: deleted file", () => {
  const raw = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 1234567..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;
  const files = parseGitDiff(raw);
  assert.strictEqual(files.length, 1);
  const f = files[0];
  assert.strictEqual(f.filename, "gone.txt");
  assert.strictEqual(f.status, "removed");
  assert.strictEqual(f.additions, 0);
  assert.strictEqual(f.deletions, 2);
});

test("parseGitDiff: multi-file diff", () => {
  const raw = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old a
+new a
diff --git a/b.txt b/b.txt
index 3333333..4444444 100644
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-old b
+new b
`;
  const files = parseGitDiff(raw);
  assert.strictEqual(files.length, 2);
  assert.strictEqual(files[0].filename, "a.txt");
  assert.strictEqual(files[1].filename, "b.txt");
});

test("parseGitDiff: binary file section", () => {
  const raw = `diff --git a/image.png b/image.png
index 1234567..89abcde 100644
Binary files a/image.png and b/image.png differ
`;
  const files = parseGitDiff(raw);
  assert.strictEqual(files.length, 1);
  const f = files[0];
  assert.strictEqual(f.filename, "image.png");
  assert.strictEqual(f.status, "modified");
  assert.strictEqual(f.patch, null);
  assert.strictEqual(f.additions, 0);
  assert.strictEqual(f.deletions, 0);
});

test("parseGitDiff: empty string returns empty array", () => {
  assert.deepStrictEqual(parseGitDiff(""), []);
});

test("synthUntrackedDiff produces a parseable added-file section", () => {
  const parsed = parseGitDiff(synthUntrackedDiff("dir/new.js", "line1\nline2\n"));
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].filename, "dir/new.js");
  assert.strictEqual(parsed[0].status, "added");
  assert.strictEqual(parsed[0].additions, 2);
  assert.ok(parsed[0].patch.includes("+line1"));
});

test("synthUntrackedDiff handles an empty file", () => {
  const parsed = parseGitDiff(synthUntrackedDiff("empty.txt", ""));
  assert.strictEqual(parsed[0].filename, "empty.txt");
  assert.strictEqual(parsed[0].status, "added");
  assert.strictEqual(parsed[0].additions, 0);
});

// --- B. listBranches + getBranchDiff (integration via temp git repo) ----

function gitCmd(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "localreview-test-"));
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

test("listBranches: reports current, branches, and defaultBase", () => {
  const dir = makeTempRepo();
  const result = listBranches(dir);
  assert.strictEqual(result.current, "feature");
  assert.ok(result.branches.includes("main"));
  assert.ok(result.branches.includes("feature"));
  assert.strictEqual(result.defaultBase, "main");
});

test("getBranchDiff: returns PR-shaped diff for feature vs main", () => {
  const dir = makeTempRepo();
  const result = getBranchDiff(dir, "main", "feature");

  assert.strictEqual(result.headRef, "feature");
  assert.strictEqual(result.baseRef, "main");
  assert.strictEqual(result.changedFiles, result.files.length);
  assert.strictEqual(result.changedFiles, 2);

  const bar = result.files.find((f) => f.filename === "bar.txt");
  assert.ok(bar);
  assert.strictEqual(bar.status, "added");

  const foo = result.files.find((f) => f.filename === "foo.txt");
  assert.ok(foo);
  assert.strictEqual(foo.status, "modified");
});

test("getBranchDiff: throws on an invalid ref", () => {
  const dir = makeTempRepo();
  assert.throws(() => getBranchDiff(dir, "main", "no-such-branch"), /no-such-branch/);
});

test("getWorkingFile: reads the working-tree bytes, not the committed version", () => {
  const dir = makeTempRepo();
  // Uncommitted edit to a tracked file + a brand-new untracked file.
  writeFileSync(join(dir, "foo.txt"), "edited working content\n");
  writeFileSync(join(dir, "created.txt"), "agent made this\n");

  assert.strictEqual(getWorkingFile(dir, "foo.txt").content, "edited working content\n");
  // git show HEAD:created.txt would fail; the working-tree read must succeed.
  assert.strictEqual(getWorkingFile(dir, "created.txt").content, "agent made this\n");
});

test("getWorkingFile: rejects a path that escapes the repository", () => {
  const dir = makeTempRepo();
  assert.throws(() => getWorkingFile(dir, "../../etc/passwd"), /escapes repository/);
});

test("listBranches: throws on a non-git directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "localreview-nogit-"));
  assert.throws(() => listBranches(dir), /Not a git repository/);
});

test("getFileAtRef: returns file content at a given ref", () => {
  const dir = makeTempRepo();
  // foo.txt was modified on `feature`; assert each ref sees its own version.
  assert.strictEqual(getFileAtRef(dir, "feature", "foo.txt").content, "line one\nline two\nline three\n");
  assert.strictEqual(getFileAtRef(dir, "main", "foo.txt").content, "line one\nline two\n");
  assert.strictEqual(getFileAtRef(dir, "feature", "bar.txt").content, "new file content\n");
});

test("getFileAtRef: throws on a missing path or invalid ref", () => {
  const dir = makeTempRepo();
  assert.throws(() => getFileAtRef(dir, "feature", "nope.txt"), /git show/);
  assert.throws(() => getFileAtRef(dir, "no-such-ref", "foo.txt"), /Not a valid ref/);
});
