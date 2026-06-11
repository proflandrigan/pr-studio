"use strict";

// ---------- State ----------
const LS_KEY = "pr-studio:state:v1";
const state = {
  tabs: [], // { key, owner, repo, number, title, state, draft, data, comments }
  active: null,
  repoPaths: {}, // key -> local path
  agentMode: "review",
  showResolved: false, // view toggle: include resolved inline threads in the diff
};

function keyOf(o, r, n) {
  return `${o}/${r}#${n}`;
}

function persist() {
  const slim = {
    refs: state.tabs.map((t) => ({ owner: t.owner, repo: t.repo, number: t.number })),
    active: state.active,
    repoPaths: state.repoPaths,
    agentMode: state.agentMode,
    showResolved: state.showResolved,
  };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(slim));
  } catch {}
}

function loadPersisted() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "null");
  } catch {
    return null;
  }
}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const tabsEl = $("tabs");
const reviewEl = $("review");
const emptyEl = $("empty");
const statusEl = $("status");
const consoleEl = $("console");
const consoleOut = $("consoleOut");
const repoPathEl = $("repoPath");
const agentModeEl = $("agentMode");

// ---------- Boot ----------
init();

async function init() {
  // health
  try {
    const h = await fetch("/api/health").then((r) => r.json());
    statusEl.classList.add(h.githubToken ? "ok" : "warn");
    statusEl.title = h.githubToken
      ? "GitHub token detected — comments enabled"
      : "No GitHub token — read-only for public PRs, can't post comments";
    if (h.defaultRepoPath) repoPathEl.value = h.defaultRepoPath;
  } catch {
    statusEl.title = "Server unreachable";
  }

  const saved = loadPersisted();
  if (saved) {
    state.repoPaths = saved.repoPaths || {};
    state.agentMode = saved.agentMode || "review";
    state.showResolved = Boolean(saved.showResolved);
    agentModeEl.value = state.agentMode;
    for (const ref of saved.refs || []) {
      await openPr(`${ref.owner}/${ref.repo}#${ref.number}`, { silent: true });
    }
    if (saved.active && state.tabs.find((t) => t.key === saved.active)) {
      activate(saved.active);
    } else if (state.tabs.length) {
      activate(state.tabs[0].key);
    }
  }

  wireEvents();
}

function wireEvents() {
  $("openForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("prInput").value.trim();
    if (v) {
      openPr(v);
      $("prInput").value = "";
    }
  });

  $("agentForm").addEventListener("submit", (e) => {
    e.preventDefault();
    runAgent();
  });

  $("clearConsole").addEventListener("click", () => {
    consoleOut.textContent = "";
  });

  // Collapse console by clicking its label area
  $("console").querySelector(".console-head").addEventListener("click", (e) => {
    if (e.target.closest(".console-controls")) return;
    consoleEl.classList.toggle("collapsed");
  });

  agentModeEl.addEventListener("change", () => {
    state.agentMode = agentModeEl.value;
    persist();
  });

  repoPathEl.addEventListener("change", () => {
    if (state.active) {
      state.repoPaths[state.active] = repoPathEl.value.trim();
      persist();
    }
  });
}

// ---------- Open / fetch PR ----------
async function openPr(ref, opts = {}) {
  let parsed;
  try {
    parsed = await fetch(`/api/pr?url=${encodeURIComponent(ref)}`).then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "Failed to load PR");
      return body;
    });
  } catch (e) {
    if (!opts.silent) flashError(e.message);
    return;
  }

  const key = keyOf(parsed.owner, parsed.repo, parsed.number);
  const existing = state.tabs.find((t) => t.key === key);
  const tab = {
    key,
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
    title: parsed.title,
    state: parsed.state,
    draft: parsed.draft,
    data: parsed,
    comments: null,
  };
  if (existing) {
    Object.assign(existing, tab);
  } else {
    state.tabs.push(tab);
  }
  renderTabs();
  activate(key);
  loadComments(key);
  persist();
}

