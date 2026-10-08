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

// A connector action's status (its saved result), as the model reads it. Without
// it, a follow-up turn can't tell an issue was already created and files it again.
const ACTION_OUTCOME: Record<string, string> = {
  sent: "sent",
  draft_opened: "draft opened",
  unknown: "may have been sent",
  cancelled_by_user: "cancelled by the user",
  not_sent: "not sent",
  failed: "failed",
  unavailable: "unavailable",
  needs_clarification: "needed details",
};
const OUTCOME_URL_MAX_CHARS = 200;

function traceArgument(call: ToolCallInfo): string | null {
  const field = TRACE_ARGUMENT[call.name];
  if (!field) return null;
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return null;
  }
  return traceText((args as Record<string, unknown> | null)?.[field]);
}

// A link is shown whole or not at all: a cut one would point somewhere else.
function outcomeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > OUTCOME_URL_MAX_CHARS) return null;
  if (!/^https:\/\/[^\s"[\]]+$/.test(value)) return null;
  return value;
}

/**
 * What a connector action did, plus what a sent one created (its reference and
 * link). Never the destination, the user's edits on the card, or error text:
 * a display name or an error body is other people's text.
 */
function traceOutcome(call: ToolCallInfo): string | null {
  const data = call.metadata;
  if (!data || Array.isArray(data) || typeof data.status !== "string") return null;
  if (!Object.hasOwn(ACTION_OUTCOME, data.status)) return null;
  const outcome = ACTION_OUTCOME[data.status];
  if (data.status !== "sent") return outcome;
  const created = [traceText(data.reference), outcomeUrl(data.url)].filter(Boolean);
  return created.length ? `${outcome}: ${created.join(" ")}` : outcome;
}

function traceText(value: unknown): string | null {
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
 * precedent. Never results: query items and web results are other people's
 * text. A connector action's outcome is noted, so it isn't done twice.
 */
export function toolTrace(toolCalls: ReadonlyArray<ToolCallInfo> | undefined): string {
  if (!toolCalls?.length) return "";
  const entries = toolCalls.map((call) => {
    const arg = traceArgument(call);
    // A call still executing was cut off before its result arrived, but its side
    // effect may have happened (a send commits in main after Esc).
    const outcome = call.status === "executing" ? "outcome not recorded" : traceOutcome(call);
    return `${call.name}${arg ? ` ("${arg}")` : ""}${outcome ? ` (${outcome})` : ""}`;
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
