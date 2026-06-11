// Pure helper that turns a raw, untrusted LLM-produced chunk array into a
// clean, trustworthy chunk array safe for the UI to render.
//
// No imports, no I/O, no side effects.

export function normalizeChunks(rawChunks, files) {
  const validFilenames = new Set(
    Array.isArray(files) ? files.map((f) => f && f.filename) : []
  );

  const used = new Set();
  const result = [];

  const chunks = Array.isArray(rawChunks) ? rawChunks : [];

  for (const rawChunk of chunks) {
    if (!rawChunk || typeof rawChunk !== "object") continue;

    const title =
      rawChunk.title === undefined ||
      rawChunk.title === null ||
      String(rawChunk.title) === ""
        ? "Untitled"
        : String(rawChunk.title);

    const narrative =
      rawChunk.narrative === undefined || rawChunk.narrative === null
        ? ""
        : String(rawChunk.narrative);

    const rawFiles = Array.isArray(rawChunk.files) ? rawChunk.files : [];
    const chunkFiles = [];
    for (const f of rawFiles) {
      if (
        typeof f === "string" &&
        validFilenames.has(f) &&
        !used.has(f)
      ) {
        chunkFiles.push(f);
        used.add(f);
      }
    }

    if (chunkFiles.length === 0) continue;

    result.push({ title, narrative, files: chunkFiles });
  }

  if (Array.isArray(files)) {
    const leftover = files
      .map((f) => f && f.filename)
      .filter((filename) => typeof filename === "string" && !used.has(filename));

    if (leftover.length > 0) {
      result.push({
        title: "Other",
        narrative: "Files not grouped by the breakdown.",
        files: leftover,
      });
    }
  }

  return result;
}