async function loadComments(key) {
  const tab = state.tabs.find((t) => t.key === key);
  if (!tab) return;
  try {
    const c = await fetch(
      `/api/pr/comments?owner=${tab.owner}&repo=${tab.repo}&number=${tab.number}`
    ).then((r) => r.json());
    tab.comments = c;
    if (state.active === key) renderReview();
  } catch {
    /* comments are best-effort */
  }
}

// ---------- Tabs ----------
function renderTabs() {
  tabsEl.innerHTML = "";
  for (const tab of state.tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.key === state.active ? " active" : "");
    el.title = tab.title;

    const dotState = tab.draft ? "draft" : tab.state;
    el.innerHTML = `
      <span class="tab-dot ${dotState}"></span>
      <span class="tab-label">${tab.repo}#${tab.number}</span>
      <button class="tab-close" title="Close">×</button>
    `;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".tab-close")) {
        closeTab(tab.key);
      } else {
        activate(tab.key);
      }
    });
    tabsEl.appendChild(el);
  }
}

function closeTab(key) {
  const i = state.tabs.findIndex((t) => t.key === key);
  if (i < 0) return;
  state.tabs.splice(i, 1);
  if (state.active === key) {
    const next = state.tabs[i] || state.tabs[i - 1];
    state.active = next ? next.key : null;
  }
  renderTabs();
  if (state.active) {
    renderReview();
  } else {
    showEmpty();
  }
  persist();
}

function activate(key) {
  state.active = key;
  const tab = state.tabs.find((t) => t.key === key);
  if (tab) repoPathEl.value = state.repoPaths[key] || repoPathEl.value || "";
  renderTabs();
  renderReview();
  persist();
}

function showEmpty() {
  emptyEl.hidden = false;
  reviewEl.hidden = true;
}

// ---------- Render review ----------
// Sentinel for the sidebar entry that shows the PR description + conversation
// instead of a file diff.
const OVERVIEW = "__overview__";

function renderReview() {
  const tab = state.tabs.find((t) => t.key === state.active);
  if (!tab) return showEmpty();
  emptyEl.hidden = true;
  reviewEl.hidden = false;

  const pr = tab.data;
  const stateClass = tab.draft ? "draft" : pr.state;
  const stateLabel = tab.draft ? "draft" : pr.state;

  reviewEl.innerHTML = `
    <div class="pr-head">
      <h1 class="pr-title"><a href="${pr.url}" target="_blank" rel="noopener">${esc(pr.title)}</a></h1>
      <div class="pr-meta">
        <span class="badge ${stateClass}">${stateLabel}</span>
        <span>@${esc(pr.author)}</span>
        <span class="branch"><b>${esc(pr.headRef || "")}</b> → <b>${esc(pr.baseRef || "")}</b></span>
        <span class="diffstat"><span class="plus">+${pr.additions ?? 0}</span> <span class="minus">−${pr.deletions ?? 0}</span> · ${pr.changedFiles ?? pr.files.length} files</span>
      </div>
    </div>
    <div class="review-body">
      <aside class="file-sidebar" id="fileSidebar"></aside>
      <div class="file-main" id="fileMain"></div>
    </div>
  `;

  // Which sidebar entry is selected is transient UI state kept on the in-memory
  // tab so it survives re-renders (e.g. after posting a comment). Default: the
  // PR description/overview, like GitHub's Conversation tab.
  if (!tab.selected) tab.selected = OVERVIEW;

  renderSidebar(tab);
  renderMain(tab);
}

