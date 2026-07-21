// Minimal GitHub REST helpers. Uses the built-in fetch (Node 18+).
// A Personal Access Token (classic or fine-grained with PR read/write) is read
// from the GITHUB_TOKEN env var, falling back to the `gh` CLI's stored auth
// (`gh auth token`) so an existing local GitHub login "just works".

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.github.com";

// Read the token the gh CLI stored at login, straight from its hosts config.
// Used as a fallback for gh versions without the `gh auth token` subcommand.
function ghConfigToken() {
  const dir = process.env.GH_CONFIG_DIR || join(homedir(), ".config", "gh");
  try {
    const yml = readFileSync(join(dir, "hosts.yml"), "utf8");
    const m = yml.match(/oauth_token:\s*(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Resolve a token once and cache it. Env var wins; otherwise borrow the gh CLI's
// login (newer gh via `gh auth token`, older gh via its hosts.yml). `null` (not
// undefined) is cached on failure so we don't re-shell/re-read on every call.
let cachedToken;
let cachedTokenSource;
export function resolveToken() {
  if (cachedToken !== undefined) return cachedToken;
  if (process.env.GITHUB_TOKEN) {
    cachedToken = process.env.GITHUB_TOKEN;
    cachedTokenSource = "env";
    return cachedToken;
  }
  let token = null;
  try {
    token = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) cachedTokenSource = "gh-cli";
  } catch {
    /* old gh lacks `gh auth token` — fall through to the config file */
  }
  if (!token) {
    token = ghConfigToken();
    if (token) cachedTokenSource = "gh-config";
  }
  cachedToken = token || null;
  if (!cachedToken) cachedTokenSource = null;
  return cachedToken;
}

export function hasToken() {
  return Boolean(resolveToken());
}

// Which source resolveToken() used: "env" | "gh-cli" | "gh-config" | null.
// Resolves the token first if not already cached.
export function tokenSource() {
  resolveToken();
  return cachedTokenSource ?? null;
}

// Resolve the authenticated user's login once and cache it, mirroring
// resolveToken(): a network call (GET /user) is too slow to repeat on every
// /api/health poll. `undefined` means "not yet fetched"; a failed fetch is
// left uncached so a transient network hiccup doesn't stick forever.
let cachedLogin;
export async function getAuthenticatedLogin() {
  if (!resolveToken()) return null;
  if (cachedLogin !== undefined) return cachedLogin;
  try {
    const user = await gh("/user");
    cachedLogin = user.login || null;
    return cachedLogin;
  } catch {
    return null;
  }
}

function headers() {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pr-studio",
  };
  const token = resolveToken();
  if (token) {
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}

// GitHub's GraphQL API. Required for review-thread state (isResolved / isOutdated)
// which the REST comments endpoint does not expose. Auth is mandatory here —
// anonymous GraphQL is rejected — so without a token this returns null and
// callers fall back to REST-only data (no resolved/outdated enrichment).
async function graphql(query, variables) {
  if (!resolveToken()) return null;
  let res;
  try {
    res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    return null;
  }
  const body = await res.json().catch(() => null);
  // Best-effort enrichment: a GraphQL error never breaks comment loading.
  if (!res.ok || !body || body.errors) return null;
  return body.data;
}

async function gh(path, options = {}) {
  const h = { ...headers(), ...(options.headers || {}) };
  // GitHub write endpoints need an explicit JSON content type; fetch otherwise
  // sends a string body as text/plain, which GitHub rejects.
  if (options.body && !h["Content-Type"]) h["Content-Type"] = "application/json";
  const res = await fetch(`${API}${path}`, { ...options, headers: h });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body && body.message ? body.message : `GitHub API error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Accepts a full PR URL or "owner/repo#number" and returns its parts.
export function parsePrRef(input) {
  if (!input) throw Object.assign(new Error("No PR reference provided"), { status: 400 });
  const trimmed = input.trim();

  // https://github.com/owner/repo/pull/123
  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: Number(urlMatch[3]) };
  }

  // owner/repo#123  or  owner/repo/123
  const shortMatch = trimmed.match(/^([^/]+)\/([^/#\s]+)[#/](\d+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], number: Number(shortMatch[3]) };
  }

  throw Object.assign(new Error("Could not parse PR. Use a github.com PR URL or owner/repo#number."), { status: 400 });
}

// Fetches the full PR diff as text (GitHub's diff media type). Returns null on any
// failure (e.g. 406 for an enormous diff) so callers fall back gracefully.
async function getPullRequestDiff({ owner, repo, number }) {
  try {
    const diff = await gh(`/repos/${owner}/${repo}/pulls/${number}`, {
      headers: { Accept: "application/vnd.github.diff" },
    });
    return typeof diff === "string" ? diff : null;
  } catch {
    return null;
  }
}

// Splits a full unified diff (GitHub's `.diff` media type, or `git diff` stdout)
// into a Map of new-file path -> per-file patch string. Each patch begins at the
// file's first `@@` hunk header (matching the shape GitHub puts in a file's
// `patch` field), so a backfilled patch is byte-compatible with parsePatch on the
// frontend. Files with no hunk (pure rename/mode change) are skipped. Pure — unit-tested.
export function splitDiffByFile(diffText) {
  const out = new Map();
  if (!diffText || typeof diffText !== "string") return out;
  // Split on the per-file header; keep logic identical to parseGitDiff's section split.
  const sections = diffText.split(/^diff --git /m).filter((s) => s.trim());
  for (const section of sections) {
    const lines = section.split("\n");
    // New path comes from the `+++ b/<path>` line; fall back to the a/ path from
    // the header line (`a/<old> b/<new>`) for deletions where +++ is /dev/null.
    let filename = null;
    const plusLine = lines.find((l) => l.startsWith("+++ "));
    if (plusLine && plusLine.trimEnd() !== "+++ /dev/null") {
      // git/GitHub append a trailing tab after the path on +++/--- lines when the
      // path contains a space (to disambiguate from the old timestamp suffix of
      // classic diff headers) — strip it so the filename matches GitHub's clean
      // `files[].filename` for the Map lookup below.
      filename = plusLine.slice(4).replace(/\s+$/, "").replace(/^b\//, "");
    } else {
      const m = lines[0].match(/^a\/(.+?) b\/(.+)$/);
      if (m) filename = m[2].replace(/\s+$/, "");
    }
    if (!filename) continue;
    const hunkIndex = lines.findIndex((l) => l.startsWith("@@"));
    if (hunkIndex === -1) continue; // no textual hunk (e.g. pure rename) — nothing to backfill
    const patch = lines.slice(hunkIndex).join("\n").replace(/\n+$/, "");
    out.set(filename, patch);
  }
  return out;
}

export async function getPullRequest({ owner, repo, number }) {
  const pr = await gh(`/repos/${owner}/${repo}/pulls/${number}`);
  const files = await gh(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`);
  const mappedFiles = (files || []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch || null,
  }));

  // GitHub omits `patch` for large files (common for notebooks with output).
  // Recover those from the full PR diff so the frontend can locate commentable
  // (diff) lines and offer real inline comments. Best-effort: a failed/oversized
  // diff fetch just leaves the patches null (today's behavior).
  if (mappedFiles.some((f) => !f.patch)) {
    const diffText = await getPullRequestDiff({ owner, repo, number });
    if (diffText) {
      const byFile = splitDiffByFile(diffText);
      for (const f of mappedFiles) {
        if (!f.patch && byFile.has(f.filename)) f.patch = byFile.get(f.filename);
      }
    }
  }

  return {
    owner,
    repo,
    number,
    title: pr.title,
    state: pr.merged ? "merged" : pr.state,
    draft: pr.draft,
    author: pr.user ? pr.user.login : "unknown",
    body: pr.body || "",
    headRef: pr.head ? pr.head.ref : null,
    baseRef: pr.base ? pr.base.ref : null,
    headSha: pr.head ? pr.head.sha : null,
    baseSha: pr.base ? pr.base.sha : null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    url: pr.html_url,
    files: mappedFiles,
  };
}

