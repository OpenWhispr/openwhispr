function parseOfflineMessage(message) {
  const text = String(message || "").trim();
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.text === "string" ? parsed.text.trim() : text;
  } catch {
    return text;
  }
}

function parseOnlineMessages(messages) {
  const texts = [];
  const finalizedSegments = new Set();
  let latest = null;

  for (const message of messages) {
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      parsed = { text: message };
    }

    if (!parsed || typeof parsed !== "object") continue;

    const text = String(parsed.text ?? "").trim();
    if (!text) continue;

    latest = parsed;
    if (!parsed.is_final) continue;

    const segment = parsed.segment ?? `${texts.length}:${text}`;
    if (!finalizedSegments.has(segment)) {
      finalizedSegments.add(segment);
      texts.push(text);
    }
  }

  const latestText = String(latest?.text ?? "").trim();
  if (latestText && !latest?.is_final && !finalizedSegments.has(latest?.segment)) {
    texts.push(latestText);
  }

  return texts.join(" ").trim();
}

module.exports = { parseOfflineMessage, parseOnlineMessages };
