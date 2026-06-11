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
    const args = ["-p", prompt, "--output-format", "json", ...MODES.review];

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { cwd: repoPath });
    } catch (e) {
      reject(new Error(`Could not launch "${CLAUDE_BIN}". Is Claude Code installed and on your PATH?\n${e.message}`));
      return;
    }

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
