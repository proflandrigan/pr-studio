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

export async function getPullRequest({ owner, repo, number }) {
  const pr = await gh(`/repos/${owner}/${repo}/pulls/${number}`);
  const files = await gh(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`);
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
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    url: pr.html_url,
    files: (files || []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || null,
    })),
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

// Open PRs the authenticated user is involved in (author/assignee/reviewer/
// commenter/mentioned), most-recently-updated first. Requires a token — the
// `involves:@me` qualifier needs an authenticated identity — so without one we
// throw a 401 the route layer surfaces as JSON. Capped at 50; pagination is out
// of scope.
export async function listMyPullRequests() {
  if (!resolveToken()) {
    throw Object.assign(
      new Error("A GitHub token is required to detect your pull requests."),
      { status: 401 }
    );
  }
  const q = encodeURIComponent("is:pr is:open involves:@me");
  const data = await gh(`/search/issues?q=${q}&sort=updated&order=desc&per_page=50`);
  return (data.items || [])
    .map((item) => {
      const repo = repoFromUrl(item.repository_url);
      if (!repo) return null;
      return {
        owner: repo.owner,
        repo: repo.repo,
        number: item.number,
        title: item.title,
        state: item.state,           // "open"
        draft: Boolean(item.draft),
        author: item.user ? item.user.login : "unknown",
        url: item.html_url,
        updatedAt: item.updated_at,
      };
    })
    .filter(Boolean);
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
