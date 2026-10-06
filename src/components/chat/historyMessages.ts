import type { Message, ToolCallInfo } from "./types";

export interface HistoryMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

const HISTORY_LIMIT = 20;
const TRACE_ARG_MAX_CHARS = 80;
const TRACE_OPENING = "[Tools used:";
const ECHOED_TRACE = /^\s*\[Tools used:[^\]\n]*\]\s*/;

// The one argument a trace may show per tool: a search query, a name or a
// title. Anything else (email and message bodies, issue text, note content,
// dictionary edits) is the user's drafted content and is never replayed.
const TRACE_ARGUMENT: Record<string, string> = {
  web_search: "query",
  search_notes: "query",
  linear_search_issues: "query",
  github_search_issues: "query",
  find_contact: "name",
  create_note: "title",
};

function traceArgument(call: ToolCallInfo): string | null {
  const field = TRACE_ARGUMENT[call.name];
  if (!field) return null;
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return null;
  }
  const value = (args as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/[\r\n"[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;
  // By code point, so a cut never leaves half a surrogate pair in every later request.
  const chars = Array.from(clean);
  return chars.length > TRACE_ARG_MAX_CHARS
    ? `${chars.slice(0, TRACE_ARG_MAX_CHARS).join("")}…`
    : clean;
}

/**
 * A short record of the tools a turn called, so the model sees its own
 * precedent. Never results or outcomes: query items and web results are other
 * people's text, and a restored call's status can't say whether a card was sent.
 */
export function toolTrace(toolCalls: ReadonlyArray<ToolCallInfo> | undefined): string {
  if (!toolCalls?.length) return "";
  const entries = toolCalls.map((call) => {
    const arg = traceArgument(call);
    // A call still executing was cut off before its result arrived, but its side
    // effect may have happened (a send commits in main after Esc).
    const unrecorded = call.status === "executing" ? " (outcome not recorded)" : "";
    return `${call.name}${arg ? ` ("${arg}")` : ""}${unrecorded}`;
  });
  return `${TRACE_OPENING} ${entries.join(", ")}]`;
}

/**
 * A reply as the user sees it: a model imitating the notes in its history must
 * not show, save or paste one. While streaming, a reply that is still only the
 * start of a note stays hidden until it can tell.
 */
export function withoutEchoedToolTrace(content: string): string {
  const opening = content.trimStart();
  if (!opening) return content;
  if (TRACE_OPENING.startsWith(opening)) return "";
  if (opening.startsWith(TRACE_OPENING) && !/[\]\n]/.test(opening)) return "";
  return content.replace(ECHOED_TRACE, "");
}

/** The last messages as the model sees them, with earlier tool use noted on assistant turns. */
export function toHistoryMessages(
  messages: ReadonlyArray<Message>,
  { includeToolTrace }: { includeToolTrace: boolean }
): HistoryMessage[] {
  return messages.slice(-HISTORY_LIMIT).map((m) => {
    const trace = includeToolTrace && m.role === "assistant" ? toolTrace(m.toolCalls) : "";
    return { role: m.role, content: trace ? `${trace}\n\n${m.content}` : m.content };
  });
}
