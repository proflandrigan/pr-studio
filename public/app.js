"use strict";

// ---------- State ----------
const LS_KEY = "pr-studio:state:v1";
const state = {
  tabs: [], // { key, owner, repo, number, title, state, draft, data, comments }
  active: null,
  repoPaths: {}, // key -> local path
  checkCmds: {}, // repoPath -> command override
  showResolved: false, // view toggle: include resolved inline threads in the diff
  done: {}, // { [prKey]: ["inline:<id>", "convo:<id>", ...] } — local triage, persisted
  hideDone: false, // view toggle: hide locally-done comments
  breakdowns: {}, // key -> { chunks, reviewed: number[] }
  pins: {}, // key -> [ { id, file, side, startLine, endLine, code } ]
  conversations: {}, // key -> { sessionId, started, open, turns: [ { role, text } ] }
  consoleHeight: null, // px height of the agent console, persisted from drag-resize
  bootId: null, // last-seen server boot id; a change across loads means npm start re-ran
};

function keyOf(o, r, n) {
  return `${o}/${r}#${n}`;
}

// ---------- Resizable console ----------
const CONSOLE_MIN_H = 120;
function consoleMaxH() {
  return Math.round(window.innerHeight * 0.8);
}
function applyConsoleHeight(h) {
  if (h == null) return;
  const clamped = Math.max(CONSOLE_MIN_H, Math.min(h, consoleMaxH()));
  state.consoleHeight = clamped;
  consoleEl.style.setProperty("--console-height", clamped + "px");
}

// ---------- Pinned context ----------
// Pins live keyed by tab key (owner/repo#number) so they persist across
// reloads alongside the other keyed maps in state. Each pin records the
// file, diff side, line range, and the exact code text so the agent prompt
// can quote it verbatim later.
function pinsFor(key) {
  if (!key) return [];
  if (!state.pins[key]) state.pins[key] = [];
  return state.pins[key];
}

// Conversations live keyed by tab key (owner/repo#number) so each tab can hold
// its own ongoing Claude Code chat (session id + transcript), persisted across
// reloads alongside the other keyed maps in state.
function conversationFor(key) {
  if (!key) return null;
  if (!state.conversations[key]) {
    state.conversations[key] = { sessionId: crypto.randomUUID(), started: false, open: false, turns: [] };
  }
  return state.conversations[key];
}

// Open a PR tab's chat: replace its conversation with a brand-new, OPEN
// session (fresh session id, empty transcript). Used by the "Start Chat"
// button shown while a tab's chat is closed, and reused by "New chat".
function startChat(key) {
  if (!key) return null;
  state.conversations[key] = { sessionId: crypto.randomUUID(), started: false, open: true, turns: [] };
  persist();
  return state.conversations[key];
}

function resetConversation(key) {
  if (!key) return null;
  return startChat(key);
}

function addPin(key, pin) {
  if (!key || !pin) return null;
  const list = pinsFor(key);
  const full = {
    id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    file: pin.file,
    side: pin.side || "RIGHT",
    startLine: pin.startLine,
    endLine: pin.endLine,
    code: pin.code || "",
  };
  list.push(full);
  persist();
  return full;
}

function removePin(key, id) {
  const list = state.pins[key];
  if (!list) return;
  const i = list.findIndex((p) => p.id === id);
  if (i !== -1) {
    list.splice(i, 1);
    persist();
  }
}

