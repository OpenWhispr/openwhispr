import type { Message, ToolCallInfo } from "./types";
import type { InteractionRecord } from "../../types/agentInteractions";
import { buildAgentRequestText } from "../../utils/agentSelectionContext";
import { answerText } from "../../utils/interactionAnswers";

export interface HistoryMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

export const HISTORY_LIMIT = 20;
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
  load_skill: "name",
};

// A connector action's or skill card's status (its saved result), as the model reads
// it. Without it, a follow-up turn can't tell an issue was already created, or a skill
// already saved, and does it again.
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
  saved: "saved",
  skipped: "skipped by the user",
  changed: "not saved, the skill had changed",
  not_saved: "not saved",
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
 * What a connector action or skill card did, plus what a sent action created (its
 * reference and link). Never the destination, the user's edits on the card, or error text:
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

// What the user was asked and how they answered. A saved key is only ever
// "saved": its value never reaches the conversation.
function interactionTrace({ payload, state, result }: InteractionRecord): {
  arg: string;
  outcome: string;
} {
  if (payload.kind !== "questions") {
    const arg =
      payload.kind === "access"
        ? payload.resource
        : payload.kind === "apiKey"
          ? payload.provider
          : payload.target;
    return { arg, outcome: interactionOutcome(state, result) };
  }
  if (result?.status !== "answered") {
    return {
      arg: payload.questions.map((question) => traceText(question.prompt)).join("; "),
      outcome: interactionOutcome(state, result),
    };
  }
  const answered = payload.questions.map((question) => {
    const text = answerText(question, result.answers[question.id]);
    return `${traceText(question.prompt)} → ${traceText(text) ?? "nothing chosen"}`;
  });
  return { arg: answered.join("; "), outcome: "answered" };
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

/**
 * A short record of the tools a turn called, so the model sees its own
 * precedent. Never results: query items and web results are other people's
 * text. A connector action's outcome is noted, so it isn't done twice.
 */
export function toolTrace(toolCalls: ReadonlyArray<ToolCallInfo> | undefined): string {
  if (!toolCalls?.length) return "";
  // Older versions stored built-in help evidence as a synthetic tool call. It
  // was never a model tool and must not teach future turns to invoke it.
  const entries = toolCalls
    .filter((call) => call.name !== "grounded_product_help")
    .map((call) => {
      // A tool that asked to connect its service first is traced by what it then did.
      if (call.interaction && !connectsFirst(call)) {
        const { arg, outcome } = interactionTrace(call.interaction);
        return `${call.name} ("${arg}") (${outcome})`;
      }
      const arg = traceArgument(call);
      // A call cut off before its result arrived may still have had its side
      // effect (a send commits in main after Esc), unless the stop recorded
      // that it never ran.
      const cutOff = call.status === "executing" || call.status === "stopped";
      const outcome = traceOutcome(call) ?? (cutOff ? "outcome not recorded" : null);
      return `${call.name}${arg ? ` ("${arg}")` : ""}${outcome ? ` (${outcome})` : ""}`;
    });
  return entries.length ? `${TRACE_OPENING} ${entries.join(", ")}]` : "";
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
 * The last messages as the model sees them, with earlier tool use noted on
 * assistant turns and the selected text a request was about kept with it. A
 * failed reply with nothing in it is left out: some providers reject an empty
 * assistant message.
 */
export function toHistoryMessages(
  messages: ReadonlyArray<Message>,
  { includeToolTrace }: { includeToolTrace: boolean }
): HistoryMessage[] {
  return messages.slice(-HISTORY_LIMIT).flatMap((m) => {
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
    const trace = includeToolTrace && m.role === "assistant" ? toolTrace(m.toolCalls) : "";
    const content = trace ? `${trace}\n\n${m.content}` : m.content;
    return m.turn?.status === "error" && !content.trim() ? [] : { role: m.role, content };
  });
}
