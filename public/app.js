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
const modeChipEl = $("modeChip");

let modeInfo = null;

// ---------- Boot ----------
init();

async function init() {
  // health
  try {
    const h = await fetch("/api/health").then((r) => r.json());
    renderStatus(h);
    if (h.defaultRepoPath) repoPathEl.value = h.defaultRepoPath;
  } catch {
    statusEl.classList.add("error");
    statusEl.title = "Server unreachable";
  }

  try {
    modeInfo = await fetch("/api/agent/modes").then((r) => r.json());
  } catch {
    modeInfo = null;
  }
  renderModeChip();

  const saved = loadPersisted();
  if (saved) {
    state.repoPaths = saved.repoPaths || {};
    state.agentMode = saved.agentMode || "review";
    state.showResolved = Boolean(saved.showResolved);
    agentModeEl.value = state.agentMode;
    renderModeChip();
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

function renderStatus(h) {
  statusEl.classList.remove("ok", "warn", "error");
  const overall = h.githubToken && h.claudeAvailable ? "ok" : !h.githubToken && !h.claudeAvailable ? "error" : "warn";
  statusEl.classList.add(overall);
  statusEl.title = "Setup status — click for details";

  const tokenLabel = {
    env: "GITHUB_TOKEN environment variable",
    "gh-cli": "gh CLI login (gh auth token)",
    "gh-config": "gh CLI login (hosts.yml)",
  }[h.tokenSource] || "none found";
  const tokenNote = h.githubToken
    ? "Read/write — comments can be posted."
    : "Read-only — public PRs only, can't post comments.";

  const claudeNote = h.claudeAvailable
    ? "Found on PATH — agent console is usable."
    : "Not found on PATH — agent console will fail to launch. Set CLAUDE_BIN or install Claude Code.";

  const popover = $("statusPopover");
  popover.innerHTML = `
    <div class="status-row">
      <div class="status-row-label">GitHub auth</div>
      <div class="status-row-value ${h.githubToken ? "ok" : "warn"}">${h.githubToken ? "Token found" : "No token"} — ${esc(tokenLabel)}</div>
      <div class="status-row-note">${tokenNote}</div>
    </div>
    <div class="status-row">
      <div class="status-row-label">Claude Code agent</div>
      <div class="status-row-value ${h.claudeAvailable ? "ok" : "warn"}">${h.claudeAvailable ? "Available" : "Not found"}</div>
      <div class="status-row-note">${claudeNote}</div>
    </div>
    <div class="status-row">
      <div class="status-row-label">Default repo path</div>
      <div class="status-row-value ${h.defaultRepoPath ? "ok" : "warn"}">${h.defaultRepoPath ? esc(h.defaultRepoPath) : "Not set"}</div>
      <div class="status-row-note">${h.defaultRepoPath ? "Used when a PR tab has no path of its own." : "Set DEFAULT_REPO_PATH or fill in the repo path field per tab."}</div>
    </div>
  `;
}

function renderModeChip() {
  if (!modeChipEl) return;
  const mode = agentModeEl.value || state.agentMode || "review";
  const info = modeInfo && modeInfo[mode];
  modeChipEl.classList.remove("readonly", "edit");
  if (!info) {
    modeChipEl.textContent = "";
    return;
  }
  modeChipEl.classList.add(mode === "fix" ? "edit" : "readonly");
  const tools = info.allowed.join(", ");
  modeChipEl.textContent = `${info.description} — ${tools}`;
  modeChipEl.title =
    info.description +
    (info.disallowed.length ? ` (disallowed: ${info.disallowed.join(", ")})` : "");
}

// ---------- Keyboard navigation ----------
let currentRowIndex = -1;

function getDiffRows() {
  return [...document.querySelectorAll("#fileMain .diff-row")];
}

function getFileRows() {
  return [...document.querySelectorAll("#fileSidebar .tree-file")];
}

function setCurrentRow(index) {
  const rows = getDiffRows();
  rows.forEach((r) => r.classList.remove("current"));
  if (!rows.length) {
    currentRowIndex = -1;
    return;
  }
  currentRowIndex = Math.max(0, Math.min(index, rows.length - 1));
  const row = rows[currentRowIndex];
  row.classList.add("current");
  row.scrollIntoView({ block: "nearest" });
}

function moveFile(delta) {
  const tab = state.tabs.find((t) => t.key === state.active);
  if (!tab) return;
  const fileRows = getFileRows();
  if (!fileRows.length) return;
  const filenames = fileRows.map((r) => r.dataset.view);
  let i = filenames.indexOf(tab.selected);
  if (i < 0) i = 0;
  else i = (i + delta + filenames.length) % filenames.length;
  tab.selected = filenames[i];
  currentRowIndex = -1;
  renderSidebar(tab);
  renderMain(tab);
}

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (document.querySelector(".inline-composer")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === "j" || e.key === "k") {
    e.preventDefault();
    if (currentRowIndex < 0) setCurrentRow(0);
    else setCurrentRow(currentRowIndex + (e.key === "j" ? 1 : -1));
  } else if (e.key === "n" || e.key === "p") {
    e.preventDefault();
    moveFile(e.key === "n" ? 1 : -1);
  } else if (e.key === "Enter") {
    if (currentRowIndex < 0) return;
    const rows = getDiffRows();
    const rowEl = rows[currentRowIndex];
    if (!rowEl || !rowEl.classList.contains("commentable")) return;
    e.preventDefault();
    rowEl.click();
  }
});

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
    renderModeChip();
    persist();
  });

  repoPathEl.addEventListener("change", () => {
    if (state.active) {
      state.repoPaths[state.active] = repoPathEl.value.trim();
      persist();
    }
  });

  statusEl.addEventListener("click", () => {
    $("statusPopover").hidden = !$("statusPopover").hidden;
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".status-wrap")) $("statusPopover").hidden = true;
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
    // The new tab.data may carry a different headSha; any cached file content
    // (fetched for markdown previews) was fetched against the old SHA and must
    // be refetched. fileViewModes/collapsedDirs are fine to keep across reloads.
    delete existing.fileContents;
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

