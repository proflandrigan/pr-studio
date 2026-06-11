// Spawns Claude Code in headless mode (`claude -p`) inside a local repo
// checkout and streams its output back. This is the piece a browser can't do
// on its own — it needs a local process with filesystem access.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

// Which Claude Code binary to call. Override with CLAUDE_BIN if it's not on PATH.
export const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

// Permission posture for unattended runs. "review" is read-only; "fix" lets the
// agent edit files. Defaults stay conservative.
const MODES = {
  review: ["--allowedTools", "Read", "Glob", "Grep", "Bash(git*)", "--disallowedTools", "Write", "Edit"],
  fix: ["--permission-mode", "acceptEdits", "--allowedTools", "Read", "Write", "Edit", "Glob", "Grep", "Bash"],
};

// Descriptive info for the UI, derived from MODES so there's one source of truth
// for what each mode can and can't do.
export const MODE_INFO = {
  review: {
    label: "review (read-only)",
    description: "Read-only — cannot edit files",
    allowed: ["Read", "Glob", "Grep", "Bash(git*)"],
    disallowed: ["Write", "Edit"],
  },
  fix: {
    label: "fix (allows edits)",
    description: "Can edit files + run bash",
    allowed: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    disallowed: [],
  },
};

export function runAgent({ prompt, repoPath, mode = "review", onData, onError, onClose }) {
  if (!prompt || !prompt.trim()) {
    onError("No task provided.");
    onClose(1);
    return null;
  }
  if (!repoPath || !existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    onError(`Repo path not found: ${repoPath || "(empty)"}\nSet it to a local checkout of the PR's repository.`);
    onClose(1);
    return null;
  }

  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", ...(MODES[mode] || MODES.review)];

  let child;
  try {
    child = spawn(CLAUDE_BIN, args, { cwd: repoPath });
  } catch (e) {
    onError(`Could not launch "${CLAUDE_BIN}". Is Claude Code installed and on your PATH?\n${e.message}`);
    onClose(1);
    return null;
  }

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

  child.stderr.on("data", (chunk) => onError(chunk.toString()));
  child.on("error", (e) => {
    onError(`Process error: ${e.message}\nIf this says "ENOENT", Claude Code isn't on your PATH.`);
  });
  child.on("close", (code) => {
    if (buffer.trim()) onData(buffer);
    onClose(code);
  });

  return child;
}

function formatEvent(evt) {
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
  if (evt.type === "result") {
    const cost = evt.total_cost_usd != null ? ` · $${evt.total_cost_usd.toFixed(4)}` : "";
    return `\n[done${cost}]\n`;
  }
  if (evt.type === "system" && evt.subtype === "init") {
    return `[session ${evt.session_id || ""} started]\n`;
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
