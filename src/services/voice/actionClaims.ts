// English only, like the rest of v1 voice. Completed-action claims "I did X" with optional
// hedges (just, already, also, now, successfully, gone ahead and). Matches only at answer
// start or after a clause boundary (punctuation + space: `.!?,;`). Excludes "I made sure"
// (negative lookahead after "made"). Offers ("I can add…", "I'll check…"), conditions
// ("If I've updated…"), and questions stay non-claims: they don't start a clause or use
// the "made sure" escape hatch, so the regex won't match them.
const ACTION_CLAIM =
  /(^|[.!?;,]\s+)(I(?:'ve| have)?\s+(?:just\s+|already\s+|also\s+|now\s+|successfully\s+|gone\s+ahead\s+and\s+)?(?:added|created|made(?!\s+sure\b)|copied|saved|updated|changed|moved|removed|deleted)\b)/i;

// Reading a note or snippet back quotes the user's own first-person words ("Your standup
// note says: I finished the report, I updated the tests"); those are not the assistant's
// claims. Quoted spans are dropped: double quotes always, single quotes only when they open
// after whitespace and close before whitespace or punctuation, so the apostrophe in "I've"
// never starts one.
const QUOTED_SPANS = /"[^"]*"|“[^”]*”|(?<=^|[\s([])['‘](?=\S).*?(?<=\S)['’](?=$|[\s.,!?;:)\]])/g;
// Everything after a colon that introduces content ("says: …", "Here's your snippet: …")
// is read-back, so it is ignored. The cost: "Done: I added it" goes uncorrected.
const READ_BACK_LEAD_IN = /:(?=\s|["“'‘]|$)/;

function withoutReadBack(answer: string): string {
  const unquoted = answer.replace(QUOTED_SPANS, " ");
  const leadIn = unquoted.search(READ_BACK_LEAD_IN);
  return leadIn === -1 ? unquoted : unquoted.slice(0, leadIn);
}

export const UNBACKED_CLAIM_CORRECTION = "Sorry, I didn't actually do that. Want me to try again?";

/** The claim text when the answer says an action happened but no write succeeded this turn. */
export function findUnbackedActionClaim(
  answer: string,
  succeededWrites: readonly string[]
): string | null {
  if (succeededWrites.length > 0) return null;
  const match = withoutReadBack(answer).match(ACTION_CLAIM);
  // Return group 2 (the I... part), stripping the boundary (group 1)
  return match?.[2] ?? null;
}
