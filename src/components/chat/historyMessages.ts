import type { Message, ToolCallInfo } from "./types";
import type { InteractionRecord } from "../../types/agentInteractions";
import { buildAgentRequestText } from "../../utils/agentSelectionContext";
import { answerText } from "../../utils/interactionAnswers";

export interface HistoryMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

/**
 * How earlier turns' tool use reaches the model: as tool-call and tool-result
 * parts, as a [Tools used: …] note on the reply (self-hosted servers, whose
 * chat templates may not take tool messages), or not at all (no tools).
 */
export type ToolHistory = "parts" | "text" | "none";

const HISTORY_LIMIT = 20;
// Tool messages count too: the cloud's Gemma provider takes at most 64
// messages a request, the turn's own tool steps included.
const HISTORY_MAX_ENTRIES = 40;
const TRACE_ARG_MAX_CHARS = 80;
// Providers differ on call ids, and one may replay to another: Anthropic takes
// letters, digits, _ and -, OpenAI Chat Completions at most 40 characters.
const CALL_ID_MAX_CHARS = 36;
export const TRACE_OPENING = "[Tools used:";
const ECHOED_TRACE = /^\s*\[Tools used:[^\]\n]*\]\s*/;

// The one argument a trace may show per tool: a search query, a name, a
// title or where a message went. Anything else (email and message bodies,
// issue text, note content, dictionary edits) is the user's drafted content
// and is never replayed.
const TRACE_ARGUMENT: Record<string, string> = {
  web_search: "query",
  search_notes: "query",
  linear_search_issues: "query",
  github_search_issues: "query",
  find_contact: "name",
  create_note: "title",
  slack_send_message: "destination",
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
  already_sent: "already done earlier, not repeated",
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

interface CallOutcome {
  outcome: string;
  /** What a sent action created. */
  reference?: string;
  link?: string;
}

/**
 * What a connector action did, plus what a sent one created (its reference and
 * link). Never the resolved destination, the user's edits on the card, or
 * error text: a display name or an error body is other people's text. A call
 * cut off before its result arrived may still have had its side effect (a
 * send commits in main after Esc), unless the stop recorded that it never ran.
 */
function callOutcome(call: ToolCallInfo): CallOutcome | null {
  const data = call.metadata && !Array.isArray(call.metadata) ? call.metadata : null;
  const status = typeof data?.status === "string" ? data.status : "";
  if (!data || !Object.hasOwn(ACTION_OUTCOME, status)) {
    const cutOff = call.status === "executing" || call.status === "stopped";
    return cutOff ? { outcome: "outcome not recorded" } : null;
  }
  const outcome = ACTION_OUTCOME[status];
  if (status !== "sent") return { outcome };
  const reference = traceText(data.reference);
  const link = outcomeUrl(data.url);
  return { outcome, ...(reference ? { reference } : {}), ...(link ? { link } : {}) };
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

// What the user was asked and how they answered, with the name the answer
// goes by in a tool result. A saved key is only ever "saved": its value never
// reaches the conversation.
function interactionTrace({ payload, state, result }: InteractionRecord): {
  field: string;
  arg: string;
  outcome: string;
} {
  if (payload.kind !== "questions") {
    const [field, arg] =
      payload.kind === "access"
        ? ["resource", payload.resource]
        : payload.kind === "apiKey"
          ? ["provider", payload.provider]
          : ["target", payload.target];
    return { field, arg, outcome: interactionOutcome(state, result) };
  }
  if (result?.status !== "answered") {
    return {
      field: "questions",
      arg: payload.questions.map((question) => traceText(question.prompt)).join("; "),
      outcome: interactionOutcome(state, result),
    };
  }
  const answered = payload.questions.map((question) => {
    const text = answerText(question, result.answers[question.id]);
    return `${traceText(question.prompt)} → ${traceText(text) ?? "nothing chosen"}`;
  });
  return { field: "answers", arg: answered.join("; "), outcome: "answered" };
}

function interactionOutcome(
  state: InteractionRecord["state"],
  result: InteractionRecord["result"]
): string {
  if (!result) return state === "interrupted" ? "not answered yet" : "waiting for the user";
  switch (result.status) {
    case "cancelled":
      return "dismissed by the user";
    case "not_answered":
      return "not answered";
    case "done":
      return result.ready === false ? "back from settings, still not set up" : "done";
    default:
      return result.status;
  }
}

/** A connector tool that asked to connect its service first: it runs once that's done. */
export function connectsFirst(call: ToolCallInfo): boolean {
  return call.interaction?.payload.kind === "connection" && call.name !== "request_connection";
}

// Older versions stored built-in help evidence as a synthetic tool call. It
// was never a model tool and must not teach future turns to invoke it.
function replayedCalls(toolCalls: ReadonlyArray<ToolCallInfo> | undefined): ToolCallInfo[] {
  return (toolCalls ?? []).filter((call) => call.name !== "grounded_product_help");
}

// A tool that asked to connect its service first is recorded by what it then did.
function askedUser(call: ToolCallInfo): InteractionRecord | null {
  return call.interaction && !connectsFirst(call) ? call.interaction : null;
}

/**
 * A short record of the tools a turn called, so the model sees its own
 * precedent. Never results: query items and web results are other people's
 * text. A connector action's outcome is noted, so it isn't done twice.
 */
export function toolTrace(toolCalls: ReadonlyArray<ToolCallInfo> | undefined): string {
  const entries = replayedCalls(toolCalls).map((call) => {
    const asked = askedUser(call);
    if (asked) {
      const { arg, outcome } = interactionTrace(asked);
      return `${call.name} ("${arg}") (${outcome})`;
    }
    const arg = traceArgument(call);
    const result = callOutcome(call);
    const created = [result?.reference, result?.link].filter(Boolean).join(" ");
    const outcome = result && (created ? `${result.outcome}: ${created}` : result.outcome);
    return `${call.name}${arg ? ` ("${arg}")` : ""}${outcome ? ` (${outcome})` : ""}`;
  });
  return entries.length ? `${TRACE_OPENING} ${entries.join(", ")}]` : "";
}

function replayCallId(id: string, used: Set<string>): string {
  const base = id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, CALL_ID_MAX_CHARS) || "call";
  let replayed = base;
  for (let n = 2; used.has(replayed); n++) replayed = `${base}_${n}`;
  used.add(replayed);
  return replayed;
}

/**
 * One earlier call as the provider's own tool-call and tool-result messages,
 * carrying what the text trace does: the argument it may show, and its
 * outcome (an answer, or what an action did and created). A call with no
 * recorded outcome is "done" or "failed", never its result.
 */
function toolCallParts(call: ToolCallInfo, toolCallId: string): HistoryMessage[] {
  const asked = askedUser(call);
  const field = TRACE_ARGUMENT[call.name];
  const arg = asked ? null : traceArgument(call);
  let result: Record<string, string>;
  if (asked) {
    const { field: answerField, arg: answer, outcome } = interactionTrace(asked);
    result = { status: outcome, ...(answer ? { [answerField]: answer } : {}) };
  } else {
    const { outcome, ...created } = callOutcome(call) ?? {
      outcome: call.status === "error" ? "failed" : "done",
    };
    result = { status: outcome, ...created };
  }
  const { name: toolName } = call;
  return [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId, toolName, input: field && arg ? { [field]: arg } : {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName,
          output: { type: "text", value: JSON.stringify(result) },
        },
      ],
    },
  ];
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

