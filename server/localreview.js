// Local branch review: list a repo's branches and produce a PR-shaped diff for
// `base...head` (no GitHub involved). Mirrors the shape of `getPullRequest()`
// in github.js so the frontend's existing diff rendering works unchanged.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

// Run a git command in repoPath and return trimmed stdout, or throw a clean
// Error with .status = 400 on failure (mirrors github.js's err.status style).
function git(repoPath, args) {
  try {
    return execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
  } catch (e) {
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    throw Object.assign(new Error(`git ${args.join(" ")} failed: ${detail}`), { status: 400 });
  }
}

// Throws .status = 400 if repoPath is missing, not a directory, or not a git
// repository (working tree).
function assertGitRepo(repoPath) {
  if (!repoPath || !existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw Object.assign(new Error(`Not a git repository: ${repoPath || "(empty)"}`), { status: 400 });
  }
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoPath, encoding: "utf8" });
  } catch {
    throw Object.assign(new Error(`Not a git repository: ${repoPath}`), { status: 400 });
  }
}

// Throws .status = 400 if `ref` does not resolve to a valid object in repoPath.
function assertValidRef(repoPath, ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", ref], { cwd: repoPath, encoding: "utf8" });
  } catch {
    throw Object.assign(new Error(`Not a valid ref: ${ref}`), { status: 400 });
  }
}

// Parses the full stdout of `git diff <range>` (multiple files) into an array
// of { filename, status, additions, deletions, patch } objects shaped like
// GitHub's per-file PR data. Pure — no I/O.
export function parseGitDiff(raw) {
  if (!raw) return [];

  const sections = raw.split(/^diff --git /m).filter((s) => s.trim());

  return sections.map((section) => {
    const lines = section.split("\n");

    let filename = null;
    let plusPath = null;
    let minusPath = null;

    for (const line of lines) {
      if (line.startsWith("+++ ")) {
        const rest = line.slice("+++ ".length);
        plusPath = rest === "/dev/null" ? null : rest.startsWith("b/") ? rest.slice(2) : rest;
        if (plusPath != null) filename = plusPath;
      } else if (line.startsWith("--- ")) {
        const rest = line.slice("--- ".length);
        minusPath = rest === "/dev/null" ? null : rest.startsWith("a/") ? rest.slice(2) : rest;
      }
    }

    if (filename == null) {
      if (plusPath == null && minusPath != null) {
        // +++ /dev/null (deleted file) — fall back to the --- a/<path> path.
        filename = minusPath;
      } else {
        // No +++/--- lines at all (pure rename, binary) — fall back to the
        // `diff --git a/<old> b/<new>` header line's b/ path.
        const headerLine = lines[0] || "";
        const m = headerLine.match(/ b\/(.+)$/);
        filename = m ? m[1] : headerLine.trim();
      }
    }

    let status = "modified";
    if (/^new file mode/m.test(section)) {
      status = "added";
    } else if (/^deleted file mode/m.test(section)) {
      status = "removed";
    } else if (/^rename (from|to) /m.test(section)) {
      status = "renamed";
    }

    const hunkIndex = lines.findIndex((l) => l.startsWith("@@"));
    let patch = null;
    let additions = 0;
    let deletions = 0;
    if (hunkIndex !== -1) {
      patch = lines.slice(hunkIndex).join("\n").replace(/\n+$/, "");
      for (const line of lines.slice(hunkIndex)) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }
    }

    return { filename, status, additions, deletions, patch };
  });
}

// Returns { content } for `path` at `ref` in repoPath, read straight from the
// checkout via `git show <ref>:<path>` (mirrors github.js's getFileContent
// shape so the frontend's markdown/notebook preview works for branch tabs).
export function getFileAtRef(repoPath, ref, path) {
  assertGitRepo(repoPath);
  assertValidRef(repoPath, ref);
  // `<ref>:<path>` is git's rev:path syntax (path is repo-root-relative). Args
  // are passed as an array (never a shell string), so nothing is injectable.
  const content = git(repoPath, ["show", `${ref}:${path}`]);
  return { content };
}

