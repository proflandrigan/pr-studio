// Minimal GitHub REST helpers. Uses the built-in fetch (Node 18+).
// A Personal Access Token (classic or fine-grained with PR read/write) is read
// from the GITHUB_TOKEN env var.

const API = "https://api.github.com";

function headers() {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pr-studio",
  };
  if (process.env.GITHUB_TOKEN) {
    h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
}

async function gh(path, options = {}) {
  const res = await fetch(`${API}${path}`, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
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

export async function getComments({ owner, repo, number }) {
  // Top-level conversation comments live on the "issues" endpoint.
  const issueComments = await gh(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
  // Inline code-review comments.
  const reviewComments = await gh(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`);
  return {
    conversation: (issueComments || []).map((c) => ({
      id: c.id,
      author: c.user ? c.user.login : "unknown",
      body: c.body,
      createdAt: c.created_at,
    })),
    inline: (reviewComments || []).map((c) => ({
      id: c.id,
      author: c.user ? c.user.login : "unknown",
      body: c.body,
      path: c.path,
      line: c.line,
      createdAt: c.created_at,
    })),
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
