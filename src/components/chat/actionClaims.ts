import type { ToolCallInfo } from "./types";
import { TRACE_OPENING, connectsFirst } from "./historyMessages";

// What a final answer says was done, in English only: a reply in another
// language never matches, so it is shown as written, never asked again or
// flagged. A plan, an offer, a question or a negation ("I can send it", "I
// haven't sent it") is never a claim, and neither is text the reply drafts or
// quotes for the user (ownWords).
const DONE =
  "sent|emailed|messaged|texted|posted|replied|forwarded|filed|commented|scheduled|booked|connected|prompted";
// These also describe text written in the reply itself ("I've updated the
// wording"), so they count only with something a tool changes close after.
const CHANGED = "created|drafted|saved|updated|edited|added|removed|deleted|moved|renamed";
const CHANGED_TARGETS =
  "notes?|dictionary|snippets?|calendar|events?|meetings?|invites?|invitations?|issues?|tickets?|reminders?|tasks?|folders?|contacts?|emails?|drafts?";
// Passives that report a delivery or a save ("it was sent", "it's been
// posted"), not one done by someone else ("sent by Sarah"). "Connected" only
// in the perfect: "Gmail is connected" describes a state.
const PASSIVE_DONE = "sent|emailed|posted|forwarded|filed|delivered|saved|deleted";
const ADVERBS = String.raw`(?:(?:just|now|also|already|successfully|(?:gone|went) ahead and)\s+)*`;
const CHANGED_OBJECT = String.raw`(?:\s+\S+){0,5}?\s+(?:${CHANGED_TARGETS})\b`;
const NOT_BY = String.raw`(?![^.!?\n]*\bby\b)`;

// `recalled`: it reports what was done ("I sent it", "it was sent") rather
// than saying this turn did it ("I've sent it", "Email sent!"). `changed`:
// one of the CHANGED verbs.
const CLAIMS: ReadonlyArray<{ pattern: RegExp; recalled?: true; changed?: true }> = [
  { pattern: new RegExp(String.raw`\bI(?:'ve|’ve| have)\s+${ADVERBS}(${DONE})\b`, "gi") },
  {
    pattern: new RegExp(
      String.raw`\bI(?:'ve|’ve| have)\s+${ADVERBS}(${CHANGED})${CHANGED_OBJECT}`,
      "gi"
    ),
    changed: true,
  },
  {
    pattern:
      /^\W*(?:email|message|reply|comment|issue|note|invite|draft)\s+(sent|posted|created|filed|saved|scheduled)\b/gi,
  },
  { pattern: new RegExp(String.raw`\bI\s+${ADVERBS}(${DONE})\b`, "gi"), recalled: true },
  {
    pattern: new RegExp(String.raw`\bI\s+${ADVERBS}(${CHANGED})${CHANGED_OBJECT}`, "gi"),
    recalled: true,
    changed: true,
  },
  {
    pattern: new RegExp(
      String.raw`(?:\b(?:was|were|(?:has|have)\s+been)|\b(?:it|that|this|everything)['’]s\s+been)\s+${ADVERBS}(${PASSIVE_DONE}|connected)\b${NOT_BY}`,
      "gi"
    ),
    recalled: true,
  },
  {
    pattern: new RegExp(
      String.raw`(?:\b(?:is|are)|\b(?:it|that|this|everything)['’]s)\s+${ADVERBS}(${PASSIVE_DONE})\b${NOT_BY}`,
      "gi"
    ),
    recalled: true,
  },
];
// A claim about before ("I sent it earlier", "I've already sent it") reports
// on what was done, which an earlier turn's recorded result can back.
const EARLIER =
  /\b(?:earlier|previously|before|already|yesterday|ago|last (?:time|turn|message|reply))\b/i;

