import { getBaseLanguageCode } from "../utils/languageSupport";

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

const LOCALIZED_CUE_SETS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(LOCALIZED_VOCATIVE_CUES).map(([lang, cues]) => [lang, new Set(cues)])
);

const EMPTY_CUES: ReadonlySet<string> = new Set();

// CJK transcripts carry no spaces ("ねぇ、Jarvis、メールを"), so fullwidth marks
// become their ASCII equivalent plus a space, and CJK/Latin transitions split.
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

const CJK_PUNCTUATION_RE = new RegExp(`[${Object.keys(CJK_PUNCTUATION_MAP).join("")}]`, "g");
const CJK_CHAR_RANGE = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff";
const CJK_TO_LATIN_RE = new RegExp(`([${CJK_CHAR_RANGE}])(?=[A-Za-z0-9])`, "g");
const LATIN_TO_CJK_RE = new RegExp(`([A-Za-z0-9])(?=[${CJK_CHAR_RANGE}])`, "g");

function normalizeCjkTranscript(transcript: string, agentName: string): string {
  const escapedName = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const agentNamePattern = new RegExp(escapedName, "giu");

  return transcript
    .normalize("NFC")
    .replace(agentNamePattern, " $& ")
    .replace(CJK_PUNCTUATION_RE, (ch) => CJK_PUNCTUATION_MAP[ch] ?? ch)
    .replace(CJK_TO_LATIN_RE, "$1 ")
    .replace(LATIN_TO_CJK_RE, "$1 ");
}

// Cues gate on a resolved language; "auto", unknown codes and junk fail closed
// to English-only. The caller maps "auto" to its best hint (the UI language).
function baseLanguageOf(language?: string): string | undefined {
  if (typeof language !== "string") return undefined;
  return getBaseLanguageCode(language.trim().toLowerCase());
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

  const base = baseLanguageOf(language);
  const localizedCues = (base && LOCALIZED_CUE_SETS.get(base)) || EMPTY_CUES;
  // Normalization is gated with the cues so non-CJK dictation stays untouched.
  const normalizeCjk = base === "ja" || base === "zh";
  const detectionName = normalizeCjk ? name.normalize("NFC") : name;
  const source = normalizeCjk ? normalizeCjkTranscript(transcript, detectionName) : transcript;

  const nameLower = detectionName.toLowerCase().replace(/\s+/g, "");
  const rawWords = source.split(/\s+/).filter(Boolean);
  const words = rawWords.map((w) => w.replace(/[.,!?;:'"()]/g, "").toLowerCase());

  const maxEdits = maxEditsForLength(nameLower.length);
  // STT may split the name across tokens ("open whispr") or mishear it, so
  // compare joined windows up to the name's own token count (minimum 2)
  // against the name, allowing length-scaled edits.
  const maxSpan = Math.max(2, detectionName.split(/\s+/).length);

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
