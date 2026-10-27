import type { ToolCallInfo } from "./types";

// A narrow safety net for a final answer that says something was done when no
// tool did it. It errs towards silence: a "not done" note on a truthful reply
// is worse than a missed claim. English only: a reply in another language
// never matches, so it is shown as written, never asked again or flagged.

type ClaimKind = "send" | "email" | "draft" | "create" | "connect" | "save";

const WENT_OUT = new Set(["sent", "unknown", "already_sent"]);
const MAX_CHECKED_CHARS = 8_000;

function resultStatus(call: ToolCallInfo): string | undefined {
  const data = call.metadata;
  return data && !Array.isArray(data) && typeof data.status === "string" ? data.status : undefined;
}

// A connector action that went out, or may have: never flagged as not done.
const wentOut = (call: ToolCallInfo) => WENT_OUT.has(resultStatus(call) ?? "");
const answered = (call: ToolCallInfo, status: string) =>
  call.interaction?.result?.status === status;

// Each kind of claim: its past-tense verbs, the tools that can do it (no tool
// offered, no check), and whether a call of one did.
const KINDS: Record<
  ClaimKind,
  { verbs: string; tools: string[]; did: (call: ToolCallInfo) => boolean }
> = {
  send: {
    verbs: "sent|messaged|posted",
    tools: ["email_draft", "slack_send_message", "linear_comment", "github_comment"],
    did: wentOut,
  },
  // "Emailed" names its channel: a Slack message never backs it.
  email: { verbs: "emailed", tools: ["email_draft"], did: wentOut },
  draft: {
    verbs: "drafted",
    tools: ["email_draft"],
    did: (call) => wentOut(call) || resultStatus(call) === "draft_opened",
  },
  create: {
    verbs: "created|filed|commented",
    tools: [
      "create_note",
      "linear_create_issue",
      "github_create_issue",
      "linear_comment",
      "github_comment",
    ],
    did: (call) => (call.name === "create_note" ? call.status === "completed" : wentOut(call)),
  },
  connect: {
    verbs: "connected",
    tools: ["request_connection"],
    did: (call) => answered(call, "connected"),
  },
  save: { verbs: "saved", tools: ["request_api_key"], did: (call) => answered(call, "saved") },
};
const KIND_OF_VERB = new Map(
  (Object.keys(KINDS) as ClaimKind[]).flatMap((kind) =>
    KINDS[kind].verbs.split("|").map((verb) => [verb, kind] as const)
  )
);
// "Created" counts only with what a tool creates, and "saved" only for a key:
// "I've created a summary" or "notes are saved" describe no tool's action.
const CREATED_OBJECT = /\b(?:notes?|issues?|tickets?|comments?)\b/i;
const SAVED_OBJECT = /\bkeys?\b/i;

const ALL_VERBS = [...KIND_OF_VERB.keys()];
const ADVERBS = String.raw`(?:(?:just|already|now|also|successfully)\s+)*`;
// (a) "I've sent", "I have just posted", "I sent". "Drafted" only in a report:
// "I've drafted it below" describes the reply's own text.
const FIRST_PERSON = new RegExp(
  String.raw`\bI(?:['’]ve|\s+have)?\s+${ADVERBS}(${ALL_VERBS.filter((verb) => verb !== "drafted").join("|")})\b`,
  "gi"
);
// (b) A result report: "it was sent", "your email to Gabe has been sent",
// "the issue is now created", "it's been posted".
const REPORT = new RegExp(
  String.raw`\b(?:it|that|your\s+[\w-]+|the\s+(?:email|message|draft|issue|comment|note))(?:\s+to\s+(?:the\s+)?\S+)?(?:\s+(?:was|has\s+been|is\s+now)|['’]s\s+been)\s+${ADVERBS}(${ALL_VERBS.join("|")})\b`,
  "gi"
);
// (c) "Sent to Gabe!", "Message posted to #eng".
const SENT_TO = /^\W*(?:(?:email|message|reply|comment)\s+)?(sent|posted)\s+to\b/gi;