// Left panel: a "Description" entry at the top, then the changed-file list.
// Selecting an entry swaps what the main pane shows.
function renderSidebar(tab) {
  const pr = tab.data;
  const el = $("fileSidebar");

  const fileItems = pr.files
    .map((file) => {
      const byLine = inlineCommentsByLine(tab, file.filename);
      const count = [...byLine.values()].reduce((n, arr) => n + arr.length, 0);
      const active = tab.selected === file.filename ? " active" : "";
      return `
        <div class="sidebar-item file-item${active}" data-view="${esc(file.filename)}" title="${esc(file.filename)}">
          <span class="file-item-name">${esc(file.filename)}</span>
          <span class="file-item-meta">
            <span class="file-status">${file.status}</span>
            ${count ? `<span class="file-comment-count">💬 ${count}</span>` : ""}
            <span class="file-counts"><span class="plus">+${file.additions}</span><span class="minus">−${file.deletions}</span></span>
          </span>
        </div>`;
    })
    .join("");

  el.innerHTML = `
    <div class="sidebar-item overview${tab.selected === OVERVIEW ? " active" : ""}" data-view="${OVERVIEW}">
      <span class="sidebar-icon">📝</span>
      <span class="sidebar-label">Description &amp; conversation</span>
    </div>
    <div class="sidebar-files-head">${pr.files.length} ${pr.files.length === 1 ? "file" : "files"} changed</div>
    ${renderReviewControls(tab)}
    <div class="file-list">${fileItems}</div>
  `;

  const resolvedToggle = $("showResolvedToggle");
  if (resolvedToggle) {
    resolvedToggle.addEventListener("change", () => {
      state.showResolved = resolvedToggle.checked;
      persist();
      renderReview();
    });
  }

  el.querySelectorAll(".sidebar-item").forEach((item) => {
    item.addEventListener("click", () => {
      tab.selected = item.dataset.view;
      renderSidebar(tab);
      renderMain(tab);
    });
  });
}

// Right pane: either the PR description + conversation, or a single file diff.
function renderMain(tab) {
  const el = $("fileMain");
  if (tab.selected === OVERVIEW) {
    renderOverview(tab, el);
    return;
  }
  const file = tab.data.files.find((f) => f.filename === tab.selected);
  if (!file) {
    // Selection no longer resolves (shouldn't happen) — fall back to overview.
    tab.selected = OVERVIEW;
    renderSidebar(tab);
    return renderMain(tab);
  }
  el.innerHTML = "";
  el.appendChild(renderFileDiff(file, tab));
}

function renderOverview(tab, el) {
  const pr = tab.data;
  const body =
    pr.body && pr.body.trim()
      ? `<div class="description-body">${esc(pr.body)}</div>`
      : `<div class="description-body empty">No description provided.</div>`;
  el.innerHTML = `
    <div class="pr-description">
      <h2>Description</h2>
      ${body}
    </div>
    <div class="convo" id="convo"></div>
  `;
  renderConversation(tab);
}

function renderFileDiff(file, tab) {
  const el = document.createElement("div");
  el.className = "file open";

  const byLine = inlineCommentsByLine(tab, file.filename);
  const count = [...byLine.values()].reduce((n, arr) => n + arr.length, 0);

  const head = document.createElement("div");
  head.className = "file-head static";
  head.innerHTML = `
    <span class="file-name">${esc(file.filename)}</span>
    <span class="file-status">${file.status}</span>
    ${count ? `<span class="file-comment-count">💬 ${count}</span>` : ""}
    <span class="file-counts"><span class="plus">+${file.additions}</span><span class="minus">−${file.deletions}</span></span>
  `;
  el.appendChild(head);
  el.appendChild(buildDiffElement(file, tab));
  return el;
}

// Builds the rendered diff (rows + any inline comment threads) for one file.
function buildDiffElement(file, tab) {
  const diff = document.createElement("div");
  diff.className = "diff";
  if (!file.patch) {
    diff.innerHTML = `<div class="binary-note">No text diff available (binary file or too large to display).</div>`;
    return diff;
  }

  // Inline review comments for this file, grouped by the line they target.
  const byLine = inlineCommentsByLine(tab, file.filename);
  const placed = new Set();
  for (const row of parsePatch(file.patch)) {
    diff.appendChild(renderDiffRow(row, file, tab));
    if (row.newLine && byLine.has(row.newLine)) {
      byLine.get(row.newLine).forEach((cm) => diff.appendChild(renderInlineThread(cm)));
      placed.add(row.newLine);
    }
  }
  // Comments whose target line isn't in the visible patch (outdated or out of
  // the shown hunks) still need a home — show them at the end of the file.
  const orphaned = [...byLine.entries()].filter(([line]) => !placed.has(line));
  for (const [, arr] of orphaned) {
    arr.forEach((cm) => diff.appendChild(renderInlineThread(cm, { orphaned: true })));
  }
  return diff;
}