// Returns { current, branches, defaultBase } for repoPath.
export function listBranches(repoPath) {
  assertGitRepo(repoPath);

  const branches = git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .sort();

  const current = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();

  let defaultBase = ["main", "master"].find((b) => branches.includes(b));
  if (!defaultBase) {
    defaultBase = branches.includes(current) ? current : branches[0] ?? null;
  }

  return { current, branches, defaultBase };
}

// Synthesize a `git diff`-style section for an untracked (new) file so it parses
// the same as a tracked addition. Pure — caller supplies the file's text.
export function synthUntrackedDiff(path, content) {
  const text = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = content.length === 0 ? [] : text.split("\n");
  const n = lines.length;
  const body = lines.map((l) => "+" + l).join("\n");
  return (
    `diff --git a/${path} b/${path}\n` +
    "new file mode 100644\n" +
    "--- /dev/null\n" +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${n} @@\n` +
    body
  );
}

// Returns a PR-shaped diff object for all working-tree changes in repoPath
// (staged + unstaged tracked changes, plus untracked files). Mirrors the shape
// returned by getBranchDiff() so the frontend renders it unchanged.
export function getWorkingDiff(repoPath) {
  assertGitRepo(repoPath);

  // Tracked changes vs the last commit (staged + unstaged). Fall back to a plain
  // `git diff` if there is no HEAD yet (a repo with no commits).
  let tracked;
  try {
    tracked = git(repoPath, ["diff", "--no-color", "--find-renames", "HEAD"]);
  } catch {
    tracked = git(repoPath, ["diff", "--no-color", "--find-renames"]);
  }
  const files = parseGitDiff(tracked);

  // Untracked files (agent `Write` output) are invisible to `git diff`; synthesize
  // them as additions. Binary files (NUL byte) get a patch-less "added" entry.
  const others = git(repoPath, ["ls-files", "--others", "--exclude-standard"])
    .split("\n").map((s) => s.trim()).filter(Boolean);
  for (const rel of others) {
    let buf;
    try {
      buf = readFileSync(join(repoPath, rel));
    } catch {
      continue; // vanished between listing and read — skip
    }
    if (buf.includes(0)) {
      files.push({ filename: rel, status: "added", additions: 0, deletions: 0, patch: null });
      continue;
    }
    files.push(parseGitDiff(synthUntrackedDiff(rel, buf.toString("utf8")))[0]);
  }

  // author resolution — copy verbatim from getBranchDiff
  let author;
  try { author = git(repoPath, ["config", "user.name"]).trim() || null; } catch { author = null; }
  if (!author) {
    try { author = userInfo().username || "local"; } catch { author = "local"; }
  }

  let headSha = "";
  try { headSha = git(repoPath, ["rev-parse", "HEAD"]).trim(); } catch { headSha = ""; }

  return {
    title: "Working changes",
    state: "open",
    draft: false,
    author,
    body: "",
    headRef: "working tree",
    baseRef: "HEAD",
    headSha,
    baseSha: headSha,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    changedFiles: files.length,
    files,
  };
}

// Returns a PR-shaped diff object for `base...head` in repoPath.
export function getBranchDiff(repoPath, base, head) {
  assertGitRepo(repoPath);
  assertValidRef(repoPath, base);
  assertValidRef(repoPath, head);

  const stdout = git(repoPath, ["diff", "--no-color", "--find-renames", `${base}...${head}`]);
  const files = parseGitDiff(stdout);

  const headSha = git(repoPath, ["rev-parse", head]).trim();
  const baseSha = git(repoPath, ["rev-parse", base]).trim();

  let author;
  try {
    author = git(repoPath, ["config", "user.name"]).trim() || null;
  } catch {
    author = null;
  }
  if (!author) {
    try {
      author = userInfo().username || "local";
    } catch {
      author = "local";
    }
  }

  return {
    title: `${head} → ${base}`,
    state: "open",
    draft: false,
    author,
    body: "",
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    changedFiles: files.length,
    files,
  };
}