function persist() {
  const slim = {
    refs: state.tabs.map((t) => ({ owner: t.owner, repo: t.repo, number: t.number })),
    active: state.active,
    repoPaths: state.repoPaths,
    checkCmds: state.checkCmds,
    showResolved: state.showResolved,
    done: state.done,
    hideDone: state.hideDone,
    breakdowns: state.breakdowns,
    pins: state.pins,
    conversations: state.conversations,
    consoleHeight: state.consoleHeight,
    bootId: state.bootId,
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
const checkCmdEl = $("checkCmd");

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

  // Capture the server's boot id immediately, before any branch that might
  // persist(). On a brand-new install `saved` is null so the restore block
  // below is skipped — if we only set state.bootId in there, the first chat
  // would persist bootId:null and the next plain reload would see a mismatch
  // (null vs the real id) and wrongly wipe the conversation. Seeding it here
  // keeps the first reload a no-op restore.
  state.bootId = (healthInfo && healthInfo.bootId) || null;

  const saved = loadPersisted();
  if (saved) {
    state.repoPaths = saved.repoPaths || {};
    state.checkCmds = saved.checkCmds || {};
    state.breakdowns = saved.breakdowns || {};
    state.pins = saved.pins || {};
    // Decide whether to keep or wipe stored conversations based on the server's
    // boot id (from /api/health). A changed bootId means the server process
    // restarted — `npm start` was re-run — so every prior Claude Code session is
    // gone: drop all conversations and let each PR tab open with a fresh, closed
    // chat. On a plain reload (same bootId) the sessions still live on disk, so
    // restore verbatim, keeping sessionId/started so a thread can resume. If we
    // couldn't reach the server (no bootId), preserve what's stored rather than
    // destroying the user's chats.
    const serverBootId = state.bootId;
    if (!serverBootId || saved.bootId === serverBootId) {
      state.conversations = saved.conversations || {};
    } else {
      state.conversations = {};
    }
    // If the server was unreachable, fall back to the last id we stored so a
    // later successful load can still tell a restart from a plain reload.
    state.bootId = serverBootId || saved.bootId || null;
    state.showResolved = Boolean(saved.showResolved);
    state.done = saved.done || {};
    state.hideDone = Boolean(saved.hideDone);
    state.consoleHeight = saved.consoleHeight || null;
    for (const ref of saved.refs || []) {
      await openPr(`${ref.owner}/${ref.repo}#${ref.number}`, { silent: true });
    }
    if (saved.active && state.tabs.find((t) => t.key === saved.active)) {
      activate(saved.active);
    } else if (state.tabs.length) {
      activate(state.tabs[0].key);
    }
  }

  if (state.consoleHeight) applyConsoleHeight(state.consoleHeight);

  wireEvents();
  refreshCheckCmd();
  renderPins();
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

// Render the active tab's pinned-context chips above the chat input. Each chip
// is a removable reference to a diff selection; the × removes just that pin.
function renderPins() {
  const host = document.getElementById("pinChips");
  if (!host) return;
  const pins = state.active ? pinsFor(state.active) : [];
  const convo = state.active ? conversationFor(state.active) : null;
  if (!convo || !convo.open) {
    host.hidden = true;
    return;
  }
  host.innerHTML = "";
  if (pins.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  for (const pin of pins) {
    const name = String(pin.file || "").split("/").pop();
    const range =
      pin.endLine && pin.endLine !== pin.startLine
        ? `${pin.startLine}–${pin.endLine}`
        : `${pin.startLine}`;
    const chip = document.createElement("span");
    chip.className = "pin-chip";
    chip.title = `${pin.file}:${range}`;
    chip.innerHTML =
      `<span class="pin-chip-label">📌 ${esc(name)}:${esc(range)}</span>` +
      `<button type="button" class="pin-chip-x" aria-label="Remove pin">×</button>`;
    chip.querySelector(".pin-chip-x").addEventListener("click", () => {
      removePin(state.active, pin.id);
      renderPins();
    });
    host.appendChild(chip);
  }
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

  $("agentInput").addEventListener("input", () => {
    setAgentStatus("");
    autoGrowInput();
  });
  $("agentInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("agentForm").requestSubmit();
    }
  });

  $("clearConsole").addEventListener("click", () => {
    consoleOut.textContent = "";
  });

  // New chat: reset the active tab's conversation (fresh session id, empty
  // transcript) so the next message starts a brand-new Claude Code session.
  $("newChat").addEventListener("click", () => {
    if (state.active) resetConversation(state.active);
    renderTranscript(state.active);
  });

  // Start Chat: open this tab's closed chat with a fresh session, then reveal
  // the transcript + input and focus it.
  $("startChatBtn").addEventListener("click", () => {
    if (!state.active) return;
    startChat(state.active);
    consoleEl.classList.remove("collapsed");
    renderTranscript(state.active);
    renderPins(); // surface any pins that were hidden while the chat was closed
    $("agentInput").focus();
  });

  // Drag-resize the console via its top-edge handle
  const resizeHandle = $("consoleResize");
  if (resizeHandle) {
    resizeHandle.addEventListener("pointerdown", (e) => {
      if (consoleEl.classList.contains("collapsed")) return;
      e.preventDefault();
      const startY = e.clientY;
      const startH = consoleEl.getBoundingClientRect().height;
      consoleEl.classList.add("resizing");
      resizeHandle.setPointerCapture(e.pointerId);
      const onMove = (ev) => {
        // Dragging UP (smaller clientY) grows the console.
        applyConsoleHeight(startH + (startY - ev.clientY));
      };
      const onUp = () => {
        resizeHandle.releasePointerCapture(e.pointerId);
        consoleEl.classList.remove("resizing");
        resizeHandle.removeEventListener("pointermove", onMove);
        resizeHandle.removeEventListener("pointerup", onUp);
        persist();
      };
      resizeHandle.addEventListener("pointermove", onMove);
      resizeHandle.addEventListener("pointerup", onUp);
    });
  }

  // Collapse console by clicking its label area
  $("console").querySelector(".console-head").addEventListener("click", (e) => {
    if (e.target.closest(".console-controls")) return;
    consoleEl.classList.toggle("collapsed");
  });

  $("agentStop").addEventListener("click", () => {
    if (agentAbort) agentAbort.abort();
  });

  $("addrCommentsBtn").addEventListener("click", () => {
    const tab = state.tabs.find((t) => t.key === state.active);
    if (!tab) {
      consoleEl.classList.remove("collapsed");
      append("\n⚠ Open a PR tab first — there's no active PR to address comments for.\n", "err");
      return;
    }
    if (agentActive) return; // a turn is already streaming; don't double-fire
    $("agentInput").value = buildCommentReviewPrompt(tab.key);
    runAgent();
  });

  repoPathEl.addEventListener("change", () => {
    if (state.active) {
      state.repoPaths[state.active] = repoPathEl.value.trim();
      persist();
    }
    refreshCheckCmd();
  });

  checkCmdEl.addEventListener("change", () => {
    const repoPath = repoPathEl.value.trim();
    if (repoPath) {
      state.checkCmds[repoPath] = checkCmdEl.value.trim();
      persist();
    }
  });

  $("runChecks").addEventListener("click", () => runChecksFlow());

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
  // Filter controls live inside the panel, which is rebuilt on each open;
  // delegate on the panel element (which persists) so one listener survives.
  myPrsPanel.addEventListener("input", (e) => {
    if (e.target.closest(".my-prs-filters")) renderFilteredMyPrs();
  });
  myPrsPanel.addEventListener("change", (e) => {
    if (e.target.closest(".my-prs-filters")) renderFilteredMyPrs();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".pr-title-wrap")) {
      const m = $("prTitleMenu");
      if (m) m.hidden = true;
    }
  });

  // Pin-to-chat: surface the button on a diff text selection.
  document.addEventListener("mouseup", () => setTimeout(handlePinSelection, 0));
  document.addEventListener("mousedown", (e) => {
    if (pinButtonEl && !e.target.closest(".pin-to-chat")) removePinButton();
  });
  document.addEventListener("scroll", removePinButton, true);
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
// Full fetched My-PRs set; filter controls render a client-side subset of this
// without refetching. Reset each time the panel loads.
let allMyPrs = [];

