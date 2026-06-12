// Detects a repo's test/lint command by inspecting files on disk. Pure
// detection only — no process spawning. Used to suggest a "checks" command
// before the agent runs it.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const NPM_PLACEHOLDER_TEST = 'echo "Error: no test specified" && exit 1';

const CHECK_COMMAND_RE =
  /^(npm (test|run \S+)|yarn (test|lint)|pnpm (test|lint|run \S+)|pytest\b.*|make (test|lint|check)\b.*|cargo test\b.*|go test\b.*|tox\b.*|ruff\b.*|eslint\b.*)/;

// Scan text line-by-line for a check-command shape. Prefers a line containing
// "test" if multiple lines match; otherwise returns the first match.
function scanForCommand(text) {
  if (typeof text !== "string") return null;

  let firstMatch = null;
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (line.startsWith("$ ")) line = line.slice(2).trim();
    if (!line) continue;
    if (CHECK_COMMAND_RE.test(line)) {
      if (line.includes("test")) return line;
      if (!firstMatch) firstMatch = line;
    }
  }
  return firstMatch;
}

function readFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function detectCheckCommand(repoPath) {
  if (!repoPath || !existsSync(repoPath)) return null;
  try {
    if (!statSync(repoPath).isDirectory()) return null;
  } catch {
    return null;
  }

  let pkg = null;
  const pkgPath = join(repoPath, "package.json");
  const pkgRaw = readFileSafe(pkgPath);
  if (pkgRaw != null) {
    try {
      pkg = JSON.parse(pkgRaw);
    } catch {
      pkg = null;
    }
  }

  // 1. package.json scripts
  if (pkg && pkg.scripts && typeof pkg.scripts === "object") {
    const parts = [];
    if (pkg.scripts.test && pkg.scripts.test !== NPM_PLACEHOLDER_TEST) {
      parts.push("npm test");
    }
    if (pkg.scripts.lint) {
      parts.push("npm run lint");
    }
    if (parts.length) {
      return { command: parts.join(" && "), source: "package.json" };
    }
  }

  // 2. README
  for (const name of ["README.md", "README", "readme.md"]) {
    const content = readFileSafe(join(repoPath, name));
    if (content != null) {
      const command = scanForCommand(content);
      if (command) {
        return { command, source: "README" };
      }
      break;
    }
  }

  // 3. CLAUDE.md
  {
    const content = readFileSafe(join(repoPath, "CLAUDE.md"));
    if (content != null) {
      const command = scanForCommand(content);
      if (command) {
        return { command, source: "CLAUDE.md" };
      }
    }
  }

  // 4. Language markers
  if (pkg) {
    return { command: "npm test", source: "language" };
  }
  if (existsSync(join(repoPath, "Cargo.toml"))) {
    return { command: "cargo test", source: "language" };
  }
  if (existsSync(join(repoPath, "go.mod"))) {
    return { command: "go test ./...", source: "language" };
  }
  if (
    existsSync(join(repoPath, "pyproject.toml")) ||
    existsSync(join(repoPath, "pytest.ini")) ||
    existsSync(join(repoPath, "setup.cfg")) ||
    existsSync(join(repoPath, "tox.ini"))
  ) {
    return { command: "pytest", source: "language" };
  }
  {
    const makefile = readFileSafe(join(repoPath, "Makefile"));
    if (makefile != null && /^test:/m.test(makefile)) {
      return { command: "make test", source: "language" };
    }
  }

  return null;
}

// Spawns the resolved check command in the repo checkout and streams output
// back via callbacks. Mirrors the runAgent contract in server/agent.js.
export function runChecks({ command, repoPath, onData, onError, onClose }) {
  if (!command || !command.trim()) {
    onError("No check command to run.");
    onClose(1);
    return null;
  }
  if (!repoPath || !existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    onError(`Repo path not found: ${repoPath || "(empty)"}\nSet it to a local checkout of the PR's repository.`);
    onClose(1);
    return null;
  }

  onData(`$ ${command}\n`);

  let child;
  try {
    child = spawn(command, { cwd: repoPath, shell: true });
  } catch (e) {
    onError(`Could not run checks: ${e.message}`);
    onClose(1);
    return null;
  }

  child.stdout.on("data", (c) => onData(c.toString()));
  child.stderr.on("data", (c) => onError(c.toString()));
  child.on("error", (e) => onError(`Process error: ${e.message}`));
  child.on("close", (code) => onClose(code));

  return child;
}
