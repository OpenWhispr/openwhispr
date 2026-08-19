// Pure action behind the paste-last hotkey: fetch the newest usable history
// entry and hand its text to the same insertion seam dictation output uses.
// Deps are injected so the policy stays testable outside the app.

// A few rows deep covers entries whose text is blank (NULL raw sync rows).
const HISTORY_LOOKBACK_LIMIT = 5;

export async function pasteLastTranscription({ getTranscriptions, paste }) {
  if (typeof getTranscriptions !== "function" || typeof paste !== "function") {
    return { status: "unavailable" };
  }

  let rows;
  try {
    rows = await getTranscriptions(HISTORY_LOOKBACK_LIMIT);
  } catch (error) {
    return { status: "error", error };
  }

  const entry = Array.isArray(rows)
    ? rows.find((row) => typeof row?.text === "string" && row.text.trim().length > 0)
    : null;
  if (!entry) {
    return { status: "empty" };
  }

  const pasted = await paste(entry.text);
  return pasted ? { status: "pasted", text: entry.text } : { status: "paste-failed" };
}
