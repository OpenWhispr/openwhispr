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

// Localized vocatives per base dictation language, matched with the same
// previous-token rule as the English cues. Kept short to avoid false positives.
const LOCALIZED_VOCATIVE_CUES: Record<string, readonly string[]> = {
  de: ["hallo", "servus"],
  es: ["oye", "hola", "oiga"],
  fr: ["hé", "salut"],
  it: ["ehi", "ei", "ciao", "scusa"],
  ja: ["ねぇ", "ねえ", "ヘイ"],
  pt: ["ei", "olá"],
  ru: ["привет", "эй", "слушай"],
  zh: ["嘿", "你好", "喂"],
};

const ALL_LOCALIZED_CUES: ReadonlySet<string> = new Set(
  Object.values(LOCALIZED_VOCATIVE_CUES).flat()
);

const EMPTY_CUES: ReadonlySet<string> = new Set();

// CJK transcripts carry no spaces around punctuation ("ねぇ、Jarvis、メールを"),
// so fullwidth marks become their ASCII equivalent plus a space before splitting.
const CJK_PUNCTUATION_MAP: Record<string, string> = {
  "、": ", ",
  "。": ". ",
  "！": "! ",
  "？": "? ",
  "，": ", ",
  "；": "; ",
  "：": ": ",
  "（": " (",
  "）": ") ",
  "「": ' "',
  "」": '" ',
  "『": ' "',
  "』": '" ',
};

function normalizeCjkPunctuation(transcript: string): string {
  return transcript.replace(/[、。！？，；：（）「」『』]/g, (ch) => CJK_PUNCTUATION_MAP[ch] ?? ch);
}

// "auto" (or an unset language) may be any supported language, so every
// localized cue stays active; a known language narrows to its own cues.
function localizedCuesFor(language?: string): ReadonlySet<string> {
  if (typeof language !== "string") return ALL_LOCALIZED_CUES;
  const base = language.trim().toLowerCase().split("-")[0];
  if (!base || base === "auto") return ALL_LOCALIZED_CUES;
  const cues = LOCALIZED_VOCATIVE_CUES[base];
  return cues ? new Set(cues) : EMPTY_CUES;
}

// The name only counts as addressing the agent when it starts the dictation,
// follows a greeting cue ("hey Jarvis"), or opens a new sentence. A mere
// mention elsewhere ("I showed OpenWhispr to a friend") is dictated content,
// not a command.
function isAddressedAt(
  index: number,
  words: string[],
  rawWords: string[],
  localizedCues: ReadonlySet<string>
): boolean {
  if (index === 0) return true;
  const prev = words[index - 1];
  if (VOCATIVE_CUES.has(prev) || localizedCues.has(prev)) return true;
  return /[.!?…]["')\]]*$/.test(rawWords[index - 1]);
}

export function detectAgentName(transcript: string, agentName: string, language?: string): boolean {
  const name = agentName.trim();
  if (!name || name.length < 2) return false;

  const localizedCues = localizedCuesFor(language);
  const nameLower = name.toLowerCase().replace(/\s+/g, "");
  const rawWords = normalizeCjkPunctuation(transcript).split(/\s+/).filter(Boolean);
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
      if (
        levenshteinDistance(joined, nameLower) <= maxEdits &&
        isAddressedAt(i, words, rawWords, localizedCues)
      ) {
        return true;
      }
    }
  }

  return false;
}