// A clause that is a condition, a plan or someone else's account ("Once it's
// sent", "According to your notes, …", "saved automatically") claims nothing,
// nor does the rest of its sentence.
const NOT_A_CLAIM = /^\W*(?:if|once|when|after|until|unless|according to)\b|\bautomatically\b/i;
// A first-person claim in the simple past or about before ("I sent Gabe the
// roadmap", "I've sent it earlier") reports on what was done, which an
// earlier turn's recorded result can back; "I've sent it" says this turn did.
const EARLIER = /\b(?:earlier|already|previously|before|yesterday|ago)\b/i;
const PERFECT = /['’]ve\b|\bhave\b/i;
// "I said I sent it" repeats an earlier claim, usually to correct it.
const REPORTED_SPEECH = /\b(?:said|claimed|told\s+you|mentioned|wrote|stated)\s+(?:that\s+)?$/i;
// "Did you send it?" asks about what was done, so the answer reports on it.
// A question only, and only about something done: "Have a look and send it"
// or "Is it possible to post this?" asks for a new action.
const ASKS_IF_DONE =
  /^\W*(?:(?:and|so)\s+)?(?:(?:did|have|has)\s+(?:you|it|that|this|they)\b|(?:was|were|is)\s+(?:it|that|this|they|the\s+\w+)\s+(?:already\s+|actually\s+|really\s+)?(?:sent|posted|emailed|created|filed|done|saved|connected|drafted)\b)[^\n]*\?\s*$/i;

// What the reply writes for the user isn't its own voice: fenced code,
// blockquotes, quoted spans, a message from its subject line or a greeting on
// a line of its own ("Subject: …", "Hi Sam,"), and what follows a colon whose
// lead-in introduces a draft ("Here's a reply:", "Translation:"). "Here's what
// I did:" doesn't. A greeting that opens a line of text ("Hi team, I've sent
// …"), or the reply itself, starts a message only when the user asked for one
// to be written: the reply may greet the user that way too ("Hi Chad, I've
// sent it", "Hi Chad!" on its own line).
const FENCED = /```[\s\S]*?(?:```|$)/g;
const BLOCKQUOTE = /^[ \t]*>.*$/gm;
const QUOTED = /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|„[^“”\n]*[“”]/g;
const GREETING = String.raw`(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))\b[^\n,!.?:]{0,40}[,!]`;
const DRAFT_START = new RegExp(String.raw`^[ \t]*(?:${GREETING}[ \t]*$|subject\s*:)`, "im");
const GREETING_START = new RegExp(String.raw`^[ \t]*${GREETING}`, "im");
const ASKS_TO_WRITE = /\b(?:write|draft|compose|rewrite|reword)\b/i;
const DRAFT_LEAD_IN =
  /\b(?:drafts?|repl(?:y|ies)|messages?|emails?|texts?|notes?|versions?|translations?|rewrites?|below|here\s+you\s+go)\b/i;