// Static filter-bar markup for the My PRs panel. Controls are wired in
// Task 04 (applyPrFilters); here they're rendered inert. The repo <select>
// starts with only the "All repos" option — it's populated from the fetched
// set when the list loads.
function prFilterBarHtml() {
  return `
    <div class="my-prs-filters" id="myPrsFilters">
      <input type="text" id="prFilterText" class="my-prs-filter-text"
             placeholder="Filter by title…" autocomplete="off">
      <div class="my-prs-filter-selects">
        <select id="prFilterRepo" class="my-prs-filter-select">
          <option value="">All repos</option>
        </select>
        <select id="prFilterRel" class="my-prs-filter-select">
          <option value="">All</option>
          <option value="authored">Authored</option>
          <option value="review-requested">Review requested</option>
          <option value="involved">Involved</option>
        </select>
        <select id="prFilterStatus" class="my-prs-filter-select">
          <option value="">Any status</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="merged">Merged</option>
        </select>
        <select id="prFilterDraft" class="my-prs-filter-select">
          <option value="">Draft &amp; ready</option>
          <option value="ready">Ready</option>
          <option value="draft">Draft</option>
        </select>
      </div>
    </div>`;
}

// Fill the repo <select> with the distinct owner/repo values present in the
// fetched set, alphabetised. Preserves the "All repos" default at top.
function populateRepoFilter(prs) {
  const sel = $("prFilterRepo");
  if (!sel) return;
  const repos = [...new Set(prs.map((pr) => `${pr.owner}/${pr.repo}`))].sort();
  sel.innerHTML =
    `<option value="">All repos</option>` +
    repos.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
}

// Read the current filter control values.
function readPrFilters() {
  return {
    text: ($("prFilterText")?.value || "").trim().toLowerCase(),
    repo: $("prFilterRepo")?.value || "",
    rel: $("prFilterRel")?.value || "",
    status: $("prFilterStatus")?.value || "",
    draft: $("prFilterDraft")?.value || "",
  };
}

// AND across every active filter; empty string = "no constraint".
function applyPrFilters(prs, f) {
  return prs.filter((pr) => {
    if (f.repo && `${pr.owner}/${pr.repo}` !== f.repo) return false;
    if (f.rel && pr.relationship !== f.rel) return false;
    if (f.status && pr.status !== f.status) return false;
    if (f.draft === "draft" && !pr.draft) return false;
    if (f.draft === "ready" && pr.draft) return false;
    if (f.text && !String(pr.title).toLowerCase().includes(f.text)) return false;
    return true;
  });
}

// Re-render the list from the in-memory set through the current filters.
function renderFilteredMyPrs() {
  renderMyPrs(applyPrFilters(allMyPrs, readPrFilters()));
}

// Fetches the authenticated user's open PRs and renders them into the dropdown
// panel. Selecting one reuses openPr(). Best-effort: failures render inline.
async function loadMyPrs() {
  const panel = $("myPrsPanel");
  // Panel shell: persistent filter bar + a list container the list/loading/
  // error states render into (so the filter bar never gets wiped).
  panel.innerHTML = `${prFilterBarHtml()}<div class="my-prs-list" id="myPrsList"></div>`;
  const list = $("myPrsList");
  list.innerHTML = `<div class="my-prs-state">Loading…</div>`;
  try {
    const res = await fetch("/api/my-prs");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Failed to load your PRs");
    allMyPrs = body.prs || [];
    populateRepoFilter(allMyPrs);
    renderFilteredMyPrs();
  } catch (e) {
    list.innerHTML = `<div class="my-prs-state error">${esc(e.message)}</div>`;
  }
}

// Short human label for a relationship tag.
function relLabel(rel) {
  if (rel === "authored") return "authored";
  if (rel === "review-requested") return "review";
  return "involved";
}

