const CHUNK_SIZE = 5;
const CHUNK_OVERLAP = 2;
// Each message is capped before the window is joined, so one long reply can't
// push the rest of its window past the 1,500-character cut (or the embedder's
// 256-token limit) and leave the following messages unindexed.
const MAX_MESSAGE_CHARS = 280;

function chunkConversation(title, messages) {
  const relevant = messages.filter((m) => m.role !== "system");
  if (relevant.length === 0) return [];

  if (relevant.length <= CHUNK_SIZE) {
    return [{ chunkIndex: 0, text: formatChunkText(title, relevant) }];
  }

  const chunks = [];
  for (let i = 0; i < relevant.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
    const window = relevant.slice(i, i + CHUNK_SIZE);
    if (window.length < 2) break;
    chunks.push({ chunkIndex: chunks.length, text: formatChunkText(title, window) });
  }
  return chunks;
}

function formatChunkText(title, messages) {
  const body = messages
    .map((m) => `${m.role}: ${m.content.slice(0, MAX_MESSAGE_CHARS)}`)
    .join("\n");
  return `${title}\n${body}`.slice(0, 1500);
}

module.exports = { chunkConversation };