// A bare English translation can say "I sent" in the source author's voice.
// Require an actual translation request, and keep checking combined requests
// such as "translate this, then send it": those still promise tool actions.
const TRANSLATE_REQUEST =
  /^\s*(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?translate\b(?:\s+(?:this|that|the)\s+(?:email|message|post|file|comment|draft)\b)?(?:[^:;.!?,&\n]*?\b(?:to|into)\s+English\b)?/i;
const TRANSLATION_ACTION =
  /\b(?:send|email|message|post|create|file|comment|connect|save|draft|delete|forward|tell)\b/i;

function asksOnlyForTranslation(text: string): boolean {
  const instructions = text.replace(QUOTED, "");
  const translation = TRANSLATE_REQUEST.exec(instructions);
  if (!translation) return false;
  // The directive may name the source ("this email into English"). Anything
  // else asking for an action keeps the check, regardless of clause wording.
  return (
    !/\b(?:and|then|also)\b|&/i.test(translation[0]) &&
    !TRANSLATION_ACTION.test(instructions.slice(translation[0].length))
  );
}

function draftStart(text: string, askedToWrite: boolean): number | null {
  const ownLine = DRAFT_START.exec(text);
  if (askedToWrite) return (ownLine ?? GREETING_START.exec(text))?.index ?? null;
  if (!ownLine) return null;
  const opensReply = !text.slice(0, ownLine.index).trim();
  return opensReply && !/^\s*subject/i.test(ownLine[0]) ? null : ownLine.index;
}

function ownWords(text: string, askedToWrite: boolean): string {
  const quoted = text.replace(FENCED, "\n").replace(BLOCKQUOTE, "").replace(QUOTED, '""');
  const draft = draftStart(quoted, askedToWrite);
  const plain = draft === null ? quoted : quoted.slice(0, draft);
  for (const colon of plain.matchAll(/:[*_]*(?=\s|$)/g)) {
    const leadIn =
      plain
        .slice(0, colon.index)
        .split(/[.!?\n]/)
        .at(-1) ?? "";
    if (DRAFT_LEAD_IN.test(leadIn)) return plain.slice(0, colon.index + colon[0].length);
  }
  return plain;
}

// Lowercase words only, so a claim is found in the user's or a tool's text
// whatever the punctuation or contraction.
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/'ve\b/g, " have")
    .replace(/[^\w\s#@'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

interface Claim {
  kind: ClaimKind;
  /** A report on what was done, which an earlier turn's result can back. */
  report: boolean;
  /** The person or channel it names ("to Gabe", "in #eng"), if any. */
  destination: string | null;
  /** The claim with the words after it, to find it in the user's or a tool's text. */
  phrase: string;
}

const DESTINATION = /\bto\s+(#[\w-]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|[A-Z][\w'’-]*)|\bin\s+(#[\w-]+)/;
// "Posted it to Slack" names where, not whom.
const SERVICE = /^(?:slack|gmail|outlook|linear|github|email)$/i;

const FORMS: ReadonlyArray<[RegExp, "first" | "report" | "sentTo"]> = [
  [FIRST_PERSON, "first"],
  [REPORT, "report"],
  [SENT_TO, "sentTo"],
];

function claimsIn(text: string, askedToWrite: boolean): Claim[] {
  const claims: Claim[] = [];
  for (const sentence of ownWords(text, askedToWrite).split(/(?<=[.!?])\s+|\n+/)) {
    if (sentence.trim().endsWith("?")) continue;
    for (const [pattern, form] of FORMS) {
      for (const match of sentence.matchAll(pattern)) {
        const verb = match[1].toLowerCase();
        const kind = KIND_OF_VERB.get(verb);
        const end = match.index + match[0].length;
        const clauseEnd = sentence.slice(end).search(/[,;]/);
        const upToClause = sentence.slice(0, clauseEnd === -1 ? undefined : end + clauseEnd);
        if (!kind || upToClause.split(/[,;]/).some((clause) => NOT_A_CLAIM.test(clause))) continue;
        if (form === "first" && REPORTED_SPEECH.test(sentence.slice(0, match.index))) continue;
        if (verb === "created" && !CREATED_OBJECT.test(sentence)) continue;
        if (kind === "save" && !SAVED_OBJECT.test(sentence)) continue;
        const after = sentence.slice(end).trim().split(/\s+/);
        const found = DESTINATION.exec(sentence);
        const destination = found ? (found[1] ?? found[2]) : null;
        claims.push({
          kind,
          report:
            form === "report" ||
            (form === "first" && (EARLIER.test(sentence) || !PERFECT.test(match[0]))),
          destination: destination && !SERVICE.test(destination) ? destination : null,
          phrase: normalize([match[0], ...after.slice(0, 3)].join(" ")),
        });
      }
    }
  }
  return claims;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

function argumentText(call: ToolCallInfo): string[] {
  try {
    return stringsIn(JSON.parse(call.arguments));
  } catch {
    return [];
  }
}

// An earlier result backs a report that names someone only if it went there.
function wentTo(call: ToolCallInfo, destination: string | null): boolean {
  const label = call.metadata && !Array.isArray(call.metadata) ? call.metadata.destination : null;
  if (!destination || typeof label !== "string") return true;
  const [named, sent] = [destination.toLowerCase(), label.toLowerCase()];
  return sent.includes(named) || named.includes(sent);
}

export interface ClaimContext {
  /** Calls of this turn, not ones a regenerate carried over. */
  turnCalls: ReadonlyArray<ToolCallInfo>;
  /** Calls recorded for earlier turns, and those a regenerate carried over. */
  earlierCalls: ReadonlyArray<ToolCallInfo>;
  /** Whether this conversation offers the tool. */
  isOffered: (toolName: string) => boolean;
  /** The user's request and the text they selected. */
  request: { text: string; selectedText?: string };
}

/**
 * The final answer claims, in its own voice, an action of a kind a tool here
 * can do, and no result backs it. Any claim is backed by a call of its kind in
 * this turn; a report ("it was sent", or any claim answering "did you send
 * it?") also by one recorded for an earlier turn, which went to whoever it
 * names. A claim whose words are the user's (their request or selection) or a
 * tool call's payload is no claim.
 */
export function isUnbackedClaim(
  text: string,
  { turnCalls, earlierCalls, isOffered, request }: ClaimContext
): boolean {
  // Claims sit in short replies, and the matching runs on the renderer's main
  // thread: a long one is left alone rather than blocking the chat.
  if (text.length > MAX_CHECKED_CHARS) return false;
  if (asksOnlyForTranslation(request.text)) return false;
  const theirWords = normalize(
    [request.text, request.selectedText ?? "", ...turnCalls.flatMap(argumentText)].join("\n")
  );
  const asksIfDone = ASKS_IF_DONE.test(request.text);
  return claimsIn(text, ASKS_TO_WRITE.test(request.text)).some(
    ({ kind, report, destination, phrase }) => {
      const { tools, did } = KINDS[kind];
      if (!tools.some(isOffered) || theirWords.includes(phrase)) return false;
      if (turnCalls.some((call) => tools.includes(call.name) && did(call))) return false;
      return (
        !(report || asksIfDone) ||
        !earlierCalls.some(
          (call) => tools.includes(call.name) && did(call) && wentTo(call, destination)
        )
      );
    }
  );
}