function renderMyPrs(prs) {
  const list = $("myPrsList");
  if (!list) return;
  if (!prs.length) {
    list.innerHTML = `<div class="my-prs-state">No PRs match.</div>`;
    return;
  }
  list.innerHTML = prs
    .map(
      (pr) => `
      <button type="button" class="my-pr-item" data-ref="${esc(pr.owner)}/${esc(pr.repo)}#${pr.number}">
        <span class="my-pr-item-top">
          <span class="my-pr-repo">${esc(pr.owner)}/${esc(pr.repo)}#${pr.number}</span>
          <span class="my-pr-badge rel-${esc(pr.relationship)}">${esc(relLabel(pr.relationship))}</span>
          <span class="my-pr-badge status-${esc(pr.status)}">${esc(pr.status)}</span>
          ${pr.draft ? `<span class="my-pr-badge my-pr-draft">draft</span>` : ""}
        </span>
        <span class="my-pr-title">${esc(pr.title)}</span>
      </button>`
    )
    .join("");
  list.querySelectorAll(".my-pr-item").forEach((btn) => {
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
  renderPins();
  persist();
}

function activate(key) {
  state.active = key;
  const tab = state.tabs.find((t) => t.key === key);
  if (tab) repoPathEl.value = state.repoPaths[key] || repoPathEl.value || "";
  renderTabs();
  renderReview();
  renderPins();
  renderTranscript(key);
  persist();
  refreshCheckCmd();
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
      <div class="pr-title-wrap">
        <h1 class="pr-title"><button type="button" class="pr-title-btn" id="prTitleBtn">${esc(pr.title)}<span class="pr-title-caret">▾</span></button></h1>
        <div class="pr-title-menu" id="prTitleMenu" hidden>
          <a class="pr-title-menu-item" id="prTitleOpen" href="${pr.url}" target="_blank" rel="noopener">Open in GitHub ↗</a>
          <button type="button" class="pr-title-menu-item" id="prTitleCopy" data-url="${esc(pr.url)}">Copy URL</button>
        </div>
      </div>
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

  wireTitleMenu();

  // Which sidebar entry is selected is transient UI state kept on the in-memory
  // tab so it survives re-renders (e.g. after posting a comment). Default: the
  // PR description/overview, like GitHub's Conversation tab.
  if (!tab.selected) tab.selected = OVERVIEW;
  if (!tab.sidebarView) tab.sidebarView = "files";
  if (tab.activePane !== "secondary") tab.activePane = "primary";

  renderSidebar(tab);
  renderMain(tab);
}

// Wires the clickable PR-title dropdown (Open in GitHub / Copy URL). Called on
// every renderReview because reviewEl.innerHTML is rebuilt each time.
function wireTitleMenu() {
  const btn = $("prTitleBtn");
  const menu = $("prTitleMenu");
  if (!btn || !menu) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });

  // "Open in GitHub" is a plain <a> — let it navigate, just close the menu.
  $("prTitleOpen")?.addEventListener("click", () => {
    menu.hidden = true;
  });

  const copyBtn = $("prTitleCopy");
  copyBtn?.addEventListener("click", async () => {
    const url = copyBtn.dataset.url;
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.textContent = "Copy URL";
        menu.hidden = true;
      }, 1500);
    } catch {
      copyBtn.textContent = "Copy failed";
      setTimeout(() => {
        copyBtn.textContent = "Copy URL";
      }, 1500);
    }
  });
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

  const hideDoneToggle = $("hideDoneToggle");
  if (hideDoneToggle) {
    hideDoneToggle.addEventListener("change", () => {
      state.hideDone = hideDoneToggle.checked;
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
        byLine.right.get(ln).forEach((cm) => root.appendChild(renderInlineThread(cm, { tab })));
        placedRight.add(ln);
      }
    }
  }

  const orphanedRight = [...byLine.right.entries()].filter(([line]) => !placedRight.has(line));
  for (const [, arr] of orphanedRight) {
    arr.forEach((cm) => root.appendChild(renderInlineThread(cm, { orphaned: true, tab })));
  }
  // LEFT-side comments target removed lines, which have no home in a preview
  // of the current file content — show them as orphaned, like outdated threads.
  for (const arr of byLine.left.values()) {
    arr.forEach((cm) => root.appendChild(renderInlineThread(cm, { orphaned: true, tab })));
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
          byLine.right.get(ln).forEach((cm) => root.appendChild(renderInlineThread(cm, { tab })));
          placedRight.add(ln);
        }
      }
    }
  }

  const orphanedRight = [...byLine.right.entries()].filter(([line]) => !placedRight.has(line));
  for (const [, arr] of orphanedRight) {
    arr.forEach((cm) => root.appendChild(renderInlineThread(cm, { orphaned: true, tab })));
  }
  // LEFT-side comments target removed lines, which have no home in a preview
  // of the current file content — show them as orphaned, like outdated threads.
  for (const arr of byLine.left.values()) {
    arr.forEach((cm) => root.appendChild(renderInlineThread(cm, { orphaned: true, tab })));
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
        byLine.left.get(row.oldLine).forEach((cm) => diff.appendChild(renderInlineThread(cm, { tab })));
        placedLeft.add(row.oldLine);
      }
    } else if (row.newLine && byLine.right.has(row.newLine)) {
      byLine.right.get(row.newLine).forEach((cm) => diff.appendChild(renderInlineThread(cm, { tab })));
      placedRight.add(row.newLine);
    }
  }
  // Comments whose target line isn't in the visible patch (outdated or out of
  // the shown hunks) still need a home — show them at the end of the file.
  const orphanedRight = [...byLine.right.entries()].filter(([line]) => !placedRight.has(line));
  const orphanedLeft = [...byLine.left.entries()].filter(([line]) => !placedLeft.has(line));
  for (const [, arr] of [...orphanedRight, ...orphanedLeft]) {
    arr.forEach((cm) => diff.appendChild(renderInlineThread(cm, { orphaned: true, tab })));
  }
  return diff;
}

