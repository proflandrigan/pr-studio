// Spawns Claude Code in headless mode (`claude -p`) inside a local repo
// checkout and streams its output back. This is the piece a browser can't do
// on its own — it needs a local process with filesystem access.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

// Which Claude Code binary to call. Override with CLAUDE_BIN if it's not on PATH.
export const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

// Permission posture for the agent. It runs inside the user's checkout and is
// granted the full tool set — read, edit, and run commands — so it can carry
// out whatever the user asks without a capability toggle getting in the way.
// `--permission-mode acceptEdits` lets edits land without per-edit prompts
// (headless mode can't prompt anyway). Commits/pushes stay manual.
const AGENT_TOOLS = ["--permission-mode", "acceptEdits", "--allowedTools", "Read", "Write", "Edit", "Glob", "Grep", "Bash"];

// Read-only tool set used only for the internal PR-breakdown task: it reads the
// checkout to emit JSON and must never edit files.
const READONLY_TOOLS = ["--allowedTools", "Read", "Glob", "Grep", "Bash(git*)", "--disallowedTools", "Write", "Edit"];

export function buildAgentArgs({ prompt, sessionId, resume }) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (sessionId) {
    if (resume) {
      args.push("--resume", sessionId);
    } else {
      args.push("--session-id", sessionId);
    }
  }
  args.push(...AGENT_TOOLS);
  return args;
}

// Detect Claude Code's "the session you tried to --resume doesn't exist" error
// from a process's stderr/output text, so a resume failure can fall back to
// starting a fresh session. Tolerant + case-insensitive: Claude phrases this as
// "No conversation found with session ID <uuid>".
export function isSessionNotFoundError(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return t.includes("no conversation found") && t.includes("session id");
}

// Decide the cwd the agent runs in. A valid checkout is used directly so the
// agent can read and edit the PR's files. With no usable path it falls back to a
// neutral temp dir instead of erroring, so the agent can still answer questions
// from the PR context + pinned code in the prompt; edit requests there simply
// have nothing to act on, and the agent says so.
export function resolveAgentCwd({ repoPath }) {
  const valid = repoPath && existsSync(repoPath) && statSync(repoPath).isDirectory();
  if (valid) return { cwd: repoPath };
  return { cwd: tmpdir() };
}

export function runAgent({ prompt, repoPath, sessionId, resume, onData, onError, onClose }) {
  if (!prompt || !prompt.trim()) {
    onError("No task provided.");
    onClose(1);
    return null;
  }
  const { cwd } = resolveAgentCwd({ repoPath });

  // We may relaunch once: a `--resume` turn can fail because the session no
  // longer exists (server restarted, repo path changed, session store expired).
  // When that happens we fall back to a fresh `--session-id` run under the same
  // id. `handle` is a stable proxy to whichever child is currently live, so the
  // caller's disconnect-kill always targets the active process across the swap.
  let active = null;
  let retried = false;
  const handle = {
    kill(signal) {
      if (active) active.kill(signal);
    },
    get killed() {
      return active ? active.killed : true;
    },
  };

  function launch({ resume: useResume }) {
    const args = buildAgentArgs({ prompt, sessionId, resume: useResume });

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { cwd });
    } catch (e) {
      onError(`Could not launch "${CLAUDE_BIN}". Is Claude Code installed and on your PATH?\n${e.message}`);
      onClose(1);
      return;
    }
    active = child;

    // Signal EOF on stdin so `claude -p` doesn't wait ~3s for piped input
    // (and emit the "stdin data received in 3s, proceeding without it" warning).
    child.stdin.end();

    // On a resume attempt that's still eligible to fall back, buffer stderr
    // instead of forwarding it live — we only surface it if we decide NOT to
    // retry, so the user never sees the raw "no conversation found" error when
    // we're about to recover transparently.
    const canFallback = useResume && Boolean(sessionId) && !retried;
    let errBuffer = "";

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        // stream-json emits one JSON event per line; surface human-readable text.
        try {
          const evt = JSON.parse(line);
          onData(formatEvent(evt));
        } catch {
          onData(line + "\n");
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (canFallback) errBuffer += text;
      else onError(text);
    });
    child.on("error", (e) => {
      onError(`Process error: ${e.message}\nIf this says "ENOENT", Claude Code isn't on your PATH.`);
    });
    child.on("close", (code) => {
      if (buffer.trim()) onData(buffer);
      // Self-heal: a resume against a vanished session exits non-zero with
      // "No conversation found with session ID …". Retry once as a fresh
      // session under the same id, after telling the user context was lost.
      // This only fires mid-session (resume === true), so a normal startup
      // never prints a notice.
      if (canFallback && code !== 0 && isSessionNotFoundError(errBuffer)) {
        retried = true;
        onData("\n⚠ Previous session expired — starting a fresh one (earlier context not carried over).\n");
        launch({ resume: false });
        return;
      }
      // Not retrying — flush any stderr we held back, then finish.
      if (errBuffer) onError(errBuffer);
      onClose(code);
    });
  }

  launch({ resume });
  return handle;
}

