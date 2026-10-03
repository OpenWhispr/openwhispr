import type { Message, ToolCallInfo } from "./types";

export interface HistoryMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

const HISTORY_LIMIT = 20;
const TRACE_ARG_MAX_CHARS = 80;

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
  return clean.length > TRACE_ARG_MAX_CHARS ? `${clean.slice(0, TRACE_ARG_MAX_CHARS)}…` : clean;
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
    const interrupted = call.status === "executing" ? " (interrupted)" : "";
    return `${call.name}${arg ? ` ("${arg}")` : ""}${interrupted}`;
  });
  return `[Tools used: ${entries.join(", ")}]`;
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