// A small toolbar above the diff summarising resolved/outdated inline threads
// and a toggle to reveal resolved ones (hidden by default, like GitHub).
function renderReviewControls(tab) {
  const inline = (tab.comments && tab.comments.inline) || [];
  const resolved = inline.filter((c) => c.resolved).length;
  const outdated = inline.filter((c) => c.outdated).length;
  if (!resolved && !outdated) return "";

  const parts = [];
  if (resolved) {
    parts.push(`
      <label class="review-toggle">
        <input type="checkbox" id="showResolvedToggle" ${state.showResolved ? "checked" : ""} />
        Show resolved (${resolved})
      </label>`);
  }
  if (outdated) {
    parts.push(`<span class="review-stat">${outdated} outdated</span>`);
  }
  return `<div class="review-controls">${parts.join("")}</div>`;
}

// Inline threads visible under the current view filter. Resolved threads are
// hidden unless the user opts in; outdated threads are always shown (marked).
function visibleInline(tab) {
  const inline = (tab.comments && tab.comments.inline) || [];
  return state.showResolved ? inline : inline.filter((c) => !c.resolved);
}

// Map of newLine -> [comment, ...] for inline comments on this file.
function inlineCommentsByLine(tab, filename) {
  const map = new Map();
  for (const cm of visibleInline(tab)) {
    if (cm.path !== filename) continue;
    const line = cm.line;
    if (!map.has(line)) map.set(line, []);
    map.get(line).push(cm);
  }
  return map;
}

function renderInlineThread(cm, opts = {}) {
  const el = document.createElement("div");
  const classes = ["inline-comment"];
  if (opts.orphaned) classes.push("orphaned");
  if (cm.outdated) classes.push("outdated");
  if (cm.resolved) classes.push("resolved");
  el.className = classes.join(" ");

  const badges =
    (cm.outdated ? `<span class="cm-badge outdated">outdated</span>` : "") +
    (cm.resolved ? `<span class="cm-badge resolved">resolved</span>` : "");
  // For orphaned threads (anchor not in the shown diff) note where it lived.
  const where = opts.orphaned
    ? `<small>${esc(cm.path)}:${cm.originalLine ?? cm.line ?? "?"}</small>`
    : "";
  el.innerHTML = `
    <div class="comment-head">@${esc(cm.author)}${badges}${where}</div>
    <div class="comment-body">${esc(cm.body)}</div>`;
  return el;
}

function renderDiffRow(row, file, tab) {
  const el = document.createElement("div");
  el.className = "diff-row " + row.type;
  const canComment = row.type === "add" || row.type === "context";
  if (canComment) el.classList.add("commentable");

  el.innerHTML = `<span class="ln">${row.newLine ?? ""}</span><span class="code">${esc(row.text)}</span>`;

  if (canComment && row.newLine) {
    el.addEventListener("click", () => openInlineComposer(el, file, row, tab));
  }
  return el;
}

function openInlineComposer(rowEl, file, row, tab) {
  // one composer at a time
  document.querySelectorAll(".inline-composer").forEach((n) => n.remove());
  const box = document.createElement("div");
  box.className = "inline-composer";
  box.innerHTML = `
    <textarea placeholder="Comment on ${esc(file.filename)}:${row.newLine} — Cmd/Ctrl+Enter to post"></textarea>
    <button class="btn accent" type="button">Post</button>
    <button class="btn ghost" type="button">Cancel</button>
  `;
  const ta = box.querySelector("textarea");
  const [postBtn, cancelBtn] = box.querySelectorAll("button");
  const post = () => postComment(tab, ta.value, { path: file.filename, line: row.newLine }, box);
  postBtn.addEventListener("click", post);
  cancelBtn.addEventListener("click", () => box.remove());
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") post();
    if (e.key === "Escape") box.remove();
  });
  rowEl.insertAdjacentElement("afterend", box);
  ta.focus();
}

