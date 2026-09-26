import logger from "./logger";
import { applyChineseScript, isChineseText } from "./chineseScript";

const wordSegmenter = new Intl.Segmenter("und", { granularity: "word" });
const cleanupLabel =
  /^(?:Cleaned transcript:|\*\*Cleaned transcript:\*\*|\*\*Cleaned transcript\*\*:)$/i;
// Four words in a row is a phrase lifted from the prompt, not a coincidence.
const PROMPT_RUN_LENGTH = 4;
// A lifted phrase holds at least this many words the speaker never said. Cleanup's
// own edits (an added "the", a contraction, one corrected word) add fewer.
const UNSPOKEN_WORDS = 2;
// "Okay, here's the cleaned transcript:" — a whole line announcing the cleanup.
const ANNOUNCEMENT_LINE =
  /^[\s*]*(?:(?:okay|ok|sure|alright)[,.!]?\s+)?(?:(?:here(?:'s|’s|\s+is)|this\s+is)\s+(?:(?:the|a|your)\s+)?(?:(?:cleaned|clean|corrected)(?:[-\s]up)?\s+)?|(?:(?:the|a|your)\s+)?(?:cleaned|clean|corrected)(?:[-\s]up)?\s+)(?:transcript|version|text|output)\b[^\n:]{0,60}:[\s*]*$/iu;
// "Cleaned transcript: …", "Transcript:" or "Output: …" opening a line.
const LABEL_PREFIX =
  /^[\s*]*(cleaned(?:[-\s]up)?\s+(?:transcript|text|version)|transcript(?:\s+cleaned)?|output)[\s*]*:/iu;
// Words that only frame a label: rewording them ("here is" → "here's") proves nothing.
const LABEL_FRAMING = new Set([
  "okay",
  "ok",
  "sure",
  "alright",
  "here",
  "heres",
  "is",
  "this",
  "the",
  "a",
  "your",
]);
// The noun an announcement's label ends on: "…the cleaned transcript:".
const ANNOUNCED = new Set(["transcript", "version", "text", "output"]);
const TRANSCRIPT_TAG = /<\/?transcript\b[^<>]*>/iu;
// Words a speaker uses to dictate markup: "less than transcript greater than".
const MARKUP_CUES = /\b(?:tags?|brackets?|angle|less|greater)\b/iu;
const DUPLICATED = {
  message: "AI cleanup repeated the transcript. The original text was kept.",
  messageKey: "hooks.audioRecording.errorDescriptions.cleanupDuplicated",
};
const ADDED_TEXT = {
  message: "AI cleanup added text you didn't say. The original text was kept.",
  messageKey: "hooks.audioRecording.errorDescriptions.cleanupAddedText",
};

/** The instructions a default cleanup request sent, to spot a reply that copies them. */
export interface CleanupPrompt {
  /** System prompt (dictionary list included) and the instruction after the transcript. */
  text: string;
  /** Dictionary words and snippet triggers listed in the prompt; the speaker may say them. */
  dictionary: readonly string[];
}

export type CleanupOutputProblem =
  "duplicated_transcript" | "prompt_copy" | "label" | "transcript_tags" | "markdown_residue";

function comparisonTokens(text: string): string[] {
  // Keep contractions as one word when punctuation is discarded.
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/\p{P}/gu, " ");
  return Array.from(wordSegmenter.segment(normalized))
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

const isNumber = (token: string) => /^\p{N}+$/u.test(token);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Digits and single characters recur in any date or number ("1 月 15 日", "5 30 pm").
const isSubstantive = (token: string) => !isNumber(token) && [...token].length > 1;
// Cleanup adds short words ("the", "by"); a copied phrase also brings a longer one.
// CJK words are one or two characters.
const isContentWord = (token: string) =>
  !isNumber(token) && [...token].length > (CJK.test(token) ? 1 : 3);

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

// A word a letter or two from one the speaker said is a corrected mishearing or a
// contraction ("sent" → "send", "capitol" → "capital", "what" → "what's").
function nearlySaid(token: string, spoken: ReadonlySet<string>): boolean {
  const limit = token.length > 5 ? 2 : 1;
  for (const word of spoken) {
    if (Math.abs(word.length - token.length) <= limit && editDistance(token, word) <= limit) {
      return true;
    }
  }
  return false;
}

function wordRuns(tokens: readonly string[]): string[] {
  const runs: string[] = [];
  for (let i = 0; i + PROMPT_RUN_LENGTH <= tokens.length; i++) {
    runs.push(tokens.slice(i, i + PROMPT_RUN_LENGTH).join(" "));
  }
  return runs;
}

function repeatsTranscript(rawTokens: readonly string[], output: string): boolean {
  // Collapse stutters ("the the") so they don't read as saying a word twice.
  const originalTokens = rawTokens.filter((token, index, all) => token !== all[index - 1]);
  const tokens: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (cleanupLabel.test(line.trim())) continue;
    for (const token of comparisonTokens(line)) tokens.push(token);
  }

  const halfLength = tokens.length / 2;
  if (!Number.isInteger(halfLength) || halfLength < 6) return false;
  const copy = tokens.slice(0, halfLength);
  if (!copy.every((token, index) => token === tokens[index + halfLength])) return false;
  // A speaker who really said it twice said most of its words twice: each word
  // in the copy uses up two of its occurrences in the raw transcript.
  const rawCounts = new Map<string, number>();
  for (const token of originalTokens) rawCounts.set(token, (rawCounts.get(token) ?? 0) + 1);
  let saidTwice = 0;
  for (const token of copy) {
    const remaining = rawCounts.get(token) ?? 0;
    if (remaining < 2) continue;
    rawCounts.set(token, remaining - 2);
    saidTwice++;
  }
  return saidTwice * 2 <= halfLength;
}

function copiesPrompt(spoken: ReadonlySet<string>, output: string, prompt: CleanupPrompt): boolean {
  const fromPrompt = new Set(wordRuns(comparisonTokens(prompt.text)));
  // Cleanup is told to use the dictionary's spellings, so its words are never unspoken.
  const allowed = new Set([
    ...spoken,
    ...prompt.dictionary.flatMap((entry) => comparisonTokens(entry)),
  ]);
  const outputTokens = comparisonTokens(output);
  for (let i = 0; i + PROMPT_RUN_LENGTH <= outputTokens.length; i++) {
    const run = outputTokens.slice(i, i + PROMPT_RUN_LENGTH);
    if (!fromPrompt.has(run.join(" "))) continue;
    const unspoken = run.filter((token) => isSubstantive(token) && !allowed.has(token));
    if (
      unspoken.length >= UNSPOKEN_WORDS &&
      unspoken.some((token) => isContentWord(token) && !nearlySaid(token, spoken))
    ) {
      return true;
    }
  }
  return false;
}

// The words a label line puts before the transcript: "cleaned transcript", "output"…
function labelWords(line: string): string[] | undefined {
  if (ANNOUNCEMENT_LINE.test(line)) {
    const words = comparisonTokens(line).filter((token) => !LABEL_FRAMING.has(token));
    return words.slice(0, words.findIndex((token) => ANNOUNCED.has(token)) + 1);
  }
  const label = LABEL_PREFIX.exec(line)?.[1];
  return label === undefined ? undefined : comparisonTokens(label);
}

// Text around the transcript that the speaker never said.
function wrapperProblem(
  rawText: string,
  spoken: ReadonlySet<string>,
  output: string
): CleanupOutputProblem | null {
  // A label is the speaker's own only if they said its words; the rest of its line
  // may be reworded like any cleanup.
  for (const line of output.split(/\r?\n/u)) {
    if (labelWords(line)?.some((word) => !spoken.has(word))) return "label";
  }
  const dictatedTag =
    TRANSCRIPT_TAG.test(rawText) || (spoken.has("transcript") && MARKUP_CUES.test(rawText));
  if (TRANSCRIPT_TAG.test(output) && !dictatedTag) return "transcript_tags";
  const trimmed = output.trim();
  // A dangling "**"; bold that opens and closes is left alone.
  const unbalancedBold = trimmed.endsWith("**") && trimmed.split("**").length % 2 === 0;
  if (unbalancedBold && !rawText.includes("**")) return "markdown_residue";
  return null;
}

export function findCleanupOutputProblem(
  rawText: string,
  output: string,
  prompt?: CleanupPrompt
): CleanupOutputProblem | null {
  const rawTokens = comparisonTokens(rawText);
  if (repeatsTranscript(rawTokens, output)) return "duplicated_transcript";
  const spoken = new Set(rawTokens);
  if (prompt && copiesPrompt(spoken, output, prompt)) return "prompt_copy";
  return wrapperProblem(rawText, spoken, output);
}

// Speech-to-text and cleanup can write Chinese in different scripts (简/繁), which
// would make every converted word look unspoken, so compare everything in one.
export async function inOneChineseScript(
  rawText: string,
  output: string,
  prompt?: CleanupPrompt
): Promise<[string, string, CleanupPrompt | undefined]> {
  const texts = [rawText, output, ...(prompt ? [prompt.text, ...prompt.dictionary] : [])];
  // One decision for every text: a line with no script-specific character is still Chinese.
  if (!texts.some((text) => isChineseText(text))) return [rawText, output, prompt];
  try {
    const [raw, reply, text, ...dictionary] = await Promise.all(
      texts.map((text) => applyChineseScript(text, "simplified"))
    );
    return [raw, reply, prompt && { text, dictionary }];
  } catch (error) {
    // Unmatched scripts would make the copy check reject good cleanups, so skip that
    // check; a converter that fails to load must not cost the user their cleanup.
    logger.logReasoning("CLEANUP_SCRIPT_UNAVAILABLE", { error: (error as Error).message });
    return [rawText, output, undefined];
  }
}

export function assertValidCleanupOutput(
  rawText: string,
  output: string,
  prompt?: CleanupPrompt
): void {
  const problem = findCleanupOutputProblem(rawText, output, prompt);
  if (!problem) return;
  // The reason only: the output can hold the speaker's words and dictionary names.
  logger.logReasoning("CLEANUP_OUTPUT_REJECTED", {
    reason: problem,
    inputLength: rawText.length,
    outputLength: output.length,
  });
  const { message, messageKey } = problem === "duplicated_transcript" ? DUPLICATED : ADDED_TEXT;
  throw Object.assign(new Error(message), { code: "CLEANUP_OUTPUT_INVALID", messageKey });
}
