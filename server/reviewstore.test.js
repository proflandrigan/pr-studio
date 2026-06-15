import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.PR_STUDIO_STATE_DIR = mkdtempSync(join(tmpdir(), "reviewstore-test-"));

import {
  readReview,
  addInlineComment,
  addReply,
  addConversationComment,
  setThreadResolved,
  toCommentsView,
} from "./reviewstore.js";

test("readReview on a never-written review returns a fresh empty store", () => {
  const store = readReview("/tmp/some/repo", "main", "feature-a");
  assert.deepStrictEqual(store, {
    repoPath: resolve("/tmp/some/repo"),
    base: "main",
    head: "feature-a",
    conversation: [],
    threads: [],
  });
});

test("addInlineComment creates a thread with one comment, then readReview sees it", () => {
  const repoPath = "/tmp/some/repo";
  const { thread } = addInlineComment({
    repoPath,
    base: "main",
    head: "feature-b",
    path: "src/x.js",
    line: 42,
    body: "what is this for?",
  });

  assert.strictEqual(thread.path, "src/x.js");
  assert.strictEqual(thread.line, 42);
  assert.strictEqual(thread.originalLine, 42);
  assert.strictEqual(thread.side, "RIGHT");
  assert.strictEqual(thread.resolved, false);
  assert.strictEqual(thread.comments.length, 1);
  assert.strictEqual(thread.comments[0].body, "what is this for?");

  const store = readReview(repoPath, "main", "feature-b");
  assert.strictEqual(store.threads.length, 1);
  assert.strictEqual(store.threads[0].id, thread.id);
  assert.strictEqual(store.threads[0].comments.length, 1);
});

test("addReply appends to a thread; bogus threadId throws 404", () => {
  const repoPath = "/tmp/some/repo";
  const base = "main";
  const head = "feature-c";

  const { thread } = addInlineComment({
    repoPath,
    base,
    head,
    path: "src/y.js",
    line: 10,
    side: "LEFT",
    body: "first comment",
  });

  addReply({ repoPath, base, head, threadId: thread.id, body: "a reply" });

  const store = readReview(repoPath, base, head);
  assert.strictEqual(store.threads.length, 1);
  assert.strictEqual(store.threads[0].comments.length, 2);
  assert.strictEqual(store.threads[0].comments[1].body, "a reply");
  assert.strictEqual(store.threads[0].side, "LEFT");

  assert.throws(
    () => addReply({ repoPath, base, head, threadId: "does-not-exist", body: "x" }),
    (err) => {
      assert.strictEqual(err.status, 404);
      assert.match(err.message, /Thread not found/);
      return true;
    },
  );
});

test("addConversationComment appends to conversation with stamped author", () => {
  const repoPath = "/tmp/some/repo";
  const base = "main";
  const head = "feature-d";

  const comment = addConversationComment({ repoPath, base, head, body: "looks good overall" });

  assert.strictEqual(comment.body, "looks good overall");
  assert.ok(typeof comment.author === "string" && comment.author.length > 0);
  assert.ok(typeof comment.id === "string");
  assert.ok(typeof comment.createdAt === "string");

  const store = readReview(repoPath, base, head);
  assert.strictEqual(store.conversation.length, 1);
  assert.strictEqual(store.conversation[0].body, "looks good overall");
});

test("setThreadResolved flips resolved; bogus threadId throws 404", () => {
  const repoPath = "/tmp/some/repo";
  const base = "main";
  const head = "feature-e";

  const { thread } = addInlineComment({
    repoPath,
    base,
    head,
    path: "src/z.js",
    line: 5,
    body: "needs a fix",
  });

  const result = setThreadResolved({ repoPath, base, head, threadId: thread.id, resolved: true });
  assert.deepStrictEqual(result, { threadId: thread.id, resolved: true });

  const store = readReview(repoPath, base, head);
  assert.strictEqual(store.threads[0].resolved, true);

  assert.throws(
    () => setThreadResolved({ repoPath, base, head, threadId: "nope", resolved: true }),
    (err) => {
      assert.strictEqual(err.status, 404);
      assert.match(err.message, /Thread not found/);
      return true;
    },
  );
});

test("toCommentsView is pure and flattens threads into sorted inline items", () => {
  const store = {
    repoPath: "/tmp/some/repo",
    base: "main",
    head: "feature-f",
    conversation: [
      { id: "c2", author: "alice", body: "second", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "c1", author: "bob", body: "first", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    threads: [
      {
        id: "t1",
        path: "src/a.js",
        line: 7,
        side: "RIGHT",
        originalLine: 7,
        resolved: false,
        comments: [
          { id: "i2", author: "alice", body: "reply", createdAt: "2026-01-02T00:00:00.000Z" },
          { id: "i1", author: "bob", body: "root comment", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      },
    ],
  };

  const view = toCommentsView(store);

  assert.strictEqual(view.inline.length, 2);
  assert.strictEqual(view.inline[0].id, "i1");
  assert.strictEqual(view.inline[1].id, "i2");
  assert.strictEqual(view.inline[0].threadId, "t1");
  assert.strictEqual(view.inline[1].threadId, "t1");
  for (const item of view.inline) {
    assert.strictEqual(item.path, "src/a.js");
    assert.strictEqual(item.line, 7);
    assert.strictEqual(item.originalLine, 7);
    assert.strictEqual(item.side, "RIGHT");
    assert.strictEqual(item.resolved, false);
    assert.strictEqual(item.outdated, false);
  }

  assert.strictEqual(view.conversation.length, 2);
  assert.strictEqual(view.conversation[0].id, "c1");
  assert.strictEqual(view.conversation[1].id, "c2");
});
