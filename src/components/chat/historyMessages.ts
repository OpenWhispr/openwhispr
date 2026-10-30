import type { Message, ToolCallInfo } from "./types";
import type { InteractionRecord } from "../../types/agentInteractions";
import { buildAgentRequestText } from "../../utils/agentSelectionContext";
import { answerText } from "../../utils/interactionAnswers";
import { estimateNoteTokens } from "../../helpers/noteChunking";

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

// History is the newest whole messages within both limits. Tool messages
// count too: the cloud's Gemma provider takes at most 64 messages a request,
// the turn's own tool steps included. Each call adds two, so a full history
// leaves room for about a dozen calls; a turn that makes more goes past it,
// and the API answers the rest of that turn without Gemma. A local or LAN
// server's context is small (llama-server starts at 16k, for the system
// prompt, tools, open note and answer too), so its history gets less.
const HISTORY_MAX_ENTRIES = 40;
export const HISTORY_MAX_TOKENS = { hosted: 16_000, selfHosted: 4_000 } as const;
const TRACE_ARG_MAX_CHARS = 80;
// Providers differ on call ids, and one may replay to another: Anthropic takes
// letters, digits, _ and -, OpenAI Chat Completions at most 40 characters.
const CALL_ID_MAX_CHARS = 36;
const TRACE_OPENING = "[Tools used:";
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

// Sends, opened drafts and sends that may have happened stay known after
// their turn leaves the history, each after the request that led to it, so a
// long chat never repeats one or denies it. A call cut off before its result
// counts when it had claimed a send. Only the latest that fit
// LEDGER_MAX_ENTRIES (a request is one entry, an action two): they count
// toward the history's cap.
const LEDGER_STATUSES = new Set(["sent", "draft_opened", "unknown"]);
const LEDGER_MAX_ENTRIES = 10;
const LEDGER_REQUEST_MAX_CHARS = 500;
const LEDGER_NOTE =
  "Earlier messages in this conversation were left out to save space. The requests in them that led to an action, each with what the action did:";

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
  // A Slack link as the destination is a link: whole or not at all.
  if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
    return outcomeUrl(value.trim());
  }
  return traceText(value);
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

/** Whether this turn offers the tool. */
type IsOffered = (toolName: string) => boolean;

// Older versions stored built-in help evidence as a synthetic tool call. It
// was never a model tool and must not teach future turns to invoke it.
const NOT_REPLAYED = new Set(["grounded_product_help"]);

function replayedCalls(toolCalls: ReadonlyArray<ToolCallInfo> | undefined): ToolCallInfo[] {
  return (toolCalls ?? []).filter((call) => !NOT_REPLAYED.has(call.name));
}