// A small toolbar above the diff summarising resolved/outdated inline threads
// and a toggle to reveal resolved ones (hidden by default, like GitHub).
function renderReviewControls(tab) {
  const inline = (tab.comments && tab.comments.inline) || [];
  const resolved = inline.filter((c) => c.resolved).length;
  const outdated = inline.filter((c) => c.outdated).length;
  const done = doneCount(tab);
  if (!resolved && !outdated && !done) return "";

  const parts = [];
  if (resolved) {
    parts.push(`
      <label class="review-toggle">
        <input type="checkbox" id="showResolvedToggle" ${state.showResolved ? "checked" : ""} />
        Show resolved (${resolved})
      </label>`);
  }
  if (done) {
    parts.push(`
      <label class="review-toggle">
        <input type="checkbox" id="hideDoneToggle" ${state.hideDone ? "checked" : ""} />
        Hide done (${done})
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
  let list = state.showResolved ? inline : inline.filter((c) => !c.resolved);
  if (state.hideDone) list = list.filter((c) => !isDone(tab, "inline", c.id));
  return list;
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

// ---------- Local "done" triage (localStorage only, never posted to GitHub) ----------
function doneKey(type, id) {
  return `${type}:${id}`;
}
function isDone(tab, type, id) {
  const list = state.done[tab.key];
  return Array.isArray(list) && list.includes(doneKey(type, id));
}
// Set/clear done for one comment. Returns the new boolean state. Persists.
function setDone(tab, type, id, value) {
  const key = doneKey(type, id);
  const list = state.done[tab.key] ? state.done[tab.key].slice() : [];
  const at = list.indexOf(key);
  if (value && at === -1) list.push(key);
  if (!value && at !== -1) list.splice(at, 1);
  state.done[tab.key] = list;
  persist();
  return Boolean(value);
}
function toggleDone(tab, type, id) {
  return setDone(tab, type, id, !isDone(tab, type, id));
}
// Count of done comments currently present in this tab's loaded comments.
function doneCount(tab) {
  const c = tab.comments;
  if (!c) return 0;
  let n = 0;
  for (const cm of c.inline || []) if (isDone(tab, "inline", cm.id)) n++;
  for (const cm of c.conversation || []) if (isDone(tab, "convo", cm.id)) n++;
  return n;
}

function renderInlineThread(cm, opts = {}) {
  const tab = opts.tab;
  const el = document.createElement("div");
  const classes = ["inline-comment"];
  if (opts.orphaned) classes.push("orphaned");
  if (cm.outdated) classes.push("outdated");
  if (cm.resolved) classes.push("resolved");
  if (tab && isDone(tab, "inline", cm.id)) classes.push("done");
  el.className = classes.join(" ");

  const badges =
    (cm.outdated ? `<span class="cm-badge outdated">outdated</span>` : "") +
    (cm.resolved ? `<span class="cm-badge resolved">resolved</span>` : "");
  // For orphaned threads (anchor not in the shown diff) note where it lived.
  const where = opts.orphaned
    ? `<small>${esc(cm.path)}:${cm.originalLine ?? cm.line ?? "?"}</small>`
    : "";
  const isCmDone = tab ? isDone(tab, "inline", cm.id) : false;
  const doneBtn =
    `<button type="button" class="cm-action cm-done${isCmDone ? " on" : ""}" data-done>` +
    `${isCmDone ? "✓ Done" : "Mark done"}</button>`;
  // Resolve toggles thread state on GitHub; needs a token and a thread id.
  const canResolve = tab && cm.threadId && healthInfo && healthInfo.githubToken;
  const resolveBtn = canResolve
    ? `<button type="button" class="cm-action cm-resolve${cm.resolved ? " on" : ""}" data-resolve>` +
      `${cm.resolved ? "Unresolve" : "Resolve"}</button>`
    : "";
  // Reply posts into this thread via the replies endpoint; needs a token.
  const canReply = tab && healthInfo && healthInfo.githubToken;
  const replyBtn = canReply
    ? `<button type="button" class="cm-action cm-reply" data-reply>Reply</button>`
    : "";
  el.innerHTML = `
    <div class="comment-head">@${esc(cm.author)}${badges}${where}<span class="cm-actions">${resolveBtn}${replyBtn}${doneBtn}</span></div>
    <div class="comment-body">${esc(cm.body)}</div>`;

  if (tab) {
    const btn = el.querySelector("[data-done]");
    if (btn) btn.addEventListener("click", (e) => {
      e.stopPropagation(); // diff rows are click-to-comment; don't trigger that
      toggleDone(tab, "inline", cm.id);
      renderReview();
    });
    const rbtn = el.querySelector("[data-resolve]");
    if (rbtn) rbtn.addEventListener("click", (e) => {
      e.stopPropagation();
      resolveThread(tab, cm);
    });
    const replybtn = el.querySelector("[data-reply]");
    if (replybtn) replybtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openReplyComposer(el, tab, cm);
    });
  }
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
    el.dataset.file = file.filename;
    el.dataset.side = target.side;
    el.dataset.line = String(target.line);
    el.addEventListener("click", () => openInlineComposer(el, file, target, tab));
  }
  return el;
}

// ---------- Pin-to-chat selection ----------
let pinButtonEl = null;

function removePinButton() {
  if (pinButtonEl) {
    pinButtonEl.remove();
    pinButtonEl = null;
  }
}

// Map the current text selection to a pin payload, or null if the selection
// isn't a usable range inside a single file's diff.
function selectionToPin() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  // Anchor the pin to the file containing the selection start.
  let node = sel.anchorNode;
  const startRow =
    node && (node.nodeType === 1 ? node : node.parentElement)
      ? (node.nodeType === 1 ? node : node.parentElement).closest(".diff-row[data-line]")
      : null;
  if (!startRow) return null;

  const file = startRow.dataset.file;
  const side = startRow.dataset.side;
  const container = startRow.closest(".diff");
  if (!container) return null;

  // All line-bearing rows of THIS file that the selection touches.
  const rows = [...container.querySelectorAll(".diff-row[data-line]")].filter(
    (r) => r.dataset.file === file && sel.containsNode(r, true)
  );
  if (rows.length === 0) return null;

  const codeRows = rows.map((r) => {
    const c = r.querySelector(".code");
    return c ? c.textContent : "";
  });
  // Line range uses rows on the same diff side as the start row.
  const lines = rows
    .filter((r) => r.dataset.side === side)
    .map((r) => Number(r.dataset.line))
    .filter((n) => Number.isFinite(n));
  if (lines.length === 0) return null;

  return {
    file,
    side,
    startLine: Math.min(...lines),
    endLine: Math.max(...lines),
    code: codeRows.join("\n"),
  };
}

function handlePinSelection() {
  const pin = selectionToPin();
  if (!pin) {
    removePinButton();
    return;
  }
  const sel = window.getSelection();
  const rect = sel.getRangeAt(0).getBoundingClientRect();

  removePinButton();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pin-to-chat";
  btn.textContent = "📌 Pin to chat";
  // position:fixed → viewport coords from getBoundingClientRect.
  btn.style.top = `${Math.max(4, rect.top - 34)}px`;
  btn.style.left = `${Math.max(4, rect.left)}px`;
  // Prevent the mousedown cleanup (below) from killing our own button.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.active) addPin(state.active, pin);
    window.getSelection().removeAllRanges();
    removePinButton();
    if (typeof renderPins === "function") renderPins();
  });
  document.body.appendChild(btn);
  pinButtonEl = btn;
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

// Opens a composer beneath an inline thread to post a threaded reply. Routes
// through postComment with `replyTo` (the parent comment id), which the server
// sends to GitHub's review-comment replies endpoint.
function openReplyComposer(threadEl, tab, cm) {
  // one composer at a time
  document.querySelectorAll(".inline-composer").forEach((n) => n.remove());
  const box = document.createElement("div");
  box.className = "inline-composer";
  box.innerHTML = `
    <textarea placeholder="Reply to @${esc(cm.author)} — Cmd/Ctrl+Enter to post"></textarea>
    <button class="btn accent" type="button">Reply</button>
    <button class="btn ghost" type="button">Cancel</button>
  `;
  const ta = box.querySelector("textarea");
  const [postBtn, cancelBtn] = box.querySelectorAll("button");
  let posting = false; // guard against double-submit (button stays clickable during the await)
  const post = async () => {
    if (posting) return;
    posting = true;
    postBtn.disabled = true;
    try {
      await postComment(tab, ta.value, { replyTo: cm.id }, box);
    } finally {
      posting = false;
      postBtn.disabled = false; // box is removed on success; matters only on failure
    }
  };
  postBtn.addEventListener("click", post);
  cancelBtn.addEventListener("click", () => box.remove());
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") post();
    if (e.key === "Escape") box.remove();
  });
  threadEl.insertAdjacentElement("afterend", box);
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
    let all = [...(c.conversation || [])].sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );
    if (state.hideDone) all = all.filter((cm) => !isDone(tab, "convo", cm.id));

    if (!all.length) {
      html += `<div class="notice info">No conversation comments yet.</div>`;
    } else {
      for (const cm of all) {
        const d = isDone(tab, "convo", cm.id);
        html += `
          <div class="comment${d ? " done" : ""}">
            <div class="comment-head">@${esc(cm.author)}<span class="cm-actions"><button type="button" class="cm-action cm-done${d ? " on" : ""}" data-done-convo="${cm.id}">${d ? "✓ Done" : "Mark done"}</button></span></div>
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

  el.querySelectorAll("[data-done-convo]").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleDone(tab, "convo", Number(btn.dataset.doneConvo));
      renderConversation(tab);
      renderSidebar(tab); // refresh the "Hide done (N)" count in the review controls
    });
  });

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
  if (inline && inline.replyTo) {
    payload.replyTo = inline.replyTo;
  } else if (inline) {
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

// Toggle a review thread's resolution on GitHub. On a successful *resolve*, also
// mark its comments locally done (resolve implies done; unresolve does not undo
// done). Reloads comments afterward so the resolved state reflects GitHub.
async function resolveThread(tab, cm) {
  if (!cm.threadId) return;
  try {
    const r = await fetch("/api/pr/thread/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: cm.threadId, resolved: !cm.resolved }),
    });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || "Failed to update thread");
    if (res.resolved) {
      // Auto-mark every loaded comment in this thread as done.
      for (const c of (tab.comments && tab.comments.inline) || []) {
        if (c.threadId === cm.threadId) setDone(tab, "inline", c.id, true);
      }
    }
    loadComments(tab.key);
  } catch (e) {
    flashError("Resolve failed: " + e.message);
  }
}

