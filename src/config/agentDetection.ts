import { getBaseLanguageCode } from "../utils/languageSupport";
import {
  findSnippetTriggerRanges,
  type Snippet,
  type SnippetTriggerRange,
} from "../utils/snippets";

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
  ar: ["يا"],
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
const TOKEN_PUNCTUATION_RE = /[.,!?;:'"()،؛؟]/g;
const SEPARATE_ADDRESS_PUNCTUATION = new Set([",", "،"]);

interface NormalizedTranscript {
  text: string;
  /** For each character of `text`, the index it came from in the NFC transcript. */
  origin: number[];
}

/** Output character `i` of the replacement came from `offsets[i]` within the match. */
type TrackedReplacer = (match: string) => [replacement: string, offsets: number[]];

const identityOffsets = (value: string): number[] =>
  Array.from({ length: value.length }, (_, index) => index);

// Replaces like String#replace, but carries every output character's origin
// along, so a span of the normalized text can be measured against snippet
// ranges found in the transcript the user actually spoke.
function replaceTracked(
  input: NormalizedTranscript,
  regex: RegExp,
  replacer: TrackedReplacer
): NormalizedTranscript {
  let text = "";
  const origin: number[] = [];
  let copied = 0;
  const copyThrough = (until: number) => {
    text += input.text.slice(copied, until);
    for (let i = copied; i < until; i++) origin.push(input.origin[i]);
  };

  for (const match of input.text.matchAll(regex)) {
    copyThrough(match.index);
    const [replacement, offsets] = replacer(match[0]);
    text += replacement;
    for (const offset of offsets) origin.push(input.origin[match.index + offset]);
    copied = match.index + match[0].length;
  }
  copyThrough(input.text.length);
  return { text, origin };
}

// Splitting a CJK/Latin run adds a space that belongs to the character before it.
const splitAfterMatch: TrackedReplacer = (match) => [`${match} `, [0, 0]];

function normalizeCjkTranscript(nfcTranscript: string, agentName: string): NormalizedTranscript {
  const escapedName = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const agentNamePattern = new RegExp(escapedName, "giu");

  let result: NormalizedTranscript = {
    text: nfcTranscript,
    origin: identityOffsets(nfcTranscript),
  };
  // The name keeps its own origins, so a candidate spanning it still measures
  // its true width against a trigger range.
  result = replaceTracked(result, agentNamePattern, (match) => [
    ` ${match} `,
    [0, ...identityOffsets(match), match.length - 1],
  ]);
  result = replaceTracked(result, CJK_PUNCTUATION_RE, (ch) => {
    const mapped = CJK_PUNCTUATION_MAP[ch] ?? ch;
    return [mapped, new Array<number>(mapped.length).fill(0)];
  });
  result = replaceTracked(result, CJK_TO_LATIN_RE, splitAfterMatch);
  return replaceTracked(result, LATIN_TO_CJK_RE, splitAfterMatch);
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

// A snippet trigger is a phrase the user reserved for expansion, so a name
// inside one is the trigger being spoken, not the agent being addressed. The
// window has to be *contained*: candidates span up to maxSpan tokens to absorb
// STT splitting the name, so a window that merely clips a trigger ("open" out
// of "open whispr summarize this") is still a real address.
function insideTrigger(start: number, end: number, ranges: SnippetTriggerRange[]): boolean {
  return ranges.some((range) => range.start <= start && end <= range.end);
}

interface AgentAddress {
  /** Index of the first raw word to drop (the cue, when one precedes the name). */
  start: number;
  /** Index one past the last raw word of the name. */
  end: number;
  /** The words the indices refer to (CJK transcripts are normalized first). */
  rawWords: string[];
  /** Address span in the transcript, or its NFC form for CJK detection. */
  sourceStart: number;
  sourceEnd: number;
  sourceIsNfc: boolean;
}

function locateAgentAddress(
  transcript: string,
  agentName: string,
  language?: string,
  snippets?: Snippet[] | null,
  refinePrefix = false
): AgentAddress | null {
  const name = agentName.trim();
  if (!name || name.length < 2) return null;

  const base = baseLanguageOf(language);
  const localizedCues = (base && LOCALIZED_CUE_SETS.get(base)) || EMPTY_CUES;
  const normalizeCjk = base === "ja" || base === "zh";
  const detectionName = normalizeCjk ? name.normalize("NFC") : name;
  // Snippet ranges and the normalized text share this frame, so a candidate
  // span in `source` can be mapped back onto a range.
  const rangeSource = normalizeCjk ? transcript.normalize("NFC") : transcript;
  const normalized = normalizeCjk ? normalizeCjkTranscript(rangeSource, detectionName) : null;
  const source = normalized ? normalized.text : transcript;

  const nameLower = detectionName.toLowerCase().replace(/\s+/g, "");
  // Tokenize with offsets so candidates can be tested against trigger ranges.
  const tokens = [...source.matchAll(/\S+/g)];
  const rawWords = tokens.map((token) => token[0]);
  const wordStarts = tokens.map((token) => token.index);
  const words = rawWords.map((w) => w.replace(TOKEN_PUNCTUATION_RE, "").toLowerCase());
  // Triggers are matched against the transcript as spoken: CJK normalization
  // both splits a trigger that contains the name and manufactures the word
  // boundaries a glued-together one lacks, so ranges taken from `source` would
  // miss real triggers and invent absent ones. Candidate spans map back instead.
  const originAt = normalized
    ? (index: number) => normalized.origin[index]
    : (index: number) => index;
  const triggerRanges = findSnippetTriggerRanges(rangeSource, snippets);

  const maxEdits = maxEditsForLength(nameLower.length);
  // STT may split the name across tokens ("open whispr") or mishear it, so
  // compare joined windows up to the name's own token count (minimum 2)
  // against the name, allowing length-scaled edits.
  const maxSpan = Math.max(2, detectionName.split(/\s+/).length);

  let address: AgentAddress | null = null;
  let bestDistance = maxEdits;
  let searchEnd = words.length;
  for (let i = 0; i < searchEnd; i++) {
    const cueBefore = i > 0 && (VOCATIVE_CUES.has(words[i - 1]) || localizedCues.has(words[i - 1]));
    let joined = "";
    for (let span = 0; span < maxSpan && i + span < searchEnd; span++) {
      joined += words[i + span];
      if (Math.abs(joined.length - nameLower.length) > maxEdits) continue;
      const distance = levenshteinDistance(joined, nameLower);
      if (
        distance <= bestDistance &&
        // A cue names the agent outright, so it outranks a trigger the words
        // happen to span; without one the trigger the user configured wins.
        (cueBefore ||
          !insideTrigger(
            originAt(wordStarts[i]),
            originAt(wordStarts[i + span] + rawWords[i + span].length - 1) + 1,
            triggerRanges
          )) &&
        isAddressedAt(i, words, rawWords, localizedCues)
      ) {
        const nameEnd = i + span + 1;
        const addressEnd = SEPARATE_ADDRESS_PUNCTUATION.has(rawWords[nameEnd])
          ? nameEnd + 1
          : nameEnd;
        const start = cueBefore ? i - 1 : i;
        // Selection edits refine only the prefix of the first match:
        // "B. OpenWhispr" must prefer "OpenWhispr", without extending a fuzzy
        // name over a following operand ("OpenWhisp, R.").
        if (!address) searchEnd = nameEnd;
        bestDistance = distance;
        address = {
          start,
          end: addressEnd,
          rawWords,
          sourceStart: originAt(wordStarts[start]),
          sourceEnd: originAt(wordStarts[addressEnd - 1] + rawWords[addressEnd - 1].length - 1) + 1,
          sourceIsNfc: normalizeCjk,
        };
        if (!refinePrefix) return address;
      }
    }
  }

  return address;
}

export function detectAgentName(
  transcript: string,
  agentName: string,
  language?: string,
  snippets?: Snippet[] | null
): boolean {
  return locateAgentAddress(transcript, agentName, language, snippets) !== null;
}

/**
 * Removes the wake-word address ("Hey Aria,") so a panel command reads as the
 * command itself. Splices the locator's own word list (so CJK normalization
 * stays consistent); returns the transcript unchanged when no address is
 * found or when stripping would leave nothing.
 */
export function stripAgentAddress(
  transcript: string,
  agentName: string,
  language?: string,
  snippets?: Snippet[] | null
): string {
  const address = locateAgentAddress(transcript, agentName, language, snippets);
  if (!address) return transcript;
  const { rawWords, start, end } = address;
  const remaining = [...rawWords.slice(0, start), ...rawWords.slice(end)].join(" ").trim();
  return remaining || transcript;
}

/** Remove only the address and its following separator; edit operands stay verbatim. */
export function stripAgentAddressPreservingFormatting(
  transcript: string,
  agentName: string,
  language?: string,
  snippets?: Snippet[] | null
): string {
  const address = locateAgentAddress(transcript, agentName, language, snippets, true);
  if (!address) return transcript;
  let { sourceStart: start, sourceEnd: end } = address;
  if (address.sourceIsNfc && transcript !== transcript.normalize("NFC")) {
    // Detection indexes NFC text. Map grapheme boundaries back to the original
    // UTF-16 offsets so decomposed text outside the address is never rewritten.
    const boundaries = new Map<number, number>([[0, 0]]);
    let normalizedOffset = 0;
    for (const { segment, index } of new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(transcript)) {
      normalizedOffset += segment.normalize("NFC").length;
      boundaries.set(normalizedOffset, index + segment.length);
    }
    const originalStart = boundaries.get(start);
    const originalEnd = boundaries.get(end);
    // A partial grapheme match is ambiguous; keeping the address is safer.
    if (originalStart === undefined || originalEnd === undefined) return transcript;
    start = originalStart;
    end = originalEnd;
  }
  while (end < transcript.length && /\s/.test(transcript[end])) end++;
  const remaining = transcript.slice(0, start) + transcript.slice(end);
  return remaining.trim() ? remaining : transcript;
}
