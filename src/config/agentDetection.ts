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

const WAKE_WORDS = new Set(["hey", "hi", "ok", "okay", "yo"]);

function normalizeWords(transcript: string): string[] {
  return transcript
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[("'[\]]+|[)"'[\].,!?;:]+$/g, "").toLowerCase())
    .filter(Boolean);
}

function nameKey(agentName: string): string {
  return agentName.trim().toLowerCase().replace(/\s+/g, "");
}

function matchesExactName(candidate: string, key: string): boolean {
  return candidate === key;
}

function matchesFuzzyName(candidate: string, key: string): boolean {
  const maxEdits = maxEditsForLength(key.length);
  if (maxEdits === 0) return false;
  if (Math.abs(candidate.length - key.length) > maxEdits) return false;
  return levenshteinDistance(candidate, key) <= maxEdits;
}

function matchesNameToken(candidate: string, key: string, allowFuzzy: boolean): boolean {
  if (matchesExactName(candidate, key)) return true;
  return allowFuzzy && matchesFuzzyName(candidate, key);
}

function consumeAgentName(
  words: string[],
  startIdx: number,
  key: string,
  allowFuzzy: boolean
): number | null {
  if (startIdx >= words.length) return null;

  const first = words[startIdx];
  if (matchesNameToken(first, key, allowFuzzy)) return startIdx + 1;

  if (startIdx + 1 < words.length) {
    const combined = first + words[startIdx + 1];
    if (matchesExactName(combined, key)) return startIdx + 2;
    if (allowFuzzy && matchesFuzzyName(combined, key)) return startIdx + 2;
  }

  return null;
}

function scanAddressingSegment(words: string[], segmentStart: number, key: string): boolean {
  let index = segmentStart;
  let usedWake = false;

  if (index < words.length && WAKE_WORDS.has(words[index])) {
    usedWake = true;
    index++;
  }

  const nameEnd = consumeAgentName(words, index, key, usedWake);
  if (nameEnd === null) return false;

  // Wake-word invocations are explicit enough on their own.
  if (usedWake) return true;

  // Name-first invocations must include a command after the name.
  return nameEnd < words.length;
}

// Voice Agent routing requires the agent to be addressed, not merely mentioned.
// Fuzzy matching is limited to wake-word invocations so STT mishearings still work
// without treating unrelated words ("whisper", "area", …) as wake words.
export function detectAgentName(transcript: string, agentName: string): boolean {
  const name = agentName.trim();
  if (!name || name.length < 2) return false;

  const text = transcript.trim();
  if (!text) return false;

  const key = nameKey(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wakePattern = new RegExp(
    `(^|[.!?]\\s+)(?:hey|hi|ok(?:ay)?|yo)\\s+${escaped}\\b`,
    "i"
  );
  if (wakePattern.test(text)) return true;

  for (const segment of text.split(/(?<=[.!?])\s+/)) {
    const words = normalizeWords(segment);
    if (words.length === 0) continue;
    if (scanAddressingSegment(words, 0, key)) return true;
  }

  return false;
}