// Left panel: a "Description" entry at the top, then a nested folder tree of
// the changed files. Selecting an entry swaps what the main pane shows.
function renderSidebar(tab) {
  const pr = tab.data;
  const el = $("fileSidebar");
  if (!tab.collapsedDirs) tab.collapsedDirs = new Set();

  const tree = buildFileTree(pr.files);

  el.innerHTML = `
    <div class="sidebar-item overview${tab.selected === OVERVIEW ? " active" : ""}" data-view="${OVERVIEW}">
      <span class="sidebar-icon">📝</span>
      <span class="sidebar-label">Description &amp; conversation</span>
    </div>
    <div class="sidebar-files-head">
      ${pr.files.length} ${pr.files.length === 1 ? "file" : "files"} changed
      <span class="kbd-help" title="Keyboard shortcuts:&#10;j / k — move highlight down/up in the diff&#10;n / p — next/previous file&#10;Enter — comment on highlighted row">?</span>
    </div>
    ${renderReviewControls(tab)}
    <div class="file-tree">${renderTreeNodes(tree, tab, "", 0)}</div>
  `;

  const resolvedToggle = $("showResolvedToggle");
  if (resolvedToggle) {
    resolvedToggle.addEventListener("change", () => {
      state.showResolved = resolvedToggle.checked;
      persist();
      renderReview();
    });
  }

  // File / overview rows select; folder rows toggle their collapsed state.
  el.querySelectorAll("[data-view]").forEach((item) => {
    item.addEventListener("click", () => {
      tab.selected = item.dataset.view;
      currentRowIndex = -1;
      renderSidebar(tab);
      renderMain(tab);
    });
  });
  el.querySelectorAll("[data-dir]").forEach((item) => {
    item.addEventListener("click", () => {
      const dir = item.dataset.dir;
      if (tab.collapsedDirs.has(dir)) tab.collapsedDirs.delete(dir);
      else tab.collapsedDirs.add(dir);
      renderSidebar(tab);
    });
  });
}

