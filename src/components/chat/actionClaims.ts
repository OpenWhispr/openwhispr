import type { ToolCallInfo } from "./types";

// A narrow safety net for a final answer that says something was done when no
// tool did it. It errs towards silence: a "not done" note on a truthful reply
// is worse than a missed claim. English only: a reply in another language
// never matches, so it is shown as written, never asked again or flagged.

type ClaimKind = "send" | "draft" | "create" | "connect" | "save";

const WENT_OUT = new Set(["sent", "unknown", "already_sent"]);

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
    verbs: "sent|emailed|messaged|posted",
    tools: ["email_draft", "slack_send_message", "linear_comment", "github_comment"],
    did: wentOut,
  },
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

// What the reply writes for the user isn't its own voice: fenced code,
// blockquotes, quoted spans, and what follows a colon whose lead-in introduces
// a draft ("Here's a reply:", "Translation:"). "Here's what I did:" doesn't.
const FENCED = /```[\s\S]*?(?:```|$)/g;
const BLOCKQUOTE = /^[ \t]*>.*$/gm;
const QUOTED = /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|„[^“”\n]*[“”]/g;
const DRAFT_LEAD_IN =
  /\b(?:drafts?|repl(?:y|ies)|messages?|emails?|texts?|notes?|versions?|translations?|rewrites?|below)\b/i;

function ownWords(text: string): string {
  const plain = text.replace(FENCED, "\n").replace(BLOCKQUOTE, "").replace(QUOTED, '""');
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

const FORMS: ReadonlyArray<[RegExp, "first" | "report" | "sentTo"]> = [
  [FIRST_PERSON, "first"],
  [REPORT, "report"],
  [SENT_TO, "sentTo"],
];

function claimsIn(text: string): Claim[] {
  const claims: Claim[] = [];
  for (const sentence of ownWords(text).split(/(?<=[.!?])\s+|\n+/)) {
    if (sentence.trim().endsWith("?")) continue;
    for (const [pattern, form] of FORMS) {
      for (const match of sentence.matchAll(pattern)) {
        const verb = match[1].toLowerCase();
        const kind = KIND_OF_VERB.get(verb);
        const end = match.index + match[0].length;
        const clauseEnd = sentence.slice(end).search(/[,;]/);
        const upToClause = sentence.slice(0, clauseEnd === -1 ? undefined : end + clauseEnd);
        if (!kind || upToClause.split(/[,;]/).some((clause) => NOT_A_CLAIM.test(clause))) continue;
        if (verb === "created" && !CREATED_OBJECT.test(sentence)) continue;
        if (kind === "save" && !SAVED_OBJECT.test(sentence)) continue;
        const after = sentence.slice(end).trim().split(/\s+/);
        const destination = DESTINATION.exec(sentence);
        claims.push({
          kind,
          report:
            form === "report" ||
            (form === "first" && (EARLIER.test(sentence) || !PERFECT.test(match[0]))),
          destination: destination ? (destination[1] ?? destination[2]) : null,
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
// A Slack DM sent by its id is labelled without whose it is (slackConnector's
// "Direct message (D…)"), so it backs a report naming any person.
function wentTo(call: ToolCallInfo, destination: string | null): boolean {
  const label = call.metadata && !Array.isArray(call.metadata) ? call.metadata.destination : null;
  if (!destination || typeof label !== "string") return true;
  if (label.startsWith("Direct message (")) return !destination.startsWith("#");
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
 * this turn; a report ("it was sent") also by one recorded for an earlier
 * turn, which went to whoever it names. A claim whose words are the user's
 * (their request or selection) or a tool call's payload is no claim.
 */
export function isUnbackedClaim(
  text: string,
  { turnCalls, earlierCalls, isOffered, request }: ClaimContext
): boolean {
  const theirWords = normalize(
    [request.text, request.selectedText ?? "", ...turnCalls.flatMap(argumentText)].join("\n")
  );
  return claimsIn(text).some(({ kind, report, destination, phrase }) => {
    const { tools, did } = KINDS[kind];
    if (!tools.some(isOffered) || theirWords.includes(phrase)) return false;
    if (turnCalls.some((call) => tools.includes(call.name) && did(call))) return false;
    return (
      !report ||
      !earlierCalls.some(
        (call) => tools.includes(call.name) && did(call) && wentTo(call, destination)
      )
    );
  });
}
