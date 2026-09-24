const VOICE_WEB_RESULTS = 3;
const VOICE_WEB_TEXT_CHARS = 240;

interface WebResult {
  title?: string;
  text?: string;
  publishedDate?: string | null;
}

/**
 * Voice turns hand the model less to read: five web results with 500-char text
 * and URLs cost ~1,100 prompt tokens (~1.5 s on a local 9B); three short ones
 * without URLs, which can't be spoken anyway, cost about a quarter of that.
 */
export function compactToolResultForVoice(toolName: string, data: unknown): unknown {
  if (toolName !== "web_search" || !Array.isArray(data)) return data;
  return (data as WebResult[]).slice(0, VOICE_WEB_RESULTS).map((result) => ({
    title: result.title || "",
    text: (result.text || "").slice(0, VOICE_WEB_TEXT_CHARS),
    publishedDate: result.publishedDate ?? null,
  }));
}

// Voice conversation: English-only for now; needs translation before shipping.
export function voiceToolFiller(toolNames: string[]): string {
  if (toolNames.includes("web_search")) return "Let me look that up.";
  if (toolNames.some((name) => name === "search_notes" || name === "get_note")) {
    return "Let me check your notes.";
  }
  if (toolNames.some((name) => name.startsWith("get_calendar"))) return "Let me check your calendar.";
  return "One moment.";
}

export function shouldStopForIdle({
  lastActivityAt,
  now,
  busy,
  idleMs,
}: {
  lastActivityAt: number;
  now: number;
  busy: boolean;
  idleMs: number;
}): boolean {
  return !busy && now - lastActivityAt >= idleMs;
}
