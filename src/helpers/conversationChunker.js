const CHUNK_SIZE = 5;
const CHUNK_OVERLAP = 2;

function chunkConversation(title, messages) {
  const safeTitle = typeof title === "string" ? title.trim() : "";
  const source = Array.isArray(messages) ? messages : [];
  // Entries without a string role and string content are deliberately skipped:
  // they cannot produce meaningful embedding text.
  const relevant = source.filter(
    (m) =>
      m !== null &&
      typeof m === "object" &&
      typeof m.role === "string" &&
      typeof m.content === "string" &&
      m.role !== "system"
  );
  if (relevant.length === 0) return [];

  if (relevant.length <= CHUNK_SIZE) {
    return [{ chunkIndex: 0, text: formatChunkText(safeTitle, relevant) }];
  }

  const chunks = [];
  for (let i = 0; i < relevant.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
    const window = relevant.slice(i, i + CHUNK_SIZE);
    chunks.push({ chunkIndex: chunks.length, text: formatChunkText(safeTitle, window) });
    // A window reaching the last message already covers every later sub-window.
    if (i + CHUNK_SIZE >= relevant.length) break;
  }
  return chunks;
}

function formatChunkText(title, messages) {
  const body = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  return `${title}\n${body}`.slice(0, 1500);
}

module.exports = { chunkConversation };