function renderConversation(tab) {
  const el = $("convo");
  const c = tab.comments;
  let html = `<h2>Conversation</h2>`;

  if (!c) {
    html += `<div class="notice info">Loading comments…</div>`;
  } else {
    // Inline (code-review) comments render in the diff next to their line; the
    // conversation section is only top-level PR comments.
    const all = [...(c.conversation || [])].sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );

    if (!all.length) {
      html += `<div class="notice info">No conversation comments yet.</div>`;
    } else {
      for (const cm of all) {
        html += `
          <div class="comment">
            <div class="comment-head">@${esc(cm.author)}</div>
            <div class="comment-body">${esc(cm.body)}</div>
          </div>`;
      }
    }
  }

  html += `
    <div class="composer">
      <textarea id="convoInput" placeholder="Leave a comment on this PR — Cmd/Ctrl+Enter to post"></textarea>
      <button class="btn accent" id="convoPost" type="button">Comment</button>
    </div>`;
  el.innerHTML = html;

  const input = $("convoInput");
  const send = () => postComment(tab, input.value, null);
  $("convoPost").addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
  });
}

// ---------- Posting comments ----------
async function postComment(tab, body, inline, composerEl) {
  body = (body || "").trim();
  if (!body) return;
  const payload = {
    owner: tab.owner,
    repo: tab.repo,
    number: tab.number,
    body,
  };
  if (inline) {
    payload.path = inline.path;
    payload.line = inline.line;
    payload.commitId = tab.data.headSha;
  }
  try {
    const r = await fetch("/api/pr/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || "Failed to post");
    if (composerEl) composerEl.remove();
    loadComments(tab.key);
  } catch (e) {
    flashError("Comment failed: " + e.message);
  }
}

// ---------- Agent ----------
let agentActive = false;
async function runAgent() {
  if (agentActive) return;
  const input = $("agentInput");
  const prompt = input.value.trim();
  if (!prompt) return;

  consoleEl.classList.remove("collapsed");
  const repoPath = repoPathEl.value.trim();
  if (state.active) {
    state.repoPaths[state.active] = repoPath;
    persist();
  }

  append(`\n› ${prompt}\n`, "sys");
  input.value = "";
  agentActive = true;
  $("agentRun").disabled = true;

  try {
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, repoPath, mode: agentModeEl.value }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      append(dec.decode(value, { stream: true }));
    }
  } catch (e) {
    append(`\n⚠ ${e.message}\n`, "err");
  } finally {
    agentActive = false;
    $("agentRun").disabled = false;
    // a finished agent run may have changed files — nothing to refetch from GitHub,
    // but remind the user their local checkout moved.
  }
}

function append(text, cls) {
  const node = document.createElement("span");
  if (cls) node.className = cls;
  node.textContent = text;
  consoleOut.appendChild(node);
  consoleOut.scrollTop = consoleOut.scrollHeight;
}

// ---------- Diff parsing ----------
function parsePatch(patch) {
  const rows = [];
  let newLine = 0;
  let oldLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
      }
      rows.push({ type: "hunk", text: line, newLine: null });
      continue;
    }
    const sign = line[0];
    const text = line.slice(1);
    if (sign === "+") {
      rows.push({ type: "add", text, newLine: newLine });
      newLine++;
    } else if (sign === "-") {
      rows.push({ type: "del", text, newLine: null, oldLine });
      oldLine++;
    } else {
      rows.push({ type: "context", text, newLine: newLine });
      newLine++;
      oldLine++;
    }
  }
  return rows;
}

// ---------- Utils ----------
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function flashError(msg) {
  const stage = reviewEl.hidden ? emptyEl : reviewEl;
  const n = document.createElement("div");
  n.className = "notice error";
  n.textContent = msg;
  stage.prepend(n);
  setTimeout(() => n.remove(), 6000);
}