// Build a folder tree from flat file paths. Each node has `dirs` (name -> node)
// and `files` (the file objects living directly in this folder).
function buildFileTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.filename.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(file);
  }
  return root;
}

// Render a tree node's folders then files as flat rows, indented by depth.
// `prefix` is the full path to this node (so each folder has a stable id).
function renderTreeNodes(node, tab, prefix, depth) {
  let html = "";

  const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of dirNames) {
    // Collapse single-child folder chains into one row, like GitHub:
    // src → components → Foo.js becomes "src/components/Foo.js" only if each
    // intermediate folder has exactly one child and no files of its own.
    let child = node.dirs.get(name);
    let label = name;
    let path = prefix + name;
    while (child.files.length === 0 && child.dirs.size === 1) {
      const [onlyName, onlyChild] = [...child.dirs.entries()][0];
      label += "/" + onlyName;
      path += "/" + onlyName;
      child = onlyChild;
    }
    const collapsed = tab.collapsedDirs.has(path);
    html += `
      <div class="tree-row tree-dir${collapsed ? " collapsed" : ""}" data-dir="${esc(path)}" style="--depth:${depth}">
        <span class="tree-chevron">▶</span>
        <span class="tree-label">${esc(label)}</span>
      </div>`;
    if (!collapsed) html += renderTreeNodes(child, tab, path + "/", depth + 1);
  }

  const files = [...node.files].sort((a, b) =>
    a.filename.split("/").pop().localeCompare(b.filename.split("/").pop())
  );
  for (const file of files) {
    const byLine = inlineCommentsByLine(tab, file.filename);
    const count =
      [...byLine.right.values()].reduce((n, arr) => n + arr.length, 0) +
      [...byLine.left.values()].reduce((n, arr) => n + arr.length, 0);
    const active = tab.selected === file.filename ? " active" : "";
    const base = file.filename.split("/").pop();
    html += `
      <div class="tree-row tree-file${active}" data-view="${esc(file.filename)}" title="${esc(file.filename)}" style="--depth:${depth}">
        <span class="tree-label">${esc(base)}</span>
        <span class="file-item-meta">
          <span class="file-status">${file.status}</span>
          ${count ? `<span class="file-comment-count">💬 ${count}</span>` : ""}
          <span class="file-counts"><span class="plus">+${file.additions}</span><span class="minus">−${file.deletions}</span></span>
        </span>
      </div>`;
  }

  return html;
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
  const count =
    [...byLine.right.values()].reduce((n, arr) => n + arr.length, 0) +
    [...byLine.left.values()].reduce((n, arr) => n + arr.length, 0);

  const showToggle = isMarkdownFile(file.filename);
  const mode = getFileViewMode(tab, file);

  const head = document.createElement("div");
  head.className = "file-head static";
  head.innerHTML = `
    <span class="file-name">${esc(file.filename)}</span>
    <span class="file-status">${file.status}</span>
    ${count ? `<span class="file-comment-count">💬 ${count}</span>` : ""}
    <span class="file-counts"><span class="plus">+${file.additions}</span><span class="minus">−${file.deletions}</span></span>
    ${showToggle ? `
      <label class="review-toggle view-mode-toggle">
        <input type="checkbox" class="view-mode-input" ${mode === "preview" ? "checked" : ""} />
        Preview
      </label>` : ""}
  `;
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "file-body";
  el.appendChild(body);

  if (showToggle && mode === "preview") {
    renderPreview(file, tab, body);
  } else {
    body.appendChild(buildDiffElement(file, tab));
  }

  if (showToggle) {
    head.querySelector(".view-mode-input").addEventListener("change", (e) => {
      tab.fileViewModes[file.filename] = e.target.checked ? "preview" : "diff";
      renderMain(tab);
    });
  }

  return el;
}

