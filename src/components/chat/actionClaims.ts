import type { ToolCallInfo } from "./types";

// What a final answer claims to have done, in English only: a reply in another
// language never matches, so it is shown as written, never asked again or
// flagged. Every claim is in the first person or the passive perfect ("I've
// sent", "has been posted", "Email sent"); a plan, an offer or a negation ("I
// can send it", "I haven't sent it") never is.
const DONE =
  "sent|emailed|messaged|texted|posted|replied|forwarded|filed|commented|scheduled|booked|connected|prompted";
// These also describe text written in the reply itself ("I've updated the
// wording"), so they count only with something a tool changes close after.
const CHANGED = "created|drafted|saved|updated|edited|added|removed|deleted|moved|renamed";
const CHANGED_TARGETS =
  "notes?|dictionary|snippets?|calendar|events?|meetings?|invites?|invitations?|issues?|tickets?|reminders?|tasks?|folders?|contacts?|emails?|drafts?";
const FIRST_PERSON = String.raw`\bI(?:'ve|’ve| have)?\s+(?:(?:just|now|also|successfully|(?:gone|went) ahead and)\s+)*`;
const CLAIMS = [
  new RegExp(String.raw`${FIRST_PERSON}(?:${DONE})\b`, "i"),
  new RegExp(
    String.raw`${FIRST_PERSON}(?:${CHANGED})(?:\s+\S+){0,5}?\s+(?:${CHANGED_TARGETS})\b`,
    "i"
  ),
  new RegExp(
    String.raw`\b(?:has|have)\s+(?:(?:now|just|successfully)\s+)?been\s+(?:${DONE}|created|drafted|saved|deleted)\b`,
    "i"
  ),
  /^\W*(?:email|message|reply|comment|issue|note|invite|draft)\s+(?:sent|posted|created|filed|saved|scheduled)\b/i,
];
// A sentence about an earlier turn ("I sent it earlier") or a question isn't
// this turn's claim.
const EARLIER =
  /\b(?:earlier|previously|before|already|yesterday|ago|last (?:time|turn|message|reply))\b/i;
// A model imitating the [Tools used: …] notes of a text history.
const ECHOED_TRACE = "[Tools used:";

/** The text claims an action was done (or echoes a tool note). */
export function claimsAction(text: string): boolean {
  if (text.includes(ECHOED_TRACE)) return true;
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .some(
      (sentence) =>
        !sentence.trim().endsWith("?") &&
        !EARLIER.test(sentence) &&
        CLAIMS.some((claim) => claim.test(sentence))
    );
}

// A connector action that happened, or may have.
const ACTION_DONE = new Set(["sent", "draft_opened", "unknown", "already_sent"]);
// What the user did on a card: connected a service, saved a key, granted access.
const INTERACTION_DONE = new Set(["connected", "saved", "granted"]);

/**
 * A call of this turn that did something a claim can describe: a connector
 * action that went out (or may have), a finished connection or saved key, or
 * a tool that changes something (a note, the dictionary, the clipboard).
 * Lookups back no claim.
 */
export function backsActionClaim(call: ToolCallInfo, readOnly: boolean): boolean {
  if (call.status !== "completed") return false;
  const status = call.metadata && !Array.isArray(call.metadata) ? call.metadata.status : undefined;
  if (typeof status === "string") return ACTION_DONE.has(status);
  const result = call.interaction?.result;
  if (result) {
    return (
      INTERACTION_DONE.has(result.status) || (result.status === "done" && result.ready !== false)
    );
  }
  return !readOnly;
}
