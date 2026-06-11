"use strict";

// ---------- State ----------
const LS_KEY = "pr-studio:state:v1";
const state = {
  tabs: [], // { key, owner, repo, number, title, state, draft, data, comments }
  active: null,
  repoPaths: {}, // key -> local path
  agentMode: "review",
  showResolved: false, // view toggle: include resolved inline threads in the diff
  breakdowns: {}, // key -> { chunks, reviewed: number[] }
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
    breakdowns: state.breakdowns,
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
let healthInfo = null;

// Set by loadComments() when the selected file renders asynchronously (markdown/
// notebook preview), so the preview function can re-apply the saved #fileMain
// scroll position once its real content lands. See loadComments() for details.
let pendingMainScroll = null;

// ---------- Boot ----------
init();

async function init() {
  // health
  try {
    const h = await fetch("/api/health").then((r) => r.json());
    healthInfo = h;
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
    state.breakdowns = saved.breakdowns || {};
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

// ---------- Split-pane helpers ----------
// A tab can show two files side by side: tab.selected (primary/left pane) and
// tab.selectedSecondary (right pane, a filename or null). tab.activePane
// ("primary" | "secondary") is which pane keyboard nav and sidebar clicks act on.

// Is this file currently displayed in either pane of this tab?
function fileIsVisible(tab, filename) {
  return filename === tab.selected || filename === tab.selectedSecondary;
}

// The DOM element of the currently active pane's scroll container. In split
// mode this is the .diff-pane.active element; otherwise it's #fileMain itself.
function activePaneEl() {
  return document.querySelector("#fileMain .diff-pane.active") || $("fileMain");
}

// Point the active pane at `filename`. Primary pane can also hold OVERVIEW;
// the secondary pane only ever holds a real filename.
function setActivePaneSelection(tab, filename) {
  if (tab.activePane === "secondary") {
    tab.selectedSecondary = filename;
  } else {
    tab.selected = filename;
  }
}

// ---------- Keyboard navigation ----------
let currentRowIndex = -1;

function getDiffRows() {
  // Scope to the active pane so j/k navigate only the focused side in split view.
  return [...activePaneEl().querySelectorAll(".diff-row")];
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
  // Step from whatever file the ACTIVE pane currently shows.
  const current =
    tab.activePane === "secondary" ? tab.selectedSecondary : tab.selected;
  let i = filenames.indexOf(current);
  if (i < 0) i = 0;
  else i = (i + delta + filenames.length) % filenames.length;
  setActivePaneSelection(tab, filenames[i]);
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

  $("addrCommentsBtn").addEventListener("click", () => {
    const tab = state.tabs.find((t) => t.key === state.active);
    if (!tab) {
      consoleEl.classList.remove("collapsed");
      append("\n⚠ Open a PR tab first — there's no active PR to address comments for.\n", "err");
      return;
    }
    const input = $("agentInput");
    input.value = buildCommentReviewPrompt(tab.key, agentModeEl.value);
    input.focus();
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

  const myPrsBtn = $("myPrsBtn");
  const myPrsPanel = $("myPrsPanel");
  if (healthInfo && !healthInfo.githubToken) {
    myPrsBtn.disabled = true;
    myPrsBtn.title =
      "Set a GitHub token (GITHUB_TOKEN or `gh auth login`) to detect your PRs.";
  }
  myPrsBtn.addEventListener("click", () => {
    if (myPrsBtn.disabled) return;
    if (!myPrsPanel.hidden) {
      myPrsPanel.hidden = true;
      return;
    }
    myPrsPanel.hidden = false;
    loadMyPrs();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".my-prs-wrap")) myPrsPanel.hidden = true;
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
  const savedBd = state.breakdowns && state.breakdowns[key];
  if (savedBd) {
    tab.breakdown = savedBd.chunks;
    tab.reviewedChunks = new Set(savedBd.reviewed || []);
  }
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
    if (state.active === key) {
      // renderReview() rebuilds #fileSidebar and #fileMain from scratch, which
      // resets their scroll position to 0. Capture and restore scrollTop so
      // posting a comment doesn't snap the view back to the top.
      const oldSidebar = $("fileSidebar");
      const oldMain = $("fileMain");
      const sidebarScroll = oldSidebar ? oldSidebar.scrollTop : 0;
      const mainScroll = oldMain ? oldMain.scrollTop : 0;
      renderReview();
      const newSidebar = $("fileSidebar");
      const newMain = $("fileMain");
      if (newSidebar) newSidebar.scrollTop = sidebarScroll;
      if (newMain) newMain.scrollTop = mainScroll;
      // The markdown/notebook preview paths render asynchronously: they first
      // show a short "Loading preview…" placeholder, then await the file
      // content before appending the real (tall) element. The synchronous
      // restore above runs against the placeholder and gets clamped to ~0, so
      // stash the desired scroll position for the preview function to
      // re-apply once its real content is in place. Only do this when the
      // selected file will actually take that async preview path, so the
      // value never leaks into a later unrelated render.
      const selectedFile =
        tab.selected !== OVERVIEW
          ? tab.data?.files?.find((f) => f.filename === tab.selected)
          : null;
      if (
        selectedFile &&
        getFileViewMode(tab, selectedFile) === "preview" &&
        (isMarkdownFile(selectedFile.filename) || isNotebookFile(selectedFile.filename))
      ) {
        pendingMainScroll = mainScroll;
      }
    }
  } catch {
    /* comments are best-effort */
  }
}

// ---------- My PRs dropdown ----------
// Fetches the authenticated user's open PRs and renders them into the dropdown
// panel. Selecting one reuses openPr(). Best-effort: failures render inline.
async function loadMyPrs() {
  const panel = $("myPrsPanel");
  panel.innerHTML = `<div class="my-prs-state">Loading…</div>`;
  try {
    const res = await fetch("/api/my-prs");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Failed to load your PRs");
    renderMyPrs(body.prs || []);
  } catch (e) {
    panel.innerHTML = `<div class="my-prs-state error">${esc(e.message)}</div>`;
  }
}

function renderMyPrs(prs) {
  const panel = $("myPrsPanel");
  if (!prs.length) {
    panel.innerHTML = `<div class="my-prs-state">No open PRs involving you.</div>`;
    return;
  }
  panel.innerHTML = prs
    .map(
      (pr) => `
      <button type="button" class="my-pr-item" data-ref="${esc(pr.owner)}/${esc(pr.repo)}#${pr.number}">
        <span class="my-pr-item-top">
          <span class="my-pr-repo">${esc(pr.owner)}/${esc(pr.repo)}#${pr.number}</span>
          ${pr.draft ? `<span class="my-pr-draft">draft</span>` : ""}
        </span>
        <span class="my-pr-title">${esc(pr.title)}</span>
      </button>`
    )
    .join("");
  panel.querySelectorAll(".my-pr-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("myPrsPanel").hidden = true;
      openPr(btn.dataset.ref);
    });
  });
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
  if (!tab.sidebarView) tab.sidebarView = "files";
  if (tab.activePane !== "secondary") tab.activePane = "primary";

  renderSidebar(tab);
  renderMain(tab);
}

// Renders the "Chunks" sidebar view: an empty state with a "Break into chunks"
// button if no breakdown exists yet, or the agent's ordered, collapsible
// review chunks.
function renderChunksView(tab) {
  const hint = tab.breakdownError ? esc(tab.breakdownError) : "";
  const loading = !!tab.breakdownLoading;

  if (!Array.isArray(tab.breakdown) || tab.breakdown.length === 0) {
    return `
      <div class="chunks-empty">
        <p class="chunks-empty-text">Let the agent organize this PR into an ordered, guided walkthrough of small review chunks.</p>
        <button type="button" class="btn accent" id="runBreakdownBtn"${loading ? " disabled" : ""}>${loading ? "Analyzing…" : "Break into chunks"}</button>
        <p class="chunks-hint${tab.breakdownError ? " error" : ""}" id="breakdownHint">${hint}</p>
      </div>`;
  }

  if (!tab.collapsedChunks) tab.collapsedChunks = new Set();
  if (!tab.reviewedChunks) tab.reviewedChunks = new Set();
  const reviewedCount = tab.breakdown.filter((_, i) => tab.reviewedChunks.has(i)).length;

  let html = `
    <div class="chunks-head">
      <span>${tab.breakdown.length} chunks</span>
      <span class="chunks-progress">${reviewedCount} / ${tab.breakdown.length} reviewed</span>
      <button type="button" class="btn ghost" id="rerunBreakdownBtn"${loading ? " disabled" : ""}>${loading ? "Re-running…" : "Re-run"}</button>
    </div>
    ${tab.breakdownError ? `<p class="chunks-hint error">${hint}</p>` : ""}`;

  tab.breakdown.forEach((chunk, i) => {
    const collapsed = tab.collapsedChunks.has(i);
    const reviewed = tab.reviewedChunks.has(i);
    const fileRows = chunk.files
      .map(
        (fn) => `
      <div class="tree-row tree-file chunk-file${fileIsVisible(tab, fn) ? " active" : ""}" data-view="${esc(fn)}" title="${esc(fn)}">
        <span class="tree-label">${esc(fn.split("/").pop())}</span>
      </div>`
      )
      .join("");

    html += `
      <div class="chunk-section${collapsed ? " collapsed" : ""}${reviewed ? " reviewed" : ""}">
        <div class="chunk-head" data-chunk="${i}">
          <label class="chunk-reviewed-wrap" title="Mark this chunk reviewed">
            <input type="checkbox" class="chunk-reviewed" data-reviewed="${i}" ${reviewed ? "checked" : ""} />
          </label>
          <span class="chunk-chevron">▶</span>
          <span class="chunk-index">${i + 1}</span>
          <span class="chunk-title">${esc(chunk.title)}</span>
          <span class="chunk-count">${chunk.files.length}</span>
        </div>
        <div class="chunk-body">
          <p class="chunk-narrative">${esc(chunk.narrative)}</p>
          <div class="chunk-files">${fileRows}</div>
        </div>
      </div>`;
  });

  return html;
}

function saveBreakdown(tab) {
  if (!tab.breakdown) {
    delete state.breakdowns[tab.key];
  } else {
    state.breakdowns[tab.key] = {
      chunks: tab.breakdown,
      reviewed: [...(tab.reviewedChunks || [])],
    };
  }
  persist();
}

// Calls the backend to break the PR into review chunks, managing loading and
// error state on the tab and re-rendering the sidebar as it progresses.
async function runBreakdownForTab(tab) {
  if (tab.breakdownLoading) return;
  const repoPath = repoPathEl.value.trim();
  if (state.active) {
    state.repoPaths[state.active] = repoPath;
    persist();
  }
  // Pre-flight guards — set an error and bail without a network call.
  if (healthInfo && !healthInfo.claudeAvailable) {
    tab.breakdownError = "Claude Code isn't on PATH — the agent can't run. Install it or set CLAUDE_BIN.";
    renderSidebar(tab);
    return;
  }
  if (!repoPath) {
    tab.breakdownError = "Set a local repo path (top of the page) so the agent has a checkout to read.";
    renderSidebar(tab);
    return;
  }

  tab.breakdownLoading = true;
  tab.breakdownError = null;
  renderSidebar(tab);

  try {
    const res = await fetch("/api/pr/breakdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: tab.data.files,
        title: tab.data.title,
        repoPath,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    const data = await res.json();
    tab.breakdown = Array.isArray(data.chunks) ? data.chunks : [];
    tab.collapsedChunks = new Set();
    tab.reviewedChunks = new Set();
    saveBreakdown(tab);
  } catch (e) {
    tab.breakdownError = e.message || "Breakdown failed.";
  } finally {
    tab.breakdownLoading = false;
    renderSidebar(tab);
  }
}

// Left panel: a "Description" entry at the top, then a nested folder tree of
// the changed files. Selecting an entry swaps what the main pane shows.
function renderSidebar(tab) {
  const pr = tab.data;
  const el = $("fileSidebar");
  if (!tab.collapsedDirs) tab.collapsedDirs = new Set();

  const tree = buildFileTree(pr.files);

  const view = tab.sidebarView || "files";
  const filesArea = `
    <div class="sidebar-files-head">
      ${pr.files.length} ${pr.files.length === 1 ? "file" : "files"} changed
      <span class="kbd-help" title="Keyboard shortcuts:&#10;j / k — move highlight down/up in the diff&#10;n / p — next/previous file&#10;Enter — comment on highlighted row">?</span>
    </div>
    ${renderReviewControls(tab)}
    <div class="file-tree">${renderTreeNodes(tree, tab, "", 0)}</div>`;

  el.innerHTML = `
    <div class="sidebar-item overview${tab.selected === OVERVIEW ? " active" : ""}" data-view="${OVERVIEW}">
      <span class="sidebar-icon">📝</span>
      <span class="sidebar-label">Description &amp; conversation</span>
    </div>
    <div class="sidebar-view-toggle">
      <button type="button" class="view-toggle-btn${view === "files" ? " active" : ""}" data-sidebar-view="files">Files</button>
      <button type="button" class="view-toggle-btn${view === "chunks" ? " active" : ""}" data-sidebar-view="chunks">Chunks</button>
    </div>
    ${view === "chunks" ? renderChunksView(tab) : filesArea}
  `;

  el.querySelectorAll("[data-sidebar-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      tab.sidebarView = btn.dataset.sidebarView;
      renderSidebar(tab);
    });
  });

  el.querySelectorAll("[data-chunk]").forEach((head) => {
    head.addEventListener("click", () => {
      const i = Number(head.dataset.chunk);
      if (!tab.collapsedChunks) tab.collapsedChunks = new Set();
      if (tab.collapsedChunks.has(i)) tab.collapsedChunks.delete(i);
      else tab.collapsedChunks.add(i);
      renderSidebar(tab);
    });
  });

  el.querySelectorAll("[data-reviewed]").forEach((box) => {
    // Stop the click from bubbling to the chunk-head collapse handler.
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
      const i = Number(box.dataset.reviewed);
      if (!tab.reviewedChunks) tab.reviewedChunks = new Set();
      if (box.checked) tab.reviewedChunks.add(i);
      else tab.reviewedChunks.delete(i);
      saveBreakdown(tab);
      renderSidebar(tab);
    });
  });

  const runBtn = $("runBreakdownBtn");
  if (runBtn) runBtn.addEventListener("click", () => runBreakdownForTab(tab));
  const rerunBtn = $("rerunBreakdownBtn");
  if (rerunBtn) rerunBtn.addEventListener("click", () => runBreakdownForTab(tab));

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
    item.addEventListener("click", (e) => {
      const view = item.dataset.view;
      if ((e.metaKey || e.ctrlKey) && view !== OVERVIEW) {
        // Modifier-click opens the file in the secondary (right) pane.
        tab.selectedSecondary = view;
        tab.activePane = "secondary";
      } else if (view === OVERVIEW) {
        // The overview/description only ever lives in the primary pane.
        tab.selected = OVERVIEW;
        tab.activePane = "primary";
      } else {
        // Plain click replaces whichever pane is currently active.
        setActivePaneSelection(tab, view);
      }
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
    const active = fileIsVisible(tab, file.filename) ? " active" : "";
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

  // Drop a stale secondary selection that no longer maps to a changed file.
  if (tab.selectedSecondary &&
      !tab.data.files.find((f) => f.filename === tab.selectedSecondary)) {
    tab.selectedSecondary = null;
  }

  // Single-pane mode: unchanged legacy behavior. #fileMain holds the content
  // directly and is the scroll container, so existing scroll logic still works.
  if (!tab.selectedSecondary) {
    el.classList.remove("split");
    if (tab.activePane === "secondary") tab.activePane = "primary";
    renderPrimaryInto(tab, el);
    return;
  }

  // Split mode: two independently-scrolling panes inside #fileMain.
  const secondaryFile = tab.data.files.find(
    (f) => f.filename === tab.selectedSecondary
  );
  el.classList.add("split");
  el.innerHTML = "";

  const primary = document.createElement("div");
  primary.className = "diff-pane";
  renderPrimaryInto(tab, primary);

  const secondary = document.createElement("div");
  secondary.className = "diff-pane";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "pane-close";
  close.title = "Close split";
  close.textContent = "✕";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    tab.selectedSecondary = null;
    tab.activePane = "primary";
    renderMain(tab);
  });
  secondary.appendChild(close);
  secondary.appendChild(renderFileDiff(secondaryFile, tab));

  const panes = { primary, secondary };
  primary.classList.toggle("active", tab.activePane !== "secondary");
  secondary.classList.toggle("active", tab.activePane === "secondary");
  primary.addEventListener("mousedown", () => setActivePane(tab, "primary", panes));
  secondary.addEventListener("mousedown", (e) => {
    if (e.target.closest(".pane-close")) return;
    setActivePane(tab, "secondary", panes);
  });

  el.appendChild(primary);
  el.appendChild(secondary);
}

