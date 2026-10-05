function parseOfflineMessage(message) {
  const text = String(message || "").trim();
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.text === "string" ? parsed.text.trim() : text;
  } catch {
    return text;
  }
}

// Latest-wins per finalized segment id (the server refines a segment before its
// endpoint); text() joins segments in first-arrival order plus the trailing partial.
function createOnlineAccumulator() {
  const finalizedSegments = new Map();
  let partialText = "";
  let partialSegment = null;
  let fallbackKey = 0;

  const text = () => {
    const finalizedText = Array.from(finalizedSegments.values()).join(" ");
    return finalizedText && partialText
      ? `${finalizedText} ${partialText}`
      : finalizedText || partialText;
  };

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
        partialSegment = parsed.segment ?? null;
        return text();
      }

      const segment = parsed.segment ?? `fallback:${fallbackKey++}`;
      finalizedSegments.set(segment, messageText);
      if (partialSegment === null || partialSegment === segment) {
        partialText = "";
        partialSegment = null;
      }
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