// Only a call to a tool this turn offers replays as tool messages: a provider
// may refuse a call to one it doesn't (a look at an earlier screenshot, a
// connector since disconnected, web search turned off). The rest stay as a
// trace note, so a send whose connector is gone is never forgotten or denied.
function splitByOffered(
  calls: ToolCallInfo[],
  isOffered: IsOffered
): { asParts: ToolCallInfo[]; noted: ToolCallInfo[] } {
  const asParts = calls.filter((call) => isOffered(call.name));
  return { asParts, noted: calls.filter((call) => !asParts.includes(call)) };
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

interface LedgerTurn {
  request: string;
  actions: ToolCallInfo[];
}

function isLedgerAction(call: ToolCallInfo): boolean {
  const data = call.metadata && !Array.isArray(call.metadata) ? call.metadata : null;
  if (typeof data?.status === "string") return LEDGER_STATUSES.has(data.status);
  return Boolean(call.actionKey);
}

// By code point, so a cut never splits a surrogate pair.
function clipped(text: string): string {
  const chars = Array.from(text.trim());
  return chars.length > LEDGER_REQUEST_MAX_CHARS
    ? `${chars.slice(0, LEDGER_REQUEST_MAX_CHARS).join("")}…`
    : chars.join("");
}

function ledgerTurns(dropped: ReadonlyArray<Message>): LedgerTurn[] {
  const turns: LedgerTurn[] = [];
  let request = "";
  // Replies to one request (a turn and its resumes) share its entry.
  let current: LedgerTurn | null = null;
  for (const m of dropped) {
    if (m.role === "user") {
      request = clipped(m.content);
      current = null;
    }
    const actions = m.role === "assistant" ? replayedCalls(m.toolCalls).filter(isLedgerAction) : [];
    if (actions.length === 0) continue;
    if (!current) {
      current = { request, actions: [] };
      turns.push(current);
    }
    current.actions.push(...actions);
  }
  // The newest first, while they fit; the note takes one entry.
  const kept: LedgerTurn[] = [];
  let size = 1;
  for (const turn of turns.reverse()) {
    const room = Math.floor((LEDGER_MAX_ENTRIES - size - (turn.request ? 1 : 0)) / 2);
    if (room < 1) break;
    const actions = turn.actions.slice(-room);
    kept.unshift({ request: turn.request, actions });
    size += (turn.request ? 1 : 0) + actions.length * 2;
    if (actions.length < turn.actions.length) break;
  }
  return kept;
}

// As tool calls, the note opening the first request: some chat templates
// refuse two user messages in a row.
function ledgerParts(
  turns: LedgerTurn[],
  callIds: Set<string>,
  isOffered: IsOffered
): HistoryMessage[] {
  return turns.flatMap(({ request, actions }, i) => {
    const text = i === 0 ? [LEDGER_NOTE, request].filter(Boolean).join("\n\n") : request;
    const { asParts, noted } = splitByOffered(actions, isOffered);
    return [
      ...(text ? [{ role: "user", content: text }] : []),
      ...asParts.flatMap((call) => toolCallParts(call, replayCallId(call.id, callIds))),
      ...(noted.length > 0 ? [{ role: "assistant", content: toolTrace(noted) }] : []),
    ];
  });
}

function ledgerText(turns: LedgerTurn[]): string {
  const lines = turns.map(
    ({ request, actions }) => `- ${JSON.stringify(request)}: ${toolTrace(actions)}`
  );
  return [LEDGER_NOTE, ...lines].join("\n");
}

/**
 * The last messages as the model sees them, with earlier tool use on assistant
 * turns (see ToolHistory) and the selected text a request was about kept with
 * it. A reply with nothing left in it is left out (a card-only turn whose tool
 * isn't offered now, a stopped or failed one): Anthropic refuses an empty
 * assistant message. It starts with a user message: Gemini, Vertex and
 * Bedrock refuse one that starts with a reply or its tool calls, which a cut
 * window can. The sends of the messages it leaves out come first, with the
 * requests that led to them.
 */
export function toHistoryMessages(
  messages: ReadonlyArray<Message>,
  {
    toolHistory,
    isOffered = () => true,
    maxTokens = HISTORY_MAX_TOKENS.hosted,
  }: { toolHistory: ToolHistory; isOffered?: IsOffered; maxTokens?: number }
): HistoryMessage[] {
  // The request, the newest user message, always stays, however long it is.
  let request = messages.length - 1;
  while (request >= 0 && messages[request].role !== "user") request--;
  if (request < 0) return [];
  const keptFrom = (maxEntries: number): number => {
    let first = messages.length;
    for (let entries = 0, tokens = 0; first > 0; first--) {
      const replay = replayed(messages[first - 1], toolHistory, new Set(), isOffered);
      entries += replay.length;
      tokens += estimateNoteTokens(JSON.stringify(replay));
      const full = entries > maxEntries || tokens > maxTokens;
      if (full && first - 1 < request) break;
    }
    while (messages[first].role !== "user") first++;
    return first;
  };
  let first = keptFrom(HISTORY_MAX_ENTRIES);
  const sendsLeftOut = toolHistory !== "none" && ledgerTurns(messages.slice(0, first)).length > 0;
  // As tool messages the sends need entries of their own; a text trace rides
  // in the first kept message.
  if (sendsLeftOut && toolHistory === "parts") {
    first = keptFrom(HISTORY_MAX_ENTRIES - LEDGER_MAX_ENTRIES);
  }
  const turns = sendsLeftOut ? ledgerTurns(messages.slice(0, first)) : [];
  const callIds = new Set<string>();
  const ledger = toolHistory === "parts" ? ledgerParts(turns, callIds, isOffered) : [];
  const kept = withoutEmptyReplies(messages.slice(first), (m) =>
    replayed(m, toolHistory, callIds, isOffered)
  );
  if (toolHistory === "text" && turns.length > 0) {
    const [head, ...rest] = kept;
    return [{ ...head, content: `${ledgerText(turns)}\n\n${head.content}` }, ...rest];
  }
  return [...ledger, ...kept];
}

// What a request left without a reply came to, between it and the next one.
const NO_REPLY: Partial<Record<string, string>> = {
  stopped: "(Stopped before a reply.)",
  interrupted: "(Stopped before a reply.)",
  error: "(The reply failed.)",
};

// A reply with nothing left in it is left out, and the requests on either side
// of it go as one message, with what became of the first: chat templates that
// need alternating roles (Mistral's, Gemma's) refuse two user messages in a row.
function withoutEmptyReplies(
  messages: ReadonlyArray<Message>,
  replay: (m: Message) => HistoryMessage[]
): HistoryMessage[] {
  const kept: HistoryMessage[] = [];
  let emptyReply: Message | null = null;
  for (const m of messages) {
    const [head, ...rest] = replay(m);
    if (!head) {
      emptyReply = m;
      continue;
    }
    const previous = kept.at(-1);
    if (
      emptyReply &&
      previous?.role === "user" &&
      head.role === "user" &&
      typeof previous.content === "string" &&
      typeof head.content === "string"
    ) {
      const outcome = NO_REPLY[emptyReply.turn?.status ?? ""];
      const joined = [previous.content, outcome, head.content].filter(Boolean).join("\n\n");
      kept[kept.length - 1] = { ...previous, content: joined };
    } else {
      kept.push(head);
    }
    kept.push(...rest);
    emptyReply = null;
  }
  return kept;
}

/** One message as the model sees it (see toHistoryMessages). */
function replayed(
  m: Message,
  toolHistory: ToolHistory,
  callIds: Set<string>,
  isOffered: IsOffered
): HistoryMessage[] {
  if (m.role === "user" && m.selectedContext) {
    return [
      {
        role: m.role,
        content: buildAgentRequestText(m.content, {
          text: m.selectedContext,
          sourceMessageId: "",
          source: m.selectedContextSource,
        }),
      },
    ];
  }
  const calls = m.role === "assistant" && toolHistory !== "none" ? replayedCalls(m.toolCalls) : [];
  const { asParts, noted } =
    toolHistory === "parts" ? splitByOffered(calls, isOffered) : { asParts: [], noted: calls };
  const content = [toolTrace(noted), m.content].filter((text) => text.trim()).join("\n\n");
  return [
    ...asParts.flatMap((call) => toolCallParts(call, replayCallId(call.id, callIds))),
    ...(content || m.role === "user" ? [{ role: m.role, content }] : []),
  ];
}