// ---------- Markdown preview ----------
function isMarkdownFile(filename) {
  return /\.(md|markdown)$/i.test(filename);
}

// Lazily-initialized, per-tab, transient (not persisted) view-mode map. Markdown
// files default to "preview"; everything else defaults to "diff".
function getFileViewMode(tab, file) {
  tab.fileViewModes = tab.fileViewModes || {};
  if (!(file.filename in tab.fileViewModes)) {
    tab.fileViewModes[file.filename] = isMarkdownFile(file.filename) ? "preview" : "diff";
  }
  return tab.fileViewModes[file.filename];
}

// marked.parse is the v9+ API; fall back to calling marked() directly for
// older UMD bundles that export the function itself.
const mdParse =
  typeof marked !== "undefined" && marked.parse ? marked.parse.bind(marked) : marked;

// Segments a markdown source into 1-indexed, inclusive line ranges, one per
// top-level block (heading, fenced code, table, blockquote, list, paragraph).
// Blank lines are skipped. Every non-blank line ends up in exactly one block,
// and blocks are returned in source order so line numbers map 1:1 to
// `source.split("\n")` indices.
function splitMarkdownLineBlocks(source) {
  const lines = source.split("\n");
  const n = lines.length;
  const blocks = [];
  let i = 0; // 0-indexed cursor

  const isBlank = (s) => s.trim() === "";

  while (i < n) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    // Fenced code block: ```... or ~~~...
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[2][0];
      const fenceLen = fenceMatch[2].length;
      const start = i;
      i++;
      const closeRe = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);
      while (i < n && !closeRe.test(lines[i])) i++;
      if (i < n) i++; // consume closing fence line
      blocks.push({ startLine: start + 1, endLine: i });
      continue;
    }

    // ATX heading
    if (/^#{1,6}\s/.test(line)) {
      blocks.push({ startLine: i + 1, endLine: i + 1 });
      i++;
      continue;
    }

    // GFM table: current line has a pipe, next line is a separator row.
    const sepRe = /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
    if (line.includes("|") && i + 1 < n && sepRe.test(lines[i + 1])) {
      const start = i;
      i += 2; // header + separator
      while (i < n && !isBlank(lines[i]) && lines[i].includes("|")) i++;
      blocks.push({ startLine: start + 1, endLine: i });
      continue;
    }

    // Blockquote
    if (/^\s*>/.test(line)) {
      const start = i;
      i++;
      while (i < n && !isBlank(lines[i]) && /^\s*>/.test(lines[i])) i++;
      blocks.push({ startLine: start + 1, endLine: i });
      continue;
    }

    // List
    const listItemRe = /^\s*([-*+]|\d+[.)])\s/;
    if (listItemRe.test(line)) {
      const start = i;
      i++;
      for (;;) {
        if (i >= n) break;
        if (listItemRe.test(lines[i]) || /^\s+\S/.test(lines[i])) {
          i++;
          continue;
        }
        if (isBlank(lines[i])) {
          // Loose list: a single blank line followed by another list item or
          // an indented continuation keeps the block going.
          const next = lines[i + 1];
          if (next != null && (listItemRe.test(next) || /^\s+\S/.test(next))) {
            i++; // consume the blank line, keep scanning
            continue;
          }
          break;
        }
        break;
      }
      blocks.push({ startLine: start + 1, endLine: i });
      continue;
    }

    // Paragraph (fallback): contiguous non-blank lines not matching anything above.
    {
      const start = i;
      i++;
      while (i < n && !isBlank(lines[i])) i++;
      blocks.push({ startLine: start + 1, endLine: i });
    }
  }

  return blocks;
}