// What the reply writes or quotes for the user (a draft, a rewrite, a quote)
// isn't the reply speaking for itself: fenced code, blockquotes, quoted
// spans, everything from a lead-in ("Here's a reply:", "Draft:") on, and
// what follows a line ending in a colon ("I've drafted it below:").
const FENCED = /```[\s\S]*?(?:```|$)/g;
const BLOCKQUOTE = /^[ \t]*>.*$/gm;
const QUOTED = /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|„[^“”\n]*[“”]/g;
const LEAD_IN =
  /\bhere(?:'s|’s| is| are)\b[^:\n]*:|^[ \t]*[*_]*(?:suggested |rewritten |revised )?(?:draft|reply|rewrite|version|response)[*_]*[ \t]*:/im;
const ENDS_IN_COLON = /:[*_]*[ \t]*$/m;

function ownWords(text: string): string {
  const plain = text.replace(FENCED, "\n").replace(BLOCKQUOTE, "").replace(QUOTED, '""');
  const leadIn = LEAD_IN.exec(plain);
  const colon = ENDS_IN_COLON.exec(plain);
  if (colon && (!leadIn || colon.index < leadIn.index)) return plain.slice(0, colon.index + 1);
  return leadIn ? plain.slice(0, leadIn.index) : plain;
}

/**
 * "new": the reply says this turn did it, so only this turn's tool results
 * can back it. "recalled": it reports what was done, which an earlier turn's
 * recorded result can back too.
 */
export type ActionClaim = "new" | "recalled";

/**
 * What the reply claims was done, if anything. A verb the user's own text
 * already has (`source`) is theirs, as in a rewrite of "I have emailed the
 * client"; a sentence that introduces a draft ("I've created a summary:")
 * claims only a delivery.
 */
export function claimedAction(text: string, source = ""): ActionClaim | null {
  if (text.includes(TRACE_OPENING)) return "new";
  let claim: ActionClaim | null = null;
  for (const sentence of ownWords(text).split(/(?<=[.!?])\s+|\n+/)) {
    const trimmed = sentence.trim();
    if (trimmed.endsWith("?")) continue;
    const introducesDraft = /:[*_]*$/.test(trimmed);
    const earlier = EARLIER.test(sentence);
    for (const { pattern, recalled, changed } of CLAIMS) {
      if (changed && introducesDraft) continue;
      for (const [, verb] of sentence.matchAll(pattern)) {
        if (new RegExp(String.raw`\b${verb}\b`, "i").test(source)) continue;
        if (!recalled && !earlier) return "new";
        claim = "recalled";
      }
    }
  }
  return claim;
}

export interface ClaimContext {
  /** Calls of this turn, not ones a regenerate carried over. */
  turnCalls: ReadonlyArray<ToolCallInfo>;
  /** Calls recorded for earlier turns, and those a regenerate carried over. */
  earlierCalls: ReadonlyArray<ToolCallInfo>;
  isReadOnly: (toolName: string) => boolean;
  /** The user's request and the text they selected, whose words a reply may write for them. */
  request: { text: string; selectedText?: string };
}

// The user's own words a reply may repeat: what they selected, what they
// quoted, and what their request asks to be said ("say I've posted it").
function userText({ text, selectedText = "" }: ClaimContext["request"]): string {
  const asked = CLAIMS.flatMap(({ pattern }) =>
    [...text.matchAll(pattern)].map(([, verb]) => verb)
  );
  return [selectedText, ...(text.match(QUOTED) ?? []), ...asked].join("\n");
}

/**
 * The final answer claims an action no tool result backs: a new claim needs
 * one from this turn, a recalled one any recorded one.
 */
export function isUnbackedClaim(
  text: string,
  { turnCalls, earlierCalls, isReadOnly, request }: ClaimContext
): boolean {
  const claim = claimedAction(text, userText(request));
  if (!claim) return false;
  const backed = (calls: ReadonlyArray<ToolCallInfo>) =>
    calls.some((call) => backsActionClaim(call, isReadOnly(call.name)));
  return !backed(turnCalls) && (claim === "new" || !backed(earlierCalls));
}

// A connector action that happened, or may have.
const ACTION_DONE = new Set(["sent", "draft_opened", "unknown", "already_sent"]);
// What the user did on a card: connected a service, saved a key, granted access.
const INTERACTION_DONE = new Set(["connected", "saved", "granted"]);

/**
 * A call that did something a claim can describe: a connector
 * action that went out (or may have), a finished connection or saved key, or
 * a tool that changes something (a note, the dictionary, the clipboard).
 * Lookups back no claim.
 */
export function backsActionClaim(call: ToolCallInfo, readOnly: boolean): boolean {
  if (call.status !== "completed") return false;
  // An interaction's result also sits in its metadata ("connected", "saved"),
  // so the card's answer is read first; a send that connected first is judged by the send.
  if (call.interaction && !connectsFirst(call)) {
    const result = call.interaction.result;
    return (
      !!result &&
      (INTERACTION_DONE.has(result.status) || (result.status === "done" && result.ready !== false))
    );
  }
  const status = call.metadata && !Array.isArray(call.metadata) ? call.metadata.status : undefined;
  if (typeof status === "string") return ACTION_DONE.has(status);
  return !readOnly;
}
