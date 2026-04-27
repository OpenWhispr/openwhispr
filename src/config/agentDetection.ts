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

export function detectAgentName(transcript: string, agentName: string): boolean {
  const name = agentName.trim();
  if (!name || name.length < 2) return false;

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${escaped}\\b`, "i").test(transcript)) return true;

  const nameLower = name.toLowerCase().replace(/\s+/g, "");
  const words = transcript
    .split(/\s+/)
    .map((w) => w.replace(/[.,!?;:'"()]/g, "").toLowerCase())
    .filter(Boolean);

  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] + words[i + 1] === nameLower) return true;
  }

  const maxEdits = maxEditsForLength(nameLower.length);
  if (maxEdits === 0) return false;

  for (const word of words) {
    if (
      Math.abs(word.length - nameLower.length) <= maxEdits &&
      levenshteinDistance(word, nameLower) <= maxEdits
    ) {
      return true;
    }
  }

  for (let i = 0; i < words.length - 1; i++) {
    const combined = words[i] + words[i + 1];
    if (
      Math.abs(combined.length - nameLower.length) <= maxEdits &&
      levenshteinDistance(combined, nameLower) <= maxEdits
    ) {
      return true;
    }
  }

  return false;
}
