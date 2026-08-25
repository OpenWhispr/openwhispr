const CHUNK_SIZE = 5;
const CHUNK_OVERLAP = 2;

function chunkConversation(title, messages) {
  const messageList = Array.isArray(messages) ? messages : [];
  const relevant = messageList.filter(
    (m) => m && typeof m === "object" && m.role !== "system"
  );
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
  const safeTitle = typeof title === "string" ? title.trim() : "";
  const messageList = Array.isArray(messages) ? messages : [];
  const body = messageList
    .map((m) => {
      const role = typeof m?.role === "string" ? m.role : "user";
      const content = typeof m?.content === "string" ? m.content : "";
      return `${role}: ${content}`;
    })
    .join("\n");
  const header = safeTitle ? `${safeTitle}\n` : "";
  return `${header}${body}`.slice(0, 1500);
}

module.exports = { chunkConversation };
