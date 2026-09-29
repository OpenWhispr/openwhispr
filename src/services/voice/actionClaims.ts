// English only, like the rest of v1 voice. Completed-action claims "I did X", matched only
// at answer start or after a clause boundary (`.!?,;`, a dash or an ellipsis, then a
// space), optionally after a lead-in word ("Okay", "and", "but"…), a "think"/"believe"
// hedge and adverbs (just, already, now, gone ahead and…). Offers ("I can add…", "I'll
// check…"), conditions ("If I've updated…") and questions don't start a clause that way,
// so they stay non-claims. "I made sure", "I made a mistake" and "I noted that…" are not
// actions. Passive forms ("It's saved") are left out: they are just as often a true
// answer about something that already exists.
const ACTION_CLAIM =
  /(^|[.!?;,…—–]\s+)(?:(?:ok(?:ay)?|sure|done|alright|yes|yep|great|and|but|so|then)\s+)?((?:I\s+(?:think|believe)\s+)?I(?:['’]ve| have)?\s+(?:(?:just|already|also|now|successfully|gone\s+ahead\s+and)\s+)*(?:added|created|made(?!\s+(?:sure|a\s+mistake|an\s+error)\b)|copied|saved|updated|changed|moved|removed|deleted|put|noted(?!\s+that\b)|wrote|written|scheduled|booked|sent|set)\b)/i;

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

// Only this turn's writes are known, so a true recap of an earlier one ("I saved it a
// moment ago", "I already added that earlier") would read as unbacked. A sentence that
// points back in time is left alone; the cost is that a false claim phrased as a recap
// goes uncorrected.
const RECAP = /\b(?:already|earlier|previously|ago|last time)\b/i;
const SENTENCE_BREAK = /(?<=[.!?…])\s+/;

export const UNBACKED_CLAIM_CORRECTION = "Sorry, I didn't actually do that. Want me to try again?";

/** The claim text when the answer says an action happened but no write succeeded this turn. */
export function findUnbackedActionClaim(
  answer: string,
  succeededWrites: readonly string[]
): string | null {
  if (succeededWrites.length > 0) return null;
  for (const sentence of withoutReadBack(answer).split(SENTENCE_BREAK)) {
    const match = sentence.match(ACTION_CLAIM);
    // Group 2 is the "I…" claim, without the clause boundary in group 1.
    if (match && !RECAP.test(sentence)) return match[2];
  }
  return null;
}
