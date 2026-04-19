const CHUNK_SIZE = 5;
const CHUNK_OVERLAP = 2;

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
  const body = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  return `${title}\n${body}`.slice(0, 1500);
}

module.exports = { chunkConversation };