// Fill `el` with the primary-pane content: the overview, or the tab.selected
// file diff. Mirrors the original single-pane renderMain body.
function renderPrimaryInto(tab, el) {
  if (tab.selected === OVERVIEW) {
    renderOverview(tab, el);
    return;
  }
  const file = tab.data.files.find((f) => f.filename === tab.selected);
  if (!file) {
    // Selection no longer resolves (shouldn't happen) — fall back to overview.
    tab.selected = OVERVIEW;
    renderSidebar(tab);
    return renderPrimaryInto(tab, el);
  }
  el.innerHTML = "";
  el.appendChild(renderFileDiff(file, tab));
}

// Mark `which` pane active by toggling the .active class only (no re-render, so
// an in-flight click that opens a comment composer in this pane survives).
function setActivePane(tab, which, panes) {
  if (tab.activePane === which) return;
  tab.activePane = which;
  panes.primary.classList.toggle("active", which === "primary");
  panes.secondary.classList.toggle("active", which === "secondary");
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

  const isNotebook = isNotebookFile(file.filename);
  const showToggle = isMarkdownFile(file.filename) || isNotebook;
  const mode = getFileViewMode(tab, file);
  const toggleLabel = isNotebook ? "Rendered" : "Preview";

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
        ${toggleLabel}
      </label>` : ""}
  `;
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "file-body";
  el.appendChild(body);

  if (showToggle && mode === "preview") {
    if (isNotebook) {
      renderNotebookPreview(file, tab, body);
    } else {
      renderPreview(file, tab, body);
    }
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

function isNotebookFile(filename) {
  return /\.ipynb$/i.test(filename);
}

// Lazily-initialized, per-tab, transient (not persisted) view-mode map. Markdown
// and notebook files default to "preview"; everything else defaults to "diff".
function getFileViewMode(tab, file) {
  tab.fileViewModes = tab.fileViewModes || {};
  if (!(file.filename in tab.fileViewModes)) {
    tab.fileViewModes[file.filename] =
      (isMarkdownFile(file.filename) || isNotebookFile(file.filename)) ? "preview" : "diff";
  }
  return tab.fileViewModes[file.filename];
}

// Highlight fenced code blocks with highlight.js. marked v18 passes the code
// renderer a token { text, lang }; `lang` is the fence info-string (a language
// name like "python"/"py"/"sql"), which hljs resolves directly (aliases included).
if (typeof marked !== "undefined" && marked.use) {
  marked.use({
    renderer: {
      code({ text, lang }) {
        const name = (lang || "").trim().toLowerCase();
        const lines = highlightToLines(text, name);
        if (lines) {
          return `<pre><code class="hljs language-${esc(name)}">${lines.join("\n")}</code></pre>`;
        }
        const cls = name ? ` class="language-${esc(name)}"` : "";
        return `<pre><code${cls}>${esc(text)}</code></pre>`;
      },
    },
  });
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
    if (!fileIsVisible(tab, file.filename) || getFileViewMode(tab, file) !== "preview") return;
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

  if (!fileIsVisible(tab, file.filename) || getFileViewMode(tab, file) !== "preview") return;
  if (!container.isConnected) return;

  container.innerHTML = "";
  container.appendChild(buildPreviewElement(file, tab, content));

  // Re-apply the #fileMain scroll position stashed by loadComments(), now that
  // the real (tall) content has replaced the "Loading preview…" placeholder.
  if (pendingMainScroll != null) {
    const main = $("fileMain");
    if (main) main.scrollTop = pendingMainScroll;
    pendingMainScroll = null;
  }
}

// ---------- Notebook preview ----------

// nbformat `source` fields are either a string or an array of strings (each
// already including its trailing newline). Normalize to a single string.
function joinSource(src) {
  if (Array.isArray(src)) return src.join("");
  return src == null ? "" : String(src);
}

// Maps each cell in `notebook.cells` to a 1-indexed, inclusive raw-line span
// in `rawContent`, by scanning for `"cell_type":` occurrences in source order.
// Returns null if the number of matches doesn't line up with the cell count
// (caller still renders cells, just without click-to-comment).
function mapCellsToRawLines(rawContent, notebook) {
  const cells = notebook.cells || [];
  const lines = rawContent.split("\n");
  const cellTypeRe = /"cell_type"\s*:/;
  const matchLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (cellTypeRe.test(lines[i])) matchLines.push(i + 1); // 1-indexed
  }
  if (matchLines.length !== cells.length) return null;

  const spans = [];
  for (let i = 0; i < matchLines.length; i++) {
    const startLine = matchLines[i];
    const endLine = i + 1 < matchLines.length ? matchLines[i + 1] - 1 : lines.length;
    spans.push({ startLine, endLine });
  }
  return spans;
}

// Renders a single cell's `outputs` array (stream/error/execute_result/display_data).
function renderNotebookOutputs(outputs) {
  const frag = document.createDocumentFragment();
  for (const output of outputs || []) {
    if (output.output_type === "stream") {
      const pre = document.createElement("pre");
      pre.className = "nb-output nb-stream";
      if (output.name === "stderr") pre.classList.add("nb-stderr");
      pre.innerHTML = esc(joinSource(output.text));
      frag.appendChild(pre);
      continue;
    }

    if (output.output_type === "error") {
      const traceback = (output.traceback || []).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
      const pre = document.createElement("pre");
      pre.className = "nb-output nb-error";
      pre.innerHTML = esc(traceback);
      frag.appendChild(pre);
      continue;
    }

    if (output.output_type === "execute_result" || output.output_type === "display_data") {
      const data = output.data || {};
      const imgMime = data["image/png"] ? "image/png" : (data["image/jpeg"] ? "image/jpeg" : null);
      if (imgMime) {
        const img = document.createElement("img");
        img.className = "nb-output nb-image";
        img.src = `data:${imgMime};base64,${joinSource(data[imgMime])}`;
        frag.appendChild(img);
      } else if (data["text/plain"]) {
        const pre = document.createElement("pre");
        pre.className = "nb-output";
        pre.innerHTML = esc(joinSource(data["text/plain"]));
        frag.appendChild(pre);
      } else if (data["text/html"]) {
        const pre = document.createElement("pre");
        pre.className = "nb-output nb-html-note";
        pre.innerHTML = esc(joinSource(data["text/html"]));
        frag.appendChild(pre);
      }
      continue;
    }
    // Unknown output types are ignored.
  }
  return frag;
}

// Renders a notebook file's content as a series of cells, with right-side
// inline comments threaded in and "commentable" cells clickable to open the
// composer (reusing the existing inline-comment posting flow).
function buildNotebookElement(file, tab, content) {
  let nb;
  try {
    nb = JSON.parse(content);
  } catch (e) {
    const root = document.createElement("div");
    root.innerHTML = `<div class="binary-note">Could not parse notebook JSON</div>`;
    return root;
  }

  const root = document.createElement("div");
  root.className = "nb-preview";

  // Notebook code cells share one language; read it from notebook metadata,
  // defaulting to python (the most common kernel).
  const nbLang = String(
    (nb.metadata && (
      (nb.metadata.language_info && nb.metadata.language_info.name) ||
      (nb.metadata.kernelspec && nb.metadata.kernelspec.language)
    )) || "python"
  ).toLowerCase();

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
  const cellSpans = mapCellsToRawLines(content, nb);
  const cells = nb.cells || [];

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    let cellEl;

    if (cell.cell_type === "markdown") {
      cellEl = document.createElement("div");
      cellEl.className = "nb-cell nb-md md-preview";
      cellEl.innerHTML = mdParse(joinSource(cell.source), { gfm: true, breaks: false });
    } else if (cell.cell_type === "code") {
      cellEl = document.createElement("div");
      cellEl.className = "nb-cell nb-code";

      const prompt = document.createElement("div");
      prompt.className = "nb-prompt";
      prompt.textContent = `In [${cell.execution_count ?? " "}]:`;
      cellEl.appendChild(prompt);

      const pre = document.createElement("pre");
      pre.className = "nb-source";
      const codeSrc = joinSource(cell.source);
      const hl = highlightToLines(codeSrc, nbLang);
      pre.innerHTML = hl ? `<code class="hljs">${hl.join("\n")}</code>` : `<code>${esc(codeSrc)}</code>`;
      cellEl.appendChild(pre);

      cellEl.appendChild(renderNotebookOutputs(cell.outputs || []));
    } else {
      // Unknown cell types (e.g. raw): render source as plain text.
      cellEl = document.createElement("div");
      cellEl.className = "nb-cell nb-raw";
      const pre = document.createElement("pre");
      pre.className = "nb-source";
      pre.innerHTML = `<code>${esc(joinSource(cell.source))}</code>`;
      cellEl.appendChild(pre);
    }

    let target = null;
    if (cellSpans) {
      const span = cellSpans[i];
      for (let ln = span.startLine; ln <= span.endLine; ln++) {
        if (commentableRight.has(ln)) { target = ln; break; }
      }
    }

    cellEl.classList.add("commentable");
    cellEl.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      if (target != null) {
        openInlineComposer(cellEl, file, { side: "RIGHT", line: target }, tab);
      } else {
        openNotebookCellComposer(cellEl, file, tab, i + 1, cell.cell_type || "raw");
      }
    });

    root.appendChild(cellEl);

    if (cellSpans) {
      const span = cellSpans[i];
      for (let ln = span.startLine; ln <= span.endLine; ln++) {
        if (byLine.right.has(ln) && !placedRight.has(ln)) {
          byLine.right.get(ln).forEach((cm) => root.appendChild(renderInlineThread(cm)));
          placedRight.add(ln);
        }
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

// Loads (and caches per-tab) a notebook file's content and renders it into
// `container`. Mirrors renderPreview's staleness guards and error fallback.
async function renderNotebookPreview(file, tab, container) {
  container.innerHTML = `<div class="preview-loading">Loading preview…</div>`;

  tab.fileContents = tab.fileContents || {};
  if (!tab.fileContents[file.filename]) {
    tab.fileContents[file.filename] = fetchFileContent(tab, file.filename);
  }

  let content;
  try {
    content = await tab.fileContents[file.filename];
  } catch (e) {
    if (!fileIsVisible(tab, file.filename) || getFileViewMode(tab, file) !== "preview") return;
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

  if (!fileIsVisible(tab, file.filename) || getFileViewMode(tab, file) !== "preview") return;
  if (!container.isConnected) return;

  container.innerHTML = "";
  container.appendChild(buildNotebookElement(file, tab, content));

  // Re-apply the #fileMain scroll position stashed by loadComments(), now that
  // the real (tall) content has replaced the "Loading preview…" placeholder.
  if (pendingMainScroll != null) {
    const main = $("fileMain");
    if (main) main.scrollTop = pendingMainScroll;
    pendingMainScroll = null;
  }
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
  const rows = parsePatch(file.patch);
  const lang = hlLanguageFor(file.filename);

  // RIGHT (new file) view = context + added lines, in patch order.
  // LEFT (old file) view  = context + removed lines, in patch order.
  const rightText = rows.filter(r => r.type === "add" || r.type === "context").map(r => r.text).join("\n");
  const leftText  = rows.filter(r => r.type === "del" || r.type === "context").map(r => r.text).join("\n");
  const rightHL = highlightToLines(rightText, lang); // null if lang unknown / hljs missing
  const leftHL  = highlightToLines(leftText, lang);

  let rIdx = 0, lIdx = 0;
  for (const row of rows) {
    if (row.type === "context") {
      if (rightHL) row.html = rightHL[rIdx];
      rIdx++; lIdx++;
    } else if (row.type === "add") {
      if (rightHL) row.html = rightHL[rIdx];
      rIdx++;
    } else if (row.type === "del") {
      if (leftHL) row.html = leftHL[lIdx];
      lIdx++;
    }
    // hunk rows: no html
  }

  for (const row of rows) {
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

  const codeHtml = row.html != null ? row.html : esc(row.text);
  el.innerHTML = `<span class="ln">${row.newLine ?? ""}</span><span class="code">${codeHtml}</span>`;

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

// Opens a composer for a notebook cell that has no overlapping diff line
// (or whose notebook has no patch at all). Posts a top-level conversation
// comment prefixed with a reference to the cell, since GitHub inline review
// comments can only target lines that are part of the diff.
function openNotebookCellComposer(cellEl, file, tab, cellIndex, cellType) {
  // one composer at a time
  document.querySelectorAll(".inline-composer").forEach((n) => n.remove());
  const box = document.createElement("div");
  box.className = "inline-composer";
  box.innerHTML = `
    <textarea placeholder="Comment on ${esc(file.filename)} — cell ${cellIndex} (${esc(cellType)}) — Cmd/Ctrl+Enter to post"></textarea>
    <button class="btn accent" type="button">Post</button>
    <button class="btn ghost" type="button">Cancel</button>
  `;
  const ta = box.querySelector("textarea");
  const [postBtn, cancelBtn] = box.querySelectorAll("button");
  const prefix = `**\`${file.filename}\` — cell ${cellIndex} (${cellType}):**\n\n`;
  const post = () => {
    const text = (ta.value || "").trim();
    if (!text) return;
    postComment(tab, prefix + text, null, box);
  };
  postBtn.addEventListener("click", post);
  cancelBtn.addEventListener("click", () => box.remove());
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") post();
    if (e.key === "Escape") box.remove();
  });
  cellEl.insertAdjacentElement("afterend", box);
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
// Build the canned task prompt that invokes the pr-comment-review skill against
// a specific PR, with a note clarifying what the currently-selected mode does.
function buildCommentReviewPrompt(prRef, mode) {
  const note =
    mode === "fix"
      ? "Mode is `fix` — you may apply edits to address the comments."
      : "Mode is `review` (read-only) — triage the comments and propose fixes, but do not edit files.";
  return (
    `Use the pr-comment-review skill to address the review and discussion ` +
    `comments on PR ${prRef}. ${note}`
  );
}

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
// Maps a filename to a highlight.js language id by extension, or null when the
// type is unknown / not worth highlighting. Used so the diff and preview views
// can highlight per the file's real language instead of relying on autodetect.
function hlLanguageFor(filename) {
  const name = String(filename == null ? "" : filename);
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx === -1) return null;
  const ext = name.slice(dotIdx + 1).toLowerCase();
  const EXT_TO_LANG = {
    py: "python",
    pyw: "python",
    ipynb: "python",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    sql: "sql",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    markdown: "markdown",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    kts: "kotlin",
    php: "php",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    cs: "csharp",
    css: "css",
    scss: "scss",
    less: "less",
    html: "xml",
    htm: "xml",
    xml: "xml",
    toml: "ini",
    ini: "ini",
    cfg: "ini",
    diff: "diff",
    patch: "diff",
    lua: "lua",
    r: "r",
    pl: "perl",
  };
  const langId = EXT_TO_LANG[ext];
  if (!langId) return null;
  if (typeof hljs === "undefined" || !hljs.getLanguage(langId)) return null;
  return langId;
}

// Highlights `text` as `lang` and returns an ARRAY of HTML strings — one entry
// per input line (text.split("\n")). Any <span> still open at a line boundary is
// closed at end-of-line and reopened at the start of the next line, so multi-line
// constructs (block comments, triple-quoted strings) color correctly even though
// each line is rendered in its own DOM row. Returns null when highlighting isn't
// possible (no lang, hljs unavailable, or lang not registered) so callers can
// fall back to esc().
function highlightToLines(text, lang) {
  if (!lang || typeof hljs === "undefined" || !hljs.getLanguage(lang)) return null;

  const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;

  const tokenRe = /(<span[^>]*>)|(<\/span>)|([^<]+)/g;
  const stack = [];
  const lines = [];
  let current = "";
  let match;

  while ((match = tokenRe.exec(html)) !== null) {
    const [, openTag, closeTag, text] = match;
    if (openTag) {
      stack.push(openTag);
      current += openTag;
    } else if (closeTag) {
      stack.pop();
      current += "</span>";
    } else if (text) {
      const segments = text.split("\n");
      for (let i = 0; i < segments.length - 1; i++) {
        current += segments[i];
        current += "</span>".repeat(stack.length);
        lines.push(current);
        current = stack.join("");
      }
      current += segments[segments.length - 1];
    }
  }

  lines.push(current);
  return lines;
}

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
