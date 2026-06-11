import { test } from "node:test";
import assert from "node:assert";
import { normalizeChunks } from "./breakdown.js";

function files(...filenames) {
  return filenames.map((filename) => ({
    filename,
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "",
  }));
}

test("sweeps unassigned files into an Other chunk", () => {
  const result = normalizeChunks(
    [{ title: "Group A", narrative: "Covers a", files: ["a"] }],
    files("a", "b", "c")
  );

  assert.strictEqual(result.length, 2);
  assert.deepStrictEqual(result[0], {
    title: "Group A",
    narrative: "Covers a",
    files: ["a"],
  });
  assert.deepStrictEqual(result[1], {
    title: "Other",
    narrative: "Files not grouped by the breakdown.",
    files: ["b", "c"],
  });
});

test("dedupes a file across chunks, first wins", () => {
  const result = normalizeChunks(
    [
      { title: "Chunk 1", narrative: "First", files: ["a"] },
      { title: "Chunk 2", narrative: "Second", files: ["a"] },
    ],
    files("a")
  );

  const chunkWithA = result.filter((c) => c.files.includes("a"));
  assert.strictEqual(chunkWithA.length, 1);
  assert.strictEqual(chunkWithA[0].title, "Chunk 1");

  const chunk2 = result.find((c) => c.title === "Chunk 2");
  assert.strictEqual(chunk2, undefined);
});

test("drops filenames not in the PR", () => {
  const result = normalizeChunks(
    [{ title: "Chunk", narrative: "n", files: ["a", "ghost.js"] }],
    files("a")
  );

  assert.strictEqual(result.length, 1);
  assert.deepStrictEqual(result[0].files, ["a"]);
});

test("drops chunks left empty after filtering", () => {
  const result = normalizeChunks(
    [
      { title: "Ghost only", narrative: "n", files: ["ghost.js"] },
      { title: "Real", narrative: "n", files: ["a"] },
    ],
    files("a")
  );

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].title, "Real");
});

test("garbage rawChunks yields one Other chunk with all files", () => {
  const result = normalizeChunks(null, files("a", "b"));

  assert.strictEqual(result.length, 1);
  assert.deepStrictEqual(result[0], {
    title: "Other",
    narrative: "Files not grouped by the breakdown.",
    files: ["a", "b"],
  });
});

test("returns empty array when no files and no chunks", () => {
  const result = normalizeChunks([], []);
  assert.deepStrictEqual(result, []);
});
