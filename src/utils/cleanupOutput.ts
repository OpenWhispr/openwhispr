import logger from "./logger";

const wordSegmenter = new Intl.Segmenter("und", { granularity: "word" });
const cleanupLabel =
  /^(?:Cleaned transcript:|\*\*Cleaned transcript:\*\*|\*\*Cleaned transcript\*\*:)$/i;
// Six words in a row from the prompt are copied from it, not a coincidence.
const COPIED_RUN_LENGTH = 6;
// Fillers and false starts can sit between the words of a phrase the speaker did say.
const SPOKEN_RUN_SPAN = COPIED_RUN_LENGTH * 2;
// Cleanup's own edits add a short word or correct one mishearing. More than that is a copy.
const MAX_UNSPOKEN_WORDS = 2;
const MAX_UNSPOKEN_LONG_WORDS = 1;
const LONG_WORD_LENGTH = 4;

interface CleanupInstructions {
  prompt: string;
  dictionary: string[];
}

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

function wordRuns(tokens: string[], length: number): string[][] {
  const runs: string[][] = [];
  for (let i = 0; i + length <= tokens.length; i++) runs.push(tokens.slice(i, i + length));
  return runs;
}

function wordsInOrder(words: string[], spoken: string[]): number {
  let previous = new Array<number>(spoken.length + 1).fill(0);
  for (const word of words) {
    const current = [0];
    spoken.forEach((token, index) => {
      current.push(
        token === word ? previous[index] + 1 : Math.max(previous[index + 1], current[index])
      );
    });
    previous = current;
  }
  return previous[spoken.length];
}

function copiesInstructions(
  rawText: string,
  output: string,
  { prompt, dictionary }: CleanupInstructions
): boolean {
  const rawTokens = comparisonTokens(rawText);
  const stretches =
    rawTokens.length > SPOKEN_RUN_SPAN ? wordRuns(rawTokens, SPOKEN_RUN_SPAN) : [rawTokens];
  const dictionaryWords = new Set(comparisonTokens(dictionary.join(" ")));
  const promptRuns = new Set(
    wordRuns(comparisonTokens(prompt), COPIED_RUN_LENGTH).map((run) => run.join(" "))
  );
  return wordRuns(comparisonTokens(output), COPIED_RUN_LENGTH).some((run) => {
    if (!promptRuns.has(run.join(" "))) return false;
    // Cleanup writes spoken numbers as digits and is told to use the dictionary's spellings.
    const words = run.filter((token) => !dictionaryWords.has(token) && !/^\p{N}+$/u.test(token));
    const longWords = words.filter((token) => [...token].length >= LONG_WORD_LENGTH);
    return !stretches.some(
      (stretch) =>
        words.length - wordsInOrder(words, stretch) <= MAX_UNSPOKEN_WORDS &&
        longWords.length - wordsInOrder(longWords, stretch) <= MAX_UNSPOKEN_LONG_WORDS
    );
  });
}

function rejectCleanupOutput(
  reason: string,
  rawText: string,
  output: string,
  message: string,
  messageKey: string
): never {
  logger.logReasoning("CLEANUP_OUTPUT_REJECTED", {
    reason,
    inputLength: rawText.length,
    outputLength: output.length,
  });
  throw Object.assign(new Error(message), { code: "CLEANUP_OUTPUT_INVALID", messageKey });
}

export function assertValidCleanupOutput(
  rawText: string,
  output: string,
  instructions?: CleanupInstructions
): void {
  if (instructions && copiesInstructions(rawText, output, instructions)) {
    rejectCleanupOutput(
      "copied_instructions",
      rawText,
      output,
      "AI cleanup added text you didn't say. The original text was kept.",
      "hooks.audioRecording.errorDescriptions.cleanupAddedText"
    );
  }

  // Collapse stutters ("the the") so they don't read as saying a word twice.
  const originalTokens = comparisonTokens(rawText).filter(
    (token, index, all) => token !== all[index - 1]
  );
  const tokens: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (cleanupLabel.test(line.trim())) continue;
    for (const token of comparisonTokens(line)) tokens.push(token);
  }

  const halfLength = tokens.length / 2;
  if (!Number.isInteger(halfLength) || halfLength < 6) return;
  const copy = tokens.slice(0, halfLength);
  if (!copy.every((token, index) => token === tokens[index + halfLength])) return;
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
  if (saidTwice * 2 > halfLength) return;

  rejectCleanupOutput(
    "duplicated_transcript",
    rawText,
    output,
    "AI cleanup repeated the transcript. The original text was kept.",
    "hooks.audioRecording.errorDescriptions.cleanupDuplicated"
  );
}
