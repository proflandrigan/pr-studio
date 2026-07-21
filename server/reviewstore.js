// Local comment store for branch reviews: durably persists conversation
// comments and inline comment threads (with replies and resolve state) under
// the PR Studio state dir, keyed by (repoPath, base, head). Never writes into
// the user's repo. Pure view-mapping (`toCommentsView`) is exported so the
// route layer can reuse it without touching the filesystem.

import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";

// Resolves the PR Studio state directory: PR_STUDIO_STATE_DIR (test hook) >
// XDG_CONFIG_HOME/pr-studio > ~/.config/pr-studio. Read lazily inside
// functions so tests that set the env var before calling take effect.
function stateDir() {
  if (process.env.PR_STUDIO_STATE_DIR) return process.env.PR_STUDIO_STATE_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "pr-studio");
  return join(homedir(), ".config", "pr-studio");
}

function reviewsDir() {
  return join(stateDir(), "reviews");
}

// Stable per-(repoPath, base, head) filename, safe for arbitrary branch names.
function reviewFilePath(repoPath, base, head) {
  const hash = createHash("sha256")
    .update(`${resolve(repoPath)} ${base} ${head}`)
    .digest("hex")
    .slice(0, 16);
  return join(reviewsDir(), `${hash}.json`);
}

// Returns the persisted store for (repoPath, base, head), or a fresh empty
// store if none exists yet. Never creates the file.
export function readReview(repoPath, base, head) {
  const file = reviewFilePath(repoPath, base, head);
  if (!existsSync(file)) {
    return { repoPath: resolve(repoPath), base, head, conversation: [], threads: [] };
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

// Persists a store object for (repoPath, base, head), creating the reviews
// dir if needed.
function writeReview(repoPath, base, head, store) {
  mkdirSync(reviewsDir(), { recursive: true });
  writeFileSync(reviewFilePath(repoPath, base, head), JSON.stringify(store, null, 2));
}

// Resolves the comment author for repoPath: git config user.name, falling
// back to the OS username, then "local". Mirrors the author chain in
// localreview.js's getBranchDiff (kept independent / duplicated on purpose).
export function reviewAuthor(repoPath) {
  try {
    const name = execFileSync("git", ["config", "user.name"], { cwd: repoPath, encoding: "utf8" }).trim();
    if (name) return name;
  } catch {
    // fall through
  }
  try {
    const username = userInfo().username;
    if (username) return username;
  } catch {
    // fall through
  }
  return "local";
}

// Creates a new inline comment thread (one comment) and persists it. Returns
// { thread }.
export function addInlineComment({ repoPath, base, head, path, line, side, body }) {
  const store = readReview(repoPath, base, head);
  const now = new Date().toISOString();
  const thread = {
    id: randomUUID(),
    path,
    line,
    side: side || "RIGHT",
    originalLine: line,
    resolved: false,
    comments: [
      {
        id: randomUUID(),
        author: reviewAuthor(repoPath),
        body,
        createdAt: now,
      },
    ],
  };
  store.threads.push(thread);
  writeReview(repoPath, base, head, store);
  return { thread };
}

// Appends a reply comment to the thread with id === threadId. Throws a 404
// error if the thread does not exist.
export function addReply({ repoPath, base, head, threadId, body }) {
  const store = readReview(repoPath, base, head);
  const thread = store.threads.find((t) => t.id === threadId);
  if (!thread) {
    throw Object.assign(new Error("Thread not found"), { status: 404 });
  }
  const comment = {
    id: randomUUID(),
    author: reviewAuthor(repoPath),
    body,
    createdAt: new Date().toISOString(),
  };
  thread.comments.push(comment);
  writeReview(repoPath, base, head, store);
  return { comment };
}

// Appends a top-level conversation comment and persists it. Returns the
// created item.
export function addConversationComment({ repoPath, base, head, body }) {
  const store = readReview(repoPath, base, head);
  const comment = {
    id: randomUUID(),
    author: reviewAuthor(repoPath),
    body,
    createdAt: new Date().toISOString(),
  };
  store.conversation.push(comment);
  writeReview(repoPath, base, head, store);
  return comment;
}

// Sets the resolved state of the thread with id === threadId and persists it.
// Throws a 404 error if the thread does not exist.
export function setThreadResolved({ repoPath, base, head, threadId, resolved }) {
  const store = readReview(repoPath, base, head);
  const thread = store.threads.find((t) => t.id === threadId);
  if (!thread) {
    throw Object.assign(new Error("Thread not found"), { status: 404 });
  }
  thread.resolved = resolved;
  writeReview(repoPath, base, head, store);
  return { threadId, resolved };
}

// Updates the body of an existing comment, whether it lives in an inline
// thread or the top-level conversation, and persists it. Throws a 404 error
// if no comment with that id exists.
export function editComment({ repoPath, base, head, commentId, body }) {
  const store = readReview(repoPath, base, head);
  for (const thread of store.threads) {
    const comment = thread.comments.find((c) => c.id === commentId);
    if (comment) {
      comment.body = body;
      writeReview(repoPath, base, head, store);
      return { commentId, body };
    }
  }
  const convo = store.conversation.find((c) => c.id === commentId);
  if (convo) {
    convo.body = body;
    writeReview(repoPath, base, head, store);
    return { commentId, body };
  }
  throw Object.assign(new Error("Comment not found"), { status: 404 });
}

// Pure mapper: store object -> { conversation, inline } in the shape the
// frontend expects. Each thread's comments are flattened into one inline item
// per comment, all sharing the thread's id as threadId and the thread's
// path/line/side/originalLine/resolved. Inline items are sorted by createdAt
// ascending; conversation likewise.
export function toCommentsView(store) {
  const inline = [];
  for (const thread of store.threads) {
    for (const comment of thread.comments) {
      inline.push({
        id: comment.id,
        author: comment.author,
        body: comment.body,
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        side: thread.side,
        resolved: thread.resolved,
        outdated: false,
        threadId: thread.id,
        createdAt: comment.createdAt,
      });
    }
  }
  inline.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  const conversation = [...store.conversation].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );

  return { conversation, inline };
}