// ---------- Agent ----------
// Build the task prompt that drives the pr-comment-review skill against a
// specific PR in ORCHESTRATED mode (triage → one plan approval → implement
// items one at a time). The agent always has edit permissions, so the prompt
// assumes edits are allowed.
function buildCommentReviewPrompt(prRef) {
  return (
    `Use the pr-comment-review skill in ORCHESTRATED mode to address the review ` +
    `and discussion comments on PR ${prRef}. Skip the Phase 0 mode question — go ` +
    `straight to orchestrated: triage every thread into a categorized fix plan, ` +
    `present the plan and wait for my approval, then implement the actionable ` +
    `items one at a time, reading the real code first and QA-ing each change. ` +
    `You may apply edits.`
  );
}

let agentActive = false;
let agentAbort = null; // AbortController for the in-flight agent turn
// In-progress run output (agent or checks) for the tab keyed by `key`. The
// console is one global element shared by every tab, so a run that keeps
// streaming after the user switches tabs must NOT paint into another tab's
// view, yet switching back to its own tab should re-show the progress so far.
// `pieces` holds {text, cls} fragments; renderTranscript replays them for the
// matching tab. Committed to convo.turns when the run finishes, then cleared.
let liveRun = null;

// Stream one fragment of a run: buffer it (so a tab switch-back can replay it)
// and paint it into the live element only while this run's tab is on screen.
function emit(key, text, cls) {
  if (liveRun && liveRun.key === key) liveRun.pieces.push({ text, cls });
  if (state.active !== key || !liveRun || !liveRun.el) return;
  if (liveRun.role === "agent") {
    liveRun.elText = (liveRun.elText || "") + text;
    liveRun.el.textContent = liveRun.elText; // raw while streaming
    scrollConsole();
  } else {
    appendTermLine(liveRun.el, text, cls);
  }
}

// Populate the checks command field for the current repo path: a saved
// per-repo override wins; otherwise auto-detect from the backend.
async function refreshCheckCmd() {
  const repoPath = repoPathEl.value.trim();
  if (!repoPath) {
    checkCmdEl.value = "";
    return;
  }
  if (state.checkCmds[repoPath] != null) {
    checkCmdEl.value = state.checkCmds[repoPath];
    return;
  }
  try {
    const d = await fetch(
      `/api/checks/detect?repoPath=${encodeURIComponent(repoPath)}`
    ).then((r) => r.json());
    // Don't clobber something the user typed while the request was in flight.
    if (checkCmdEl.value.trim()) return;
    if (d && d.command) checkCmdEl.value = d.command;
  } catch {
    /* detection is best-effort */
  }
}