// Renders a markdown file's content as a series of blocks, with right-side
// inline comments threaded in and "commentable" blocks clickable to open the
// composer (reusing the existing inline-comment posting flow).
function buildPreviewElement(file, tab, content) {
  const root = document.createElement("div");
  root.className = "md-preview";

  const commentableRight = new Set();
  if (file.patch) {
    for (const row of parsePatch(file.patch)) {
      if ((row.type === "add" || row.type === "context") && row.newLine) {
        commentableRight.add(row.newLine);
      }
    }
  }

  const byLine = inlineCommentsByLine(tab, file.filename);
  const placedRight = new Set();
  const lines = content.split("\n");

  if (content.trim() === "") {
    root.innerHTML = `<div class="binary-note">(empty file)</div>`;
    return root;
  }

  for (const blk of splitMarkdownLineBlocks(content)) {
    const slice = lines.slice(blk.startLine - 1, blk.endLine).join("\n");
    const wrap = document.createElement("div");
    wrap.className = "md-block";
    wrap.dataset.startLine = blk.startLine;
    wrap.dataset.endLine = blk.endLine;
    wrap.innerHTML = mdParse(slice, { gfm: true, breaks: false });

    let target = null;
    for (let ln = blk.startLine; ln <= blk.endLine; ln++) {
      if (commentableRight.has(ln)) { target = ln; break; }
    }
    if (target != null) {
      wrap.classList.add("commentable");
      wrap.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        openInlineComposer(wrap, file, { side: "RIGHT", line: target }, tab);
      });
    }

    root.appendChild(wrap);

    for (let ln = blk.startLine; ln <= blk.endLine; ln++) {
      if (byLine.right.has(ln) && !placedRight.has(ln)) {
        byLine.right.get(ln).forEach((cm) => root.appendChild(renderInlineThread(cm)));
        placedRight.add(ln);
      }
    }
  }

  const orphanedRight = [...byLine.right.entries()].filter(([line]) => !placedRight.has(line));
  for (const [, arr] of orphanedRight) {
    arr.forEach((cm) => root.appendChild(renderInlineThread(cm, { orphaned: true })));
  }
  // LEFT-side comments target removed lines, which have no home in a preview
  // of the current file content — show them as orphaned, like outdated threads.
  for (const arr of byLine.left.values()) {
    arr.forEach((cm) => root.appendChild(renderInlineThread(cm, { orphaned: true })));
  }

  return root;
}

// Fetches a file's content at the PR's head SHA for markdown preview.
function fetchFileContent(tab, filename) {
  const ref = tab.data.headSha;
  const url = `/api/pr/file?owner=${encodeURIComponent(tab.owner)}&repo=${encodeURIComponent(tab.repo)}&path=${encodeURIComponent(filename)}&ref=${encodeURIComponent(ref)}`;
  return fetch(url).then(async (r) => {
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || "Failed to load file");
    return body.content;
  });
}

// Loads (and caches per-tab) a markdown file's content and renders it into
// `container`. Guards against staleness if the user navigates away or
// switches back to diff view before the fetch resolves.
async function renderPreview(file, tab, container) {
  container.innerHTML = `<div class="preview-loading">Loading preview…</div>`;

  tab.fileContents = tab.fileContents || {};
  if (!tab.fileContents[file.filename]) {
    tab.fileContents[file.filename] = fetchFileContent(tab, file.filename);
  }

  let content;
  try {
    content = await tab.fileContents[file.filename];
  } catch (e) {
    if (tab.selected !== file.filename || getFileViewMode(tab, file) !== "preview") return;
    if (!container.isConnected) return;
    delete tab.fileContents[file.filename];
    container.innerHTML = "";
    const note = document.createElement("div");
    note.className = "binary-note";
    note.textContent = `Failed to load preview: ${e.message}`;
    const btn = document.createElement("button");
    btn.className = "btn ghost";
    btn.type = "button";
    btn.textContent = "Show diff";
    btn.addEventListener("click", () => {
      tab.fileViewModes[file.filename] = "diff";
      renderMain(tab);
    });
    container.appendChild(note);
    container.appendChild(btn);
    return;
  }

  if (tab.selected !== file.filename || getFileViewMode(tab, file) !== "preview") return;
  if (!container.isConnected) return;

  container.innerHTML = "";
  container.appendChild(buildPreviewElement(file, tab, content));
}

