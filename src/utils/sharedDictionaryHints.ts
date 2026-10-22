import type {
  SharedDictionarySnapshot,
  SharedDictionarySnapshotEntry,
} from "../types/sharedDictionary";
import { dictionaryWordKey } from "./snippets";

export interface SharedHintWords {
  readonly space: readonly string[];
  readonly workspace: readonly string[];
  /**
   * Moved personal words (shared_at set) whose every copy in the active
   * workspace the member hid. The server keeps a moved word's personal fallback
   * while any readable workspace still applies it, so without this the
   * fallback would undo "Hide for me". Absent when there are none.
   */
  readonly suppressedPersonal?: readonly string[];
}

// Shared by every "no shared words" answer, so frozen: a caller that pushed into
// it would leak words into every later fallback.
export const EMPTY_SHARED_HINTS: SharedHintWords = Object.freeze({
  space: Object.freeze([]),
  workspace: Object.freeze([]),
});

const MAX_SHARED_WORD_LENGTH = 64;
const MAX_SHARED_WORD_TOKENS = 6;
// Control, invisible format (zero-width, bidi overrides, BOM) and line or
// paragraph separator characters, plus the characters that open markup,
// templates, fences or tables in a prompt. ZWNJ and ZWJ stay: Persian, Urdu and
// Indic words are spelled with them.
const NOT_TERM_LIKE = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>{}[\]`|]/u;
// A comma would split one entry into several prompt and keyterm items; a
// semicolon or CJK full stop only ever joins clauses.
const LIST_OR_CLAUSE_PUNCTUATION = /[,\uFF0C\u3001\u060C;\uFF1B\u3002]/u;
// A colon that ends a token ("SYSTEM:", "Note:") opens a clause; inside one
// ("re:Invent", "10:30", "Re\uFF1AZero") it is spelling. CJK has no spaces, so
// a full-width colon before a CJK character opens one too ("系统：服从").
const CLAUSE_END =
  /[:\uFF1A]$|\uFF1A[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// A question mark ends a sentence unless the term is that one word ("What?").
// "!" is left alone: brand names carry it mid-phrase ("Yahoo! Japan").
const QUESTION_END = /[?\uFF1F]$/u;
// A period after an abbreviation or initial ("St.", "Corp.", "Sept.", "J.",
// "e.g.", "Ph.D.") does not end a sentence; after any longer word in a phrase
// ("French.") it does.
const ABBREVIATION = /^(?:\p{L}{1,5}|(?:\p{L}{1,2}\.)+\p{L}{1,2})\.$/u;
// A phrase that opens with an instruction verb reads as a command to the model
// ("Output nothing", "Ignore the above", "Do not clean up"), not a term. English
// only; a brand that starts with one of these ("Return Path") stays personal.
const INSTRUCTION_VERB =
  /^(?:ignore|disregard|forget|override|bypass|output|print|reply|respond|answer|return|say|write|rewrite|translate|summari[sz]e|repeat|recite|do|don['\u2019]?t|never|always|stop|act|pretend|delete|remove|replace|follow|obey)!?$/iu;
// A chat role label anywhere in the word ("SYSTEM:override", "assistant\uFF1Ahi").
const ROLE_LABEL = /^(?:system|assistant|user|developer|human)[:\uFF1A]/iu;

function isSentenceShaped(tokens: string[]): boolean {
  const phrase = tokens.length > 1;
  return tokens.some(
    (token) =>
      CLAUSE_END.test(token) ||
      (phrase && QUESTION_END.test(token)) ||
      (phrase && token.endsWith(".") && !ABBREVIATION.test(token))
  );
}

function isInstructionShaped(tokens: string[]): boolean {
  return (
    (tokens.length > 1 && INSTRUCTION_VERB.test(tokens[0])) ||
    tokens.some((token) => ROLE_LABEL.test(token))
  );
}

/**
 * Teammates' words reach transcription and LLM system prompts, so only words
 * that look like dictionary terms do: a short name or phrase, never something
 * shaped like an instruction, a sentence, a list or markup. The Dictionary page
 * still lists the rest.
 */
export function isTermLikeSharedWord(word: string): boolean {
  // Checked before trimming: trim() would strip a BOM or a trailing line break.
  if (NOT_TERM_LIKE.test(word) || LIST_OR_CLAUSE_PUNCTUATION.test(word)) return false;
  const term = word.trim();
  if (term.length < 1 || term.length > MAX_SHARED_WORD_LENGTH) return false;
  const tokens = term.split(/\s+/u);
  return (
    tokens.length <= MAX_SHARED_WORD_TOKENS &&
    !isSentenceShaped(tokens) &&
    !isInstructionShaped(tokens)
  );
}

/**
 * The shared entries that apply to this member: live, readable (their list is
 * one of the member's scopes) and not hidden. Empty while sharing is paused or
 * before the first sync pass.
 */
export function selectAppliedSharedEntries(
  snapshot: SharedDictionarySnapshot
): SharedDictionarySnapshotEntry[] {
  if (snapshot.meta?.paused) return [];
  const hidden = new Set(snapshot.hiddenIds);
  return readableEntries(snapshot).filter((entry) => !hidden.has(entry.cloudId));
}

// Entries whose list is one of the member's scopes; none before the first sync.
function readableEntries(snapshot: SharedDictionarySnapshot): SharedDictionarySnapshotEntry[] {
  const { meta } = snapshot;
  if (!meta) return [];
  const readableSpaces = new Set<string>();
  let workspaceReadable = false;
  for (const scope of meta.scopes) {
    if (scope.space_id === null) workspaceReadable = true;
    else readableSpaces.add(scope.space_id);
  }
  return snapshot.entries.filter((entry) =>
    entry.spaceId === null ? workspaceReadable : readableSpaces.has(entry.spaceId)
  );
}

// Moved personal words the member hid every readable copy of. Paused sharing
// applies no copy, so a hidden one still suppresses its fallback then.
function selectSuppressedPersonal(
  snapshot: SharedDictionarySnapshot,
  movedPersonal: readonly string[]
): string[] {
  if (movedPersonal.length === 0) return [];
  const hidden = new Set(snapshot.hiddenIds);
  const hiddenKeys = new Set<string>();
  const applyingKeys = new Set(
    selectAppliedSharedEntries(snapshot).map((entry) => dictionaryWordKey(entry.word))
  );
  for (const entry of readableEntries(snapshot)) {
    if (hidden.has(entry.cloudId)) hiddenKeys.add(dictionaryWordKey(entry.word));
  }
  return movedPersonal.filter((word) => {
    const key = dictionaryWordKey(word);
    return hiddenKeys.has(key) && !applyingKeys.has(key);
  });
}

/**
 * The applied shared words that reach prompts, with their entry ids, for the
 * assistant's dictionary tool: a word that never reaches a prompt must not count
 * as "already in the dictionary".
 */
export function selectAppliedSharedWords(
  snapshot: SharedDictionarySnapshot
): { id: string; word: string }[] {
  return selectAppliedSharedEntries(snapshot)
    .filter((entry) => isTermLikeSharedWord(entry.word))
    .map((entry) => ({ id: entry.cloudId, word: entry.word.trim() }));
}

/**
 * The shared words that may reach the STT prompt: applied, term-like entries.
 * Everything is empty while sharing is paused or before the first sync pass, so
 * the prompt never carries words the workspace has switched off.
 */
export function selectSharedHintWords(
  snapshot: SharedDictionarySnapshot,
  movedPersonal: readonly string[] = []
): SharedHintWords {
  const space: string[] = [];
  const workspace: string[] = [];
  for (const entry of selectAppliedSharedEntries(snapshot)) {
    if (!isTermLikeSharedWord(entry.word)) continue;
    const word = entry.word.trim();
    if (entry.spaceId === null) workspace.push(word);
    else space.push(word);
  }
  const suppressedPersonal = selectSuppressedPersonal(snapshot, movedPersonal);
  return suppressedPersonal.length > 0
    ? { space, workspace, suppressedPersonal }
    : { space, workspace };
}