let checksActive = false;
// Runs the resolved check command, streaming output into the console and
// finishing with a PASS/FAIL banner.
async function runChecksFlow() {
  if (checksActive || agentActive) return;
  const repoPath = repoPathEl.value.trim();
  let command = checkCmdEl.value.trim();
  if (!command && state.active && state.checkCmds[repoPath] != null) {
    command = state.checkCmds[repoPath];
  }
  if (!repoPath) {
    consoleEl.classList.remove("collapsed");
    append("\n⚠ Set a local repo path before running checks.\n", "err");
    return;
  }
  if (!command) {
    consoleEl.classList.remove("collapsed");
    append("\n⚠ No check command — type one (e.g. `npm test`) in the field next to the repo path.\n", "err");
    return;
  }

  consoleEl.classList.remove("collapsed");
  // Checks share the global console with the per-tab agent chat, so route their
  // output through liveRun/emit too: only paint to the active tab, and commit
  // the result to that tab's transcript so it survives switches and reloads.
  const key = state.active;
  // Running checks expands the console so its output is visible, but does NOT
  // start an agent session (started stays false, no /api/agent call). If the
  // tab's chat is still closed, open it and sync the chrome before we stream.
  const checksConvo = key ? conversationFor(key) : null;
  if (checksConvo && !checksConvo.open) {
    checksConvo.open = true;
    persist();
    renderTranscript(key);
  }
  liveRun = { key, role: "out", pieces: [], el: null };
  if (state.active === key) liveRun.el = appendTermBlock();
  const header = `\n› checks: ${command}\n`;
  emit(key, header, "sys");
  checksActive = true;
  const btn = $("runChecks");
  if (btn) btn.disabled = true;

  let out = "";
  let errMsg = "";
  try {
    const res = await fetch("/api/checks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, repoPath }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      out += chunk;
      emit(key, chunk);
    }
  } catch (e) {
    errMsg = `\n⚠ ${e.message}\n`;
    emit(key, errMsg, "err");
  } finally {
    checksActive = false;
    if (btn) btn.disabled = false;
    const m = out.match(/\[exit (\d+)\]/);
    const passed = m && m[1] === "0";
    const footer = passed ? "\n✓ Checks passed\n" : "\n✗ Checks failed\n";
    emit(key, footer, passed ? "exit-ok" : "exit-bad");
    // Commit the run to the tab's transcript (header + body + result) so it
    // persists like the agent's turns, then clear the in-progress buffer.
    const convo = key ? conversationFor(key) : null;
    if (convo) {
      convo.turns.push({ role: "out", text: header, cls: "sys" });
      convo.turns.push({ role: "out", text: out + errMsg });
      convo.turns.push({ role: "out", text: footer, cls: passed ? "exit-ok" : "exit-bad" });
      persist();
    }
    liveRun = null;
  }
}

// Build a "Current PR" preamble identifying the PR the user has open, so the
// agent can pull it up itself (e.g. `gh pr view owner/repo#123`) even when no
// local checkout is set. Identity only — title + ref + URL; the agent fetches
// any detail it needs. Returns "" when no tab is active. Prepended to the FIRST
// turn of a conversation only (later turns resume a session that already has
// this context — see runAgent()).
function buildPrContext() {
  const tab = state.active ? state.tabs.find((t) => t.key === state.active) : null;
  if (!tab) return "";
  const ref = `${tab.owner}/${tab.repo}#${tab.number}`;
  const url = tab.data && tab.data.url ? tab.data.url : "";
  return (
    "[Current PR — the user has this PR open.]\n" +
    `${ref}  "${tab.title}"\n` +
    (url ? `${url}\n` : "") +
    `Use \`gh pr view ${ref}\` for details.\n` +
    "[End current PR]\n\n"
  );
}

// Build a "Pinned context" preamble from the active tab's pins so the agent
// knows exactly which lines the user is pointing at, quoting the code verbatim.
// Returns "" when there are no pins.
function buildPinnedContext() {
  const pins = state.active ? pinsFor(state.active) : [];
  if (pins.length === 0) return "";
  const blocks = pins.map((p) => {
    const range =
      p.endLine && p.endLine !== p.startLine
        ? `lines ${p.startLine}-${p.endLine}`
        : `line ${p.startLine}`;
    return `File: ${p.file}  (${range})\n\`\`\`\n${p.code}\n\`\`\``;
  });
  return (
    "[Pinned context — the user is pointing at these specific locations in the diff. " +
    "When the request says \"here\"/\"this\", it refers to them.]\n" +
    blocks.join("\n\n") +
    "\n\n[End pinned context]\n\n"
  );
}

// UI-only "it's your turn" hint shown after an agent turn ends. Not persisted,
// never part of the transcript. "" clears it.
function setAgentStatus(text) {
  const el = $("agentStatus");
  if (el) el.textContent = text || "";
}