// Builds the rendered diff (rows + any inline comment threads) for one file.
function buildDiffElement(file, tab) {
  const diff = document.createElement("div");
  diff.className = "diff";
  if (!file.patch) {
    diff.innerHTML = `<div class="binary-note">No text diff available (binary file or too large to display).</div>`;
    return diff;
  }

  // Inline review comments for this file, grouped by side and the line they target.
  const byLine = inlineCommentsByLine(tab, file.filename);
  const placedRight = new Set();
  const placedLeft = new Set();
  for (const row of parsePatch(file.patch)) {
    diff.appendChild(renderDiffRow(row, file, tab));
    if (row.type === "del") {
      if (row.oldLine && byLine.left.has(row.oldLine)) {
        byLine.left.get(row.oldLine).forEach((cm) => diff.appendChild(renderInlineThread(cm)));
        placedLeft.add(row.oldLine);
      }
    } else if (row.newLine && byLine.right.has(row.newLine)) {
      byLine.right.get(row.newLine).forEach((cm) => diff.appendChild(renderInlineThread(cm)));
      placedRight.add(row.newLine);
    }
  }
  // Comments whose target line isn't in the visible patch (outdated or out of
  // the shown hunks) still need a home — show them at the end of the file.
  const orphanedRight = [...byLine.right.entries()].filter(([line]) => !placedRight.has(line));
  const orphanedLeft = [...byLine.left.entries()].filter(([line]) => !placedLeft.has(line));
  for (const [, arr] of [...orphanedRight, ...orphanedLeft]) {
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

// Returns { right, left } maps of line -> [comment, ...] for inline comments on
// this file. RIGHT-side comments key on `line`/`newLine` (added/context rows);
// LEFT-side comments key on `line`/`oldLine` (removed/context rows). Outdated
// comments have `line: null`, so fall back to `originalLine`/`originalSide`.
function inlineCommentsByLine(tab, filename) {
  const right = new Map();
  const left = new Map();
  for (const cm of visibleInline(tab)) {
    if (cm.path !== filename) continue;
    const side = cm.line != null ? cm.side : cm.originalSide || cm.side;
    const line = cm.line ?? cm.originalLine;
    if (line == null) continue;
    const map = side === "LEFT" ? left : right;
    if (!map.has(line)) map.set(line, []);
    map.get(line).push(cm);
  }
  return { right, left };
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
  const canComment = row.type === "add" || row.type === "context" || row.type === "del";
  if (canComment) el.classList.add("commentable");

  el.innerHTML = `<span class="ln">${row.newLine ?? ""}</span><span class="code">${esc(row.text)}</span>`;

  const target =
    row.type === "del" ? { side: "LEFT", line: row.oldLine } : { side: "RIGHT", line: row.newLine };

  if (canComment && target.line) {
    el.addEventListener("click", () => openInlineComposer(el, file, target, tab));
  }
  return el;
}

function openInlineComposer(rowEl, file, target, tab) {
  // one composer at a time
  document.querySelectorAll(".inline-composer").forEach((n) => n.remove());
  const box = document.createElement("div");
  box.className = "inline-composer";
  box.innerHTML = `
    <textarea placeholder="Comment on ${esc(file.filename)}:${target.line} — Cmd/Ctrl+Enter to post"></textarea>
    <button class="btn accent" type="button">Post</button>
    <button class="btn ghost" type="button">Cancel</button>
  `;
  const ta = box.querySelector("textarea");
  const [postBtn, cancelBtn] = box.querySelectorAll("button");
  const post = () => postComment(tab, ta.value, { path: file.filename, line: target.line, side: target.side }, box);
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
    payload.side = inline.side || "RIGHT";
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
      rows.push({ type: "add", text, newLine: newLine, oldLine: null });
      newLine++;
    } else if (sign === "-") {
      rows.push({ type: "del", text, newLine: null, oldLine });
      oldLine++;
    } else {
      rows.push({ type: "context", text, newLine: newLine, oldLine: oldLine });
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
