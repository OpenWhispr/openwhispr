function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

function maxEditsForLength(len: number): number {
  if (len <= 4) return 0;
  if (len <= 6) return 1;
  return 2;
}

const VOCATIVE_CUES = new Set(["hey", "hi", "hello", "ok", "okay", "yo", "please"]);

// The name only counts as addressing the agent when it starts the dictation,
// follows a greeting cue ("hey Jarvis"), or opens a new sentence. A mere
// mention elsewhere ("I showed OpenWhispr to a friend") is dictated content,
// not a command.
function isAddressedAt(index: number, words: string[], rawWords: string[]): boolean {
  if (index === 0) return true;
  if (VOCATIVE_CUES.has(words[index - 1])) return true;
  return /[.!?…]["')\]]*$/.test(rawWords[index - 1]);
}

export function detectAgentName(transcript: string, agentName: string): boolean {
  const name = agentName.trim();
  if (!name || name.length < 2) return false;

  const nameLower = name.toLowerCase().replace(/\s+/g, "");
  const rawWords = transcript.split(/\s+/).filter(Boolean);
  const words = rawWords.map((w) => w.replace(/[.,!?;:'"()]/g, "").toLowerCase());

  const maxEdits = maxEditsForLength(nameLower.length);
  // STT may split the name across tokens ("open whispr") or mishear it, so
  // compare joined windows up to the name's own token count (minimum 2)
  // against the name, allowing length-scaled edits.
  const maxSpan = Math.max(2, name.split(/\s+/).length);

  for (let i = 0; i < words.length; i++) {
    let joined = "";
    for (let span = 0; span < maxSpan && i + span < words.length; span++) {
      joined += words[i + span];
      if (Math.abs(joined.length - nameLower.length) > maxEdits) continue;
      if (levenshteinDistance(joined, nameLower) <= maxEdits && isAddressedAt(i, words, rawWords)) {
        return true;
      }
    }
  }

  return false;
}
