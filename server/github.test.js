import { test } from "node:test";
import assert from "node:assert";
import { tagPullRequests, splitDiffByFile } from "./github.js";

function item(id, opts = {}) {
  return {
    id,
    number: opts.number ?? id,
    title: opts.title ?? `PR ${id}`,
    state: opts.state ?? "open",
    draft: opts.draft ?? false,
    user: { login: opts.author ?? "octocat" },
    html_url: `https://github.com/o/r/pull/${opts.number ?? id}`,
    updated_at: opts.updatedAt ?? "2026-01-01T00:00:00Z",
    repository_url: opts.repositoryUrl ?? "https://api.github.com/repos/o/r",
    pull_request: { merged_at: opts.mergedAt ?? null },
  };
}

test("relationship priority: authored beats review-requested beats involved", () => {
  const involves = [item(1), item(2), item(3)];
  const authored = [item(1)];
  const reviewRequested = [item(1), item(2)];

  const result = tagPullRequests({ involves, authored, reviewRequested });

  const pr1 = result.find((p) => p.number === 1);
  const pr2 = result.find((p) => p.number === 2);
  const pr3 = result.find((p) => p.number === 3);

  assert.strictEqual(pr1.relationship, "authored");
  assert.strictEqual(pr2.relationship, "review-requested");
  assert.strictEqual(pr3.relationship, "involved");
});

test("dedupes by id across the three search arrays", () => {
  const involves = [item(1)];
  const authored = [item(1)];

  const result = tagPullRequests({ involves, authored, reviewRequested: [] });

  assert.strictEqual(result.filter((p) => p.number === 1).length, 1);
});

test("status: merged when pull_request.merged_at is set, else state", () => {
  const involves = [
    item(1, { state: "closed", mergedAt: "2026-02-01T00:00:00Z" }),
    item(2, { state: "closed" }),
    item(3, { state: "open" }),
  ];

  const result = tagPullRequests({ involves, authored: [], reviewRequested: [] });

  assert.strictEqual(result.find((p) => p.number === 1).status, "merged");
  assert.strictEqual(result.find((p) => p.number === 2).status, "closed");
  assert.strictEqual(result.find((p) => p.number === 3).status, "open");
});

test("sorts by updatedAt descending", () => {
  const involves = [
    item(1, { updatedAt: "2026-01-01T00:00:00Z" }),
    item(2, { updatedAt: "2026-03-01T00:00:00Z" }),
    item(3, { updatedAt: "2026-02-01T00:00:00Z" }),
  ];

  const result = tagPullRequests({ involves, authored: [], reviewRequested: [] });

  const updatedAts = result.map((p) => p.updatedAt);
  const sorted = [...updatedAts].sort().reverse();
  assert.deepStrictEqual(updatedAts, sorted);
});

test("drops items whose repository_url does not parse", () => {
  const involves = [item(1), item(2, { repositoryUrl: "not-a-url" })];

  const result = tagPullRequests({ involves, authored: [], reviewRequested: [] });

  assert.strictEqual(result.length, 1);
  assert.ok(!result.some((p) => p.number === 2));
});

test("missing arrays default to empty (no throw)", () => {
  const result = tagPullRequests({ involves: [item(1)] });

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].relationship, "involved");
});

test("splitDiffByFile extracts per-file patch starting at first hunk", () => {
  const diff = [
    "diff --git a/nb.ipynb b/nb.ipynb",
    "index 111..222 100644",
    "--- a/nb.ipynb",
    "+++ b/nb.ipynb",
    "@@ -1,3 +1,3 @@",
    " {",
    "-  \"x\": 1",
    "+  \"x\": 2",
    " }",
    "diff --git a/readme.md b/readme.md",
    "index 333..444 100644",
    "--- a/readme.md",
    "+++ b/readme.md",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const m = splitDiffByFile(diff);
  assert.equal(m.size, 2);
  assert.ok(m.get("nb.ipynb").startsWith("@@ -1,3 +1,3 @@"));
  assert.ok(m.get("nb.ipynb").includes("+  \"x\": 2"));
  assert.equal(m.get("readme.md"), "@@ -1 +1 @@\n-old\n+new");
});

test("splitDiffByFile skips sections with no hunk and handles empty input", () => {
  assert.equal(splitDiffByFile("").size, 0);
  assert.equal(splitDiffByFile(null).size, 0);
  const renameOnly = "diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n";
  assert.equal(splitDiffByFile(renameOnly).size, 0);
});

test("splitDiffByFile strips the trailing tab git adds for paths with spaces", () => {
  // git/GitHub append a trailing tab after the path on ---/+++ lines when the
  // path contains a space; the extracted key must still match the clean filename.
  const diff = [
    "diff --git a/My Analysis.ipynb b/My Analysis.ipynb",
    "index 111..222 100644",
    "--- a/My Analysis.ipynb\t",
    "+++ b/My Analysis.ipynb\t",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const m = splitDiffByFile(diff);
  assert.ok(m.has("My Analysis.ipynb"));
  assert.equal(m.get("My Analysis.ipynb"), "@@ -1 +1 @@\n-old\n+new");
});
