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
export function resolveToken() {
  if (cachedToken !== undefined) return cachedToken;
  if (process.env.GITHUB_TOKEN) {
    cachedToken = process.env.GITHUB_TOKEN;
    return cachedToken;
  }
  let token = null;
  try {
    token = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* old gh lacks `gh auth token` — fall through to the config file */
  }
  cachedToken = token || ghConfigToken();
  return cachedToken;
}

export function hasToken() {
  return Boolean(resolveToken());
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
  if (!input) throw new Error("No PR reference provided");
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

// Resolution and outdated state lives on the review *thread*, not the comment,
// and only GraphQL exposes it. Returns a Map of REST comment id -> { resolved,
// outdated }. Empty when there's no token (GraphQL unavailable) so REST-only
// callers degrade cleanly. `databaseId` is the GraphQL alias for the REST id.
async function getReviewThreadState({ owner, repo, number }) {
  const query = `
    query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
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
        map.set(c.databaseId, { resolved: t.isResolved, outdated: t.isOutdated });
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
        resolved: Boolean(st.resolved),
        outdated: Boolean(st.outdated),
        createdAt: c.created_at,
      };
    }),
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
