import type { ProcessingMode, UserConfig } from '@/types';

const DEFAULT_AGENT_NAME = 'OpenWhispr';

export function getDictationAgentName(config: UserConfig): string {
  const name = config.dictationAgentName?.trim();
  return name || DEFAULT_AGENT_NAME;
}

export function isDictationAgentEnabled(config: UserConfig): boolean {
  return config.dictationAgentEnabled ?? true;
}

export function isDictationAgentApplicable(mode: ProcessingMode, config: UserConfig): boolean {
  return mode === 'cloud' && isDictationAgentEnabled(config);
}

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

// Port of openwhispr-api/lib/prompts.ts detectAgentName (lines 68–111).
// Three layers ensure client detection agrees with server Action Mode detection:
//   1. Exact word-boundary regex (handles name with spaces via regex escaping)
//   2. Space-normalized pair join (STT splitting compound names, e.g. "Open Whispr")
//   3. Levenshtein fuzzy match on individual words and adjacent pairs, with edits
//      scaled by name length so short names require exact matches.
export function detectAgentMention(text: string, name: string): boolean {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length < 2) return false;

  const escaped = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) return true;

  const nameLower = trimmedName.toLowerCase().replace(/\s+/g, '');
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/[.,!?;:'"()]/g, '').toLowerCase())
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
