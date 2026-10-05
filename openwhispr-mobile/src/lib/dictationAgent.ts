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
  return (mode === 'cloud' || mode === 'providers') && isDictationAgentEnabled(config);
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

const VOCATIVE_CUES = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'please']);

// The name only addresses the agent when it starts the dictation, follows a
// greeting cue ("hey Jarvis"), or opens a new sentence. A mere mention elsewhere
// ("I showed OpenWhispr to a friend") is dictated content, not a command.
function isAddressedAt(index: number, words: string[], rawWords: string[]): boolean {
  if (index === 0) return true;
  if (VOCATIVE_CUES.has(words[index - 1])) return true;
  return /[.!?…]["')\]]*$/.test(rawWords[index - 1]);
}

// Port of openwhispr-api/lib/prompts.ts detectAgentName, so the client and the
// server agree on Action Mode. STT may split the name across tokens ("open
// whispr") or mishear it, so joined windows up to the name's own token count
// (minimum 2) are compared with edits scaled by name length.
export function detectAgentMention(text: string, name: string): boolean {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length < 2) return false;

  const nameLower = trimmedName.toLowerCase().replace(/\s+/g, '');
  const rawWords = text.split(/\s+/).filter(Boolean);
  const words = rawWords.map((word) => word.replace(/[.,!?;:'"()]/g, '').toLowerCase());
  const maxEdits = maxEditsForLength(nameLower.length);
  const maxSpan = Math.max(2, trimmedName.split(/\s+/).length);

  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let span = 0; span < maxSpan && i + span < words.length; span++) {
      joined += words[i + span];
      if (Math.abs(joined.length - nameLower.length) > maxEdits) continue;
      if (levenshteinDistance(joined, nameLower) <= maxEdits && isAddressedAt(i, words, rawWords))
        return true;
    }
  }

  return false;
}