// Robustly pull a JSON value out of an LLM's textual response.
export function extractJson(text) {
  if (typeof text !== "string") {
    throw new Error("No agent output to parse");
  }

  function tryParse(s) {
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch {
      return { ok: false, value: undefined };
    }
  }

  let attempt = tryParse(text.trim());
  if (attempt.ok) return attempt.value;

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    attempt = tryParse(fenceMatch[1].trim());
    if (attempt.ok) return attempt.value;
  }

  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    attempt = tryParse(text.slice(firstBracket, lastBracket + 1));
    if (attempt.ok) return attempt.value;
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    attempt = tryParse(text.slice(firstBrace, lastBrace + 1));
    if (attempt.ok) return attempt.value;
  }

  throw new Error("Could not parse JSON from agent output");
}

// Build the prompt asking Claude to break a PR's diff into an ordered,
// guided-tour set of review chunks.
export function buildBreakdownPrompt({ title, files }) {
  const fileSections = (files || [])
    .map((f) => {
      let patch = f.patch;
      if (!patch) {
        patch = "(no patch available)";
      } else if (patch.length > 6000) {
        patch = patch.slice(0, 6000) + "\n…(truncated)";
      }
      return [
        `File: ${f.filename}`,
        `Status: ${f.status}`,
        `Additions: ${f.additions}`,
        `Deletions: ${f.deletions}`,
        "Patch:",
        patch,
      ].join("\n");
    })
    .join("\n\n");

  return [
    "You are helping a reviewer understand a pull request by breaking it into",
    "an ordered, guided-tour set of review chunks. Order the chunks like an",
    "onboarding walkthrough: start at the entry point of the change, then step",
    "through the rest of the code in the order a reviewer should read it to",
    "build understanding incrementally.",
    "",
    `PR title: ${title}`,
    "",
    "Changed files:",
    "",
    fileSections,
    "",
    "Respond with ONLY a JSON array, no prose, no markdown fences. Each element",
    "must be an object with exactly these keys:",
    '- "title": a short string naming this chunk',
    '- "narrative": 1-3 sentences explaining what to look at in this chunk and',
    "  why it comes at this point in the reading order",
    '- "files": an array of filename strings drawn from the changed files above,',
    "  ordered for the reading sequence within this chunk",
    "",
    "Every changed file should appear in exactly one chunk. Order the chunks as",
    "a logical reading path starting from the entry point of the change.",
  ].join("\n");
}

// Run Claude Code headless once, read-only, to produce a structured PR
// breakdown as JSON. Resolves with the raw (un-normalized) chunks array.
export function runBreakdown({ files, title, repoPath }) {
  return new Promise((resolve, reject) => {
    if (!repoPath || !existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
      reject(new Error(`Repo path not found: ${repoPath || "(empty)"} — set it to a local checkout of the PR's repository.`));
      return;
    }

    const prompt = buildBreakdownPrompt({ title, files });
    const args = ["-p", prompt, "--output-format", "json", ...READONLY_TOOLS];

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { cwd: repoPath });
    } catch (e) {
      reject(new Error(`Could not launch "${CLAUDE_BIN}". Is Claude Code installed and on your PATH?\n${e.message}`));
      return;
    }

    // Signal EOF on stdin so `claude -p` doesn't wait ~3s for piped input
    // (and emit the "stdin data received in 3s, proceeding without it" warning).
    child.stdin.end();

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (e) => {
      reject(new Error(`Process error: ${e.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Agent exited ${code}${stderr ? ": " + stderr.trim() : ""}`));
        return;
      }

      try {
        let data;
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && typeof parsed.result === "string") {
            data = extractJson(parsed.result);
          } else {
            data = extractJson(stdout);
          }
        } catch {
          data = extractJson(stdout);
        }

        const chunks = Array.isArray(data) ? data : (data && Array.isArray(data.chunks) ? data.chunks : data);
        resolve(chunks);
      } catch (e) {
        reject(new Error(`Could not read agent output: ${e.message}`));
      }
    });
  });
}

export function formatEvent(evt) {
  // Translate a Claude Code stream-json event into a readable console line.
  if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
    return evt.message.content
      .map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "tool_use") return `\n  → ${b.name}(${summarizeInput(b.input)})\n`;
        return "";
      })
      .join("");
  }
  return "";
}

function summarizeInput(input) {
  if (!input) return "";
  if (input.file_path) return input.file_path;
  if (input.command) return String(input.command).slice(0, 60);
  if (input.pattern) return input.pattern;
  const keys = Object.keys(input);
  return keys.length ? keys[0] : "";
}
