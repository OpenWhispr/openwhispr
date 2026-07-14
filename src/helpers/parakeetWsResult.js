function parseOfflineMessage(message) {
  const text = String(message || "").trim();
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.text === "string" ? parsed.text.trim() : text;
  } catch {
    return text;
  }
}

// Dedupes finalized segments by id; text() is finalized text plus the trailing partial.
function createOnlineAccumulator() {
  const finalizedSegments = new Set();
  let finalizedText = "";
  let partialText = "";
  let fallbackKey = 0;

  const text = () =>
    finalizedText && partialText ? `${finalizedText} ${partialText}` : finalizedText || partialText;

  return {
    push(message) {
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch {
        parsed = { text: message };
      }
      if (!parsed || typeof parsed !== "object") return text();

      const messageText = String(parsed.text ?? "").trim();
      if (!messageText) return text();

      if (!parsed.is_final) {
        partialText = finalizedSegments.has(parsed.segment) ? "" : messageText;
        return text();
      }

      const segment = parsed.segment ?? `fallback:${fallbackKey++}`;
      if (!finalizedSegments.has(segment)) {
        finalizedSegments.add(segment);
        finalizedText = finalizedText ? `${finalizedText} ${messageText}` : messageText;
      }
      partialText = "";
      return text();
    },
    text,
  };
}

function parseOnlineMessages(messages) {
  const accumulator = createOnlineAccumulator();
  for (const message of messages) {
    accumulator.push(message);
  }
  return accumulator.text();
}

module.exports = { parseOfflineMessage, parseOnlineMessages, createOnlineAccumulator };