/**
 * The last messages as the model sees them, with earlier tool use on assistant
 * turns (see ToolHistory) and the selected text a request was about kept with
 * it. A failed reply with nothing in it is left out, and so is a reply's empty
 * text after its tool calls: some providers reject an empty assistant message.
 * It starts with a user message: Gemini, Vertex and Bedrock refuse one that
 * starts with a reply or its tool calls, which a cut window can.
 */
export function toHistoryMessages(
  messages: ReadonlyArray<Message>,
  { toolHistory }: { toolHistory: ToolHistory }
): HistoryMessage[] {
  const callIds = new Set<string>();
  const history = messages.slice(-HISTORY_LIMIT).flatMap((m): HistoryMessage | HistoryMessage[] => {
    if (m.role === "user" && m.selectedContext) {
      return {
        role: m.role,
        content: buildAgentRequestText(m.content, {
          text: m.selectedContext,
          sourceMessageId: "",
          source: m.selectedContextSource,
        }),
      };
    }
    const calls = m.role === "assistant" ? replayedCalls(m.toolCalls) : [];
    if (toolHistory === "parts" && calls.length > 0) {
      return [
        ...calls.flatMap((call) => toolCallParts(call, replayCallId(call.id, callIds))),
        ...(m.content.trim() ? [{ role: m.role, content: m.content }] : []),
      ];
    }
    const trace = toolHistory === "text" ? toolTrace(calls) : "";
    const content = trace ? `${trace}\n\n${m.content}` : m.content;
    return m.turn?.status === "error" && !content.trim() ? [] : { role: m.role, content };
  });
  const kept = history.slice(-HISTORY_MAX_ENTRIES);
  const start = kept.findIndex((m) => m.role === "user");
  return start === -1 ? [] : kept.slice(start);
}