// GitHub search items reference their repo via an API URL like
// "https://api.github.com/repos/{owner}/{repo}". Extract the two segments.
// Returns { owner, repo } or null if the URL doesn't match.
export function repoFromUrl(repositoryUrl) {
  if (!repositoryUrl) return null;
  const m = String(repositoryUrl).match(/\/repos\/([^/]+)\/([^/]+)\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Merge the three relationship searches into one deduped, tagged list.
// Pure (no I/O) so it's unit-testable. Each arg is an array of raw GitHub
// search-issues items. Relationship is mutually exclusive, priority
// authored > review-requested > involved. Status is open|closed|merged.
export function tagPullRequests({ involves = [], authored = [], reviewRequested = [] }) {
  const authoredIds = new Set(authored.map((i) => i.id));
  const reviewIds = new Set(reviewRequested.map((i) => i.id));
  const byId = new Map();
  // Order matters only for first-wins dedupe; tagging is by id-set membership
  // so it's independent of which array an item came from.
  for (const item of [...authored, ...reviewRequested, ...involves]) {
    if (byId.has(item.id)) continue;
    const repo = repoFromUrl(item.repository_url);
    if (!repo) continue;
    const relationship = authoredIds.has(item.id)
      ? "authored"
      : reviewIds.has(item.id)
      ? "review-requested"
      : "involved";
    const status =
      item.pull_request && item.pull_request.merged_at ? "merged" : item.state; // open|closed
    byId.set(item.id, {
      owner: repo.owner,
      repo: repo.repo,
      number: item.number,
      title: item.title,
      state: item.state,
      status,
      relationship,
      draft: Boolean(item.draft),
      author: item.user ? item.user.login : "unknown",
      url: item.html_url,
      updatedAt: item.updated_at,
    });
  }
  return [...byId.values()].sort(
    (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
  );
}

// PRs the authenticated user is involved in across all states
// (open/closed/merged), tagged with their relationship (authored/
// review-requested/involved) and status (open/closed/merged), most-recently-
// updated first. Requires a token — the `@me` qualifiers need an
// authenticated identity — so without one we throw a 401 the route layer
// surfaces as JSON. Unions three searches (author/review-requested/involves)
// since `involves:@me` alone misses review-requested PRs. Capped at 100;
// pagination beyond that is out of scope.
export async function listMyPullRequests() {
  if (!resolveToken()) {
    throw Object.assign(
      new Error("A GitHub token is required to detect your pull requests."),
      { status: 401 }
    );
  }
  const search = async (qualifier) => {
    const q = encodeURIComponent(`is:pr ${qualifier}`);
    const data = await gh(
      `/search/issues?q=${q}&sort=updated&order=desc&per_page=100`
    );
    return data.items || [];
  };
  const [involves, authored, reviewRequested] = await Promise.all([
    search("involves:@me"),
    search("author:@me"),
    search("review-requested:@me"),
  ]);
  return tagPullRequests({ involves, authored, reviewRequested }).slice(0, 100);
}

// Resolution and outdated state lives on the review *thread*, not the comment,
// and only GraphQL exposes it. Returns a Map of REST comment id -> { resolved,
// outdated, threadId }. `threadId` is the thread's GraphQL node id, used to
// resolve/unresolve via mutation. Empty when there's no token (GraphQL
// unavailable) so REST-only callers degrade cleanly. `databaseId` is the
// GraphQL alias for the REST id.
async function getReviewThreadState({ owner, repo, number }) {
  const query = `
    query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              isOutdated
              comments(first: 100) { nodes { databaseId } }
            }
          }
        }
      }
    }`;
  const data = await graphql(query, { owner, repo, number: Number(number) });
  const map = new Map();
  const threads = data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  for (const t of threads) {
    for (const c of t.comments?.nodes || []) {
      if (c.databaseId != null) {
        map.set(c.databaseId, { resolved: t.isResolved, outdated: t.isOutdated, threadId: t.id });
      }
    }
  }
  return map;
}

export async function getComments({ owner, repo, number }) {
  // Top-level conversation comments live on the "issues" endpoint.
  const issueComments = await gh(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
  // Inline code-review comments.
  const reviewComments = await gh(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`);
  // Per-thread resolved/outdated state (GraphQL; empty without a token).
  const threadState = await getReviewThreadState({ owner, repo, number });
  return {
    conversation: (issueComments || []).map((c) => ({
      id: c.id,
      author: c.user ? c.user.login : "unknown",
      body: c.body,
      createdAt: c.created_at,
    })),
    inline: (reviewComments || []).map((c) => {
      const st = threadState.get(c.id) || {};
      return {
        id: c.id,
        author: c.user ? c.user.login : "unknown",
        body: c.body,
        path: c.path,
        // `line` is null for outdated comments (their anchor no longer maps to the
        // current diff); `original_line` is where the comment was first placed.
        line: c.line,
        originalLine: c.original_line,
        side: c.side,
        originalSide: c.original_side,
        resolved: Boolean(st.resolved),
        outdated: Boolean(st.outdated),
        threadId: st.threadId || null,
        createdAt: c.created_at,
      };
    }),
  };
}

// Fetches a single file's content at a given ref via the Contents API. Used to
// render markdown previews. Encodes each path segment separately so slashes in
// the path are preserved while special characters in filenames are escaped.
export async function getFileContent({ owner, repo, path, ref }) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const data = await gh(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
  if (data.type !== "file" || data.encoding !== "base64") {
    throw Object.assign(new Error("Path is not a file"), { status: 400 });
  }
  if (!data.content && data.size > 0) {
    throw Object.assign(new Error("File too large to preview"), { status: 413 });
  }
  return {
    content: Buffer.from(data.content, "base64").toString("utf8"),
    sha: data.sha,
  };
}

export async function postConversationComment({ owner, repo, number, body }) {
  return gh(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function postInlineComment({ owner, repo, number, commitId, path, line, body, side = "RIGHT" }) {
  return gh(`/repos/${owner}/${repo}/pulls/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body, commit_id: commitId, path, line, side }),
  });
}

// Resolve or unresolve a PR review thread. GitHub exposes thread resolution only
// via GraphQL, keyed by the thread's node id (see getComments' `threadId`). A
// token is required; without one (or on a GraphQL error) `graphql()` returns null
// and we throw so the route surfaces a clear error instead of silently no-op-ing.
export async function setReviewThreadResolved({ threadId, resolved }) {
  const mutation = resolved
    ? `mutation ($id: ID!) {
         resolveReviewThread(input: { threadId: $id }) {
           thread { id isResolved }
         }
       }`
    : `mutation ($id: ID!) {
         unresolveReviewThread(input: { threadId: $id }) {
           thread { id isResolved }
         }
       }`;
  const data = await graphql(mutation, { id: threadId });
  const thread =
    data?.resolveReviewThread?.thread || data?.unresolveReviewThread?.thread;
  if (!thread) {
    throw Object.assign(
      new Error("Could not change thread resolution (token required, and you must have access to the thread)."),
      { status: 502 }
    );
  }
  return { threadId: thread.id, resolved: thread.isResolved };
}

// Reply to an existing inline review thread. GitHub threads the reply onto the
// thread containing `commentId` via a dedicated replies endpoint (no path/line/
// commit needed — the parent comment already anchors the thread).
export async function replyToReviewComment({ owner, repo, number, commentId, body }) {
  return gh(`/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function editConversationComment({ owner, repo, commentId, body }) {
  return gh(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}

export async function editInlineComment({ owner, repo, commentId, body }) {
  return gh(`/repos/${owner}/${repo}/pulls/comments/${commentId}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}
