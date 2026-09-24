// English only, like the rest of v1 voice. Past-tense "I did X" claims; offers
// ("I can add…", "I'll check…") and questions are not claims.
const ACTION_CLAIM =
  /\bI(?:'ve| have)?\s+(?:added|created|made|copied|saved|updated|changed|moved|removed|deleted)\b/i;

export const UNBACKED_CLAIM_CORRECTION = "Sorry, I didn't actually do that. Want me to try again?";

/** The claim text when the answer says an action happened but no write succeeded this turn. */
export function findUnbackedActionClaim(
  answer: string,
  succeededWrites: readonly string[]
): string | null {
  if (succeededWrites.length > 0) return null;
  return answer.match(ACTION_CLAIM)?.[0] ?? null;
}
