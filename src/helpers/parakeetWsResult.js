function parseOfflineMessage(message, modelType) {
  let text = String(message || "").trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.text === "string") text = parsed.text.trim();
  } catch {
    // Some versions send plain text.
  }
  if (modelType === "qwen3-asr") {
    if (text === "<message") return "";
    return text.replace(
      /^(?:(?:language|\*\*language|\$lang(?:uage)?) [A-Za-z -]{1,40})?<asr_text>\s*/i,
      ""
    );
  }
  return text;
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