// Locks the input + shows the pulsing "Claude is working…" indicator while an
// agent turn is streaming.
// Grow the textarea to fit its content, capped by CSS max-height.
function autoGrowInput() {
  const el = $("agentInput");
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

function setAgentBusy(busy) {
  const input = $("agentInput");
  const indicator = $("workingIndicator");
  if (input) input.disabled = busy;
  if (indicator) indicator.hidden = !busy;
}

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

  // Per-tab conversation: continue the existing thread if one is already
  // started, otherwise this turn opens a new Claude Code session. `sessionId`
  // is the same UUID for the life of the thread; `resume` flips to true once a
  // turn has completed (the session then exists on disk and can be resumed).
  const key = state.active;
  const convo = key ? conversationFor(key) : null;
  const sessionId = convo ? convo.sessionId : undefined;
  const resume = convo ? convo.started : false;

  // PR identity is injected only on the first turn — later turns resume a
  // Claude Code session that already carries it. Pinned context stays per-turn
  // because the user's pins change message to message.
  const fullPrompt =
    (resume ? "" : buildPrContext()) + buildPinnedContext() + prompt;

  // Record + echo the user's turn — store what they actually typed, not the
  // pinned-context plumbing that gets prepended for the agent.
  if (convo) {
    convo.turns.push({ role: "user", text: prompt });
    persist();
  }
  // The user echo is already a stored turn, so paint it directly (only while
  // its tab is on screen) rather than buffering it on liveRun.
  liveRun = { key, role: "agent", pieces: [], el: null, elText: "" };
  if (state.active === key) {
    appendUserBubble(prompt);
    liveRun.el = appendAgentBubble();
  }
  input.value = "";
  input.style.height = "auto";
  agentActive = true;
  $("agentRun").disabled = true;
  setAgentBusy(true);
  setAgentStatus("");
  agentAbort = new AbortController();
  $("agentRun").hidden = true;
  $("agentStop").hidden = false;

  let agentText = "";
  try {
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: fullPrompt, repoPath, sessionId, resume }),
      signal: agentAbort.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      agentText += chunk;
      emit(key, chunk);
    }
    // The HTTP turn finished, so the session now exists on disk; the next
    // message in this tab can resume it instead of starting fresh.
    if (convo) convo.started = true;
  } catch (e) {
    if (e.name === "AbortError") {
      // Stop was clicked. The request was dispatched and the child launched, so
      // the session now exists on disk — mark it started so the next message
      // resumes it. Reusing --session-id against an existing session would error
      // with no self-heal; --resume against a vanished one falls back cleanly.
      if (convo) convo.started = true;
    } else {
      const msg = `\n⚠ ${e.message}\n`;
      agentText += msg;
      emit(key, msg, "err");
    }
  } finally {
    // Persist the agent's reply as one transcript turn so it survives reloads
    // and tab switches, then clear the in-progress buffer. Skip an empty reply
    // (e.g. Stop clicked before any text streamed) so no blank bubble lingers.
    if (convo && agentText) {
      convo.turns.push({ role: "agent", text: agentText });
      persist();
    }
    if (state.active === key && liveRun && liveRun.el) {
      if (agentText) finalizeAgentBubble(liveRun.el, agentText);
      else liveRun.el.closest(".message")?.remove(); // drop the empty bubble
    }
    liveRun = null;
    agentActive = false;
    $("agentRun").disabled = false;
    $("agentRun").hidden = false;
    $("agentStop").hidden = true;
    agentAbort = null;
    setAgentBusy(false);
    // Turn finished — make it legible that the ball is in the user's court.
    // Only when this run's tab is on screen (don't hijack focus on a bg tab).
    if (state.active === key) {
      setAgentStatus("awaiting your reply");
      $("agentInput").focus();
    }
    // a finished agent run may have changed files — nothing to refetch from GitHub,
    // but remind the user their local checkout moved.
  }
}

// Rebuild the console from the given tab's stored conversation, then replay any
// in-progress run for that tab. Called when a tab is activated so each tab shows
// its own thread — including a run still streaming after a tab switch.
function renderTranscript(key) {
  const convo = key ? conversationFor(key) : null;
  const open = !!(convo && convo.open);

  // Toggle closed vs open chrome. Closed: show the Start Chat placeholder and
  // hide the transcript + input. Open: show transcript + input, hide placeholder.
  const startEl = $("chatStart");
  const startBtn = $("startChatBtn");
  const formEl = $("agentForm");
  if (startEl) startEl.hidden = open;
  if (startBtn) startBtn.disabled = !key; // nothing to start without an active PR tab
  if (formEl) formEl.hidden = !open;
  consoleOut.hidden = !open;

  if (!open) {
    // Closed: no transcript, no pins, no status chrome.
    const pins = $("pinChips");
    if (pins) pins.hidden = true;
    consoleOut.textContent = "";
    setAgentStatus("");
    return;
  }

  consoleOut.textContent = "";
  setAgentStatus("");
  if (convo) {
    let termPre = null; // current open terminal block for consecutive out turns
    for (const turn of convo.turns) {
      if (turn.role === "out") {
        if (!termPre) termPre = appendTermBlock();
        appendTermLine(termPre, turn.text, turn.cls);
        continue;
      }
      termPre = null;
      if (turn.role === "user") appendUserBubble(turn.text);
      else finalizeAgentBubble(appendAgentBubble(), turn.text); // agent: markdown
    }
  }
  // Replay an in-progress run for this tab and reconnect the live element.
  if (liveRun && liveRun.key === key) {
    if (liveRun.role === "agent") {
      const bubble = appendAgentBubble();
      liveRun.el = bubble;
      liveRun.elText = liveRun.pieces.map((p) => p.text).join("");
      bubble.textContent = liveRun.elText;
    } else {
      const pre = appendTermBlock();
      liveRun.el = pre;
      for (const p of liveRun.pieces) appendTermLine(pre, p.text, p.cls);
    }
  }
  scrollConsole();
}

// Build + append a right-aligned user bubble.
function appendUserBubble(text) {
  const wrap = document.createElement("div");
  wrap.className = "message user";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  consoleOut.appendChild(wrap);
  scrollConsole();
  return wrap;
}

// Build + append an EMPTY left-aligned agent bubble; returns the inner element
// streaming writes into. While streaming we set .textContent (raw); on
// finalize we swap in rendered markdown.
function appendAgentBubble() {
  const wrap = document.createElement("div");
  wrap.className = "message assistant";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  wrap.appendChild(bubble);
  consoleOut.appendChild(wrap);
  scrollConsole();
  return bubble;
}

function finalizeAgentBubble(bubbleEl, text) {
  bubbleEl.innerHTML = `<div class="md-preview">${mdParse(text || "", { gfm: true, breaks: false })}</div>`;
  scrollConsole();
}

// Build + append a full-width terminal block; returns the inner <pre>.
function appendTermBlock() {
  const wrap = document.createElement("div");
  wrap.className = "message system";
  const pre = document.createElement("pre");
  pre.className = "term-block";
  wrap.appendChild(pre);
  consoleOut.appendChild(wrap);
  scrollConsole();
  return pre;
}

// Append a classed text span into a terminal <pre>.
function appendTermLine(pre, text, cls) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  pre.appendChild(span);
  scrollConsole();
}

function scrollConsole() {
  consoleOut.scrollTop = consoleOut.scrollHeight;
}

// Generic one-off notice: render as a standalone terminal block.
function append(text, cls) {
  const pre = appendTermBlock();
  appendTermLine(pre, text, cls);
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
