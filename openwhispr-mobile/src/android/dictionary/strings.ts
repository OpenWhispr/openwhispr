import i18n from '../strings';
import { useTranslation } from 'react-i18next';
import { dictionaryTranslations } from './translations';

// Dictionary copy lives here rather than in the shared locale files, which the iOS app loads.
// The empty states use the desktop app's words (`dictionary.emptyTitle`, `dictionary.snippets.*`).
export const dictionaryEnglish = {
  dictionary: 'Dictionary',
  words: 'Words',
  snippets: 'Snippets',
  search: 'Search',
  cancel: 'Cancel',
  clear: 'Clear',
  undo: 'Undo',
  delete: 'Delete',
  save: 'Save',
  close: 'Close',

  // C1: what it learned, to review.
  learnedFromFixes: 'Learned from your fixes · {{count}}',
  youFixedInNote: 'You fixed “{{from}}” in a note · {{time}}',
  youFixedInApp: 'You fixed “{{from}}” after dictating · {{time}}',
  youFixedInTranscript: 'You fixed “{{from}}” in a transcript · {{time}}',
  learnedAgo: 'Learned · {{time}}',
  keep: 'Keep',
  remove: 'Remove',
  reviewPosition: '{{index}} of {{count}} · swipe right to keep, left to remove',
  kept: 'Kept “{{word}}”',
  removed: 'Removed “{{word}}”',

  // The list.
  yourWords: 'Your words · {{count}}',
  addedByYou: 'Added by you',
  addedByYouOn: 'Added by you · {{date}}',
  learned: 'Learned',
  learnedOn: 'Learned · {{date}}',
  learnedKeptOn: 'Learned · kept {{date}}',
  hiddenForYou: 'Hidden for you',
  teamWordsOne: '1 word from {{workspace}}',
  teamWordsMany: '{{count}} words from {{workspace}}',
  yourWorkspace: 'your workspace',
  teamWordsBody: 'Shared · manage on desktop',
  teamWordsMovedOne: '{{word}} moved there from your words.',
  teamWordsMovedMany: '{{count}} of your words moved there.',
  addWord: 'Add word',

  // C2: add.
  addWords: 'Add words',
  addWordsPlaceholder: 'A word, or several with commas',
  addWordsHelp: 'Separate words with commas.',
  addOne: 'Add 1 word',
  addMany: 'Add {{count}} words',
  removeChip: 'Remove {{word}}',
  addedOne: 'Added “{{word}}”',
  addedMany: 'Added {{count}} words',

  // C3: edit.
  editWord: 'Edit word',
  editWordField: 'Word',
  deleteWord: 'Delete word',
  learnedFromNote: 'Learned from a note',
  learnedFromTranscript: 'Fixed in a transcript',
  learnedAfterDictating: 'Learned after you dictated',
  learnedFromFixesShort: 'Learned from your fixes',
  originNote: '“{{title}}” · {{date}}',
  originFixed: 'You fixed “{{from}}” · {{date}}',
  untitledNote: 'Untitled note',
  alreadyHave: '“{{word}}” is already in your words.',
  saved: 'Saved',

  // C4: delete.
  deleted: '“{{word}}” deleted',

  // C5: search.
  searchWords: 'Search words',
  searchSnippets: 'Search snippets',
  noWordCalled: 'No word called “{{query}}” yet',
  addQuery: 'Add “{{query}}”',
  toYourWords: 'To your words',
  closeMatches: 'Close matches',
  matches: 'Matches',
  noSnippetCalled: 'No snippet matches “{{query}}”',

  // C6: empty (desktop copy).
  emptyTitle: 'Add words to your dictionary',
  emptyBody:
    'Names, tools and acronyms OpenWhispr should always get right. Fix a word after you dictate and it learns that too.',
  addFirstWord: 'Add your first word',
  snippetsEmptyTitle: 'Stuff you shouldn’t have to say',
  snippetsEmptyAccent: 'twice',
  snippetsEmptyBody:
    'Say a trigger and OpenWhispr types what you saved: links, intros, sign-offs, prompts.',
  newSnippet: 'New snippet',
  exampleSignoffTrigger: 'Sign off',
  exampleSignoffText: 'Best, Alex · alex@example.com',
  exampleLinkedinTrigger: 'My LinkedIn',
  exampleLinkedinText: 'linkedin.com/in/you',

  // C7, C10, C11: told after.
  learnedToast: 'Learned “{{word}}”',
  learnedManyToast: 'Learned {{count}} words',
  fixedLearnedOne: 'Fixed · learned “{{word}}”',
  fixedLearnedMany: 'Fixed {{count}} · learned “{{word}}”',
  wontLearn: 'Won’t learn “{{word}}”',
  wontLearnMany: 'Won’t learn {{count}} words',

  // C9: long-press a misheard word.
  fixWordTitle: 'Fix “{{word}}”',
  fixAllAdd: 'Fix all {{count}} · add to Dictionary',
  fixOneAdd: 'Fix it · add to Dictionary',
  fixWordHint: 'Long-press a word to fix it',

  // C13: snippets.
  sayTheTrigger: 'Say the trigger, get the text',
  addSnippet: 'Add snippet',
  editSnippet: 'Edit snippet',
  trigger: 'Trigger',
  triggerPlaceholder: 'signoff',
  snippetText: 'Text',
  snippetTextPlaceholder: 'What to type when you say the trigger',
  snippetHelp: 'Say the trigger while you dictate and OpenWhispr types the text instead.',
  deleteSnippet: 'Delete snippet',
  snippetDeleted: '“{{trigger}}” deleted',
  duplicateTrigger: 'You already have a snippet called “{{trigger}}”.',
} as const;

export type DictionaryKey = keyof typeof dictionaryEnglish;
export const DICTIONARY_NAMESPACE = 'androidDictionary';
i18n.addResourceBundle('en', DICTIONARY_NAMESPACE, dictionaryEnglish, true, false);
for (const [language, strings] of Object.entries(dictionaryTranslations))
  i18n.addResourceBundle(language, DICTIONARY_NAMESPACE, strings, true, false);

export type DictionaryT = (key: DictionaryKey, options?: Record<string, unknown>) => string;

export function useDictionaryT(): DictionaryT {
  const { t } = useTranslation(DICTIONARY_NAMESPACE);
  return t as DictionaryT;
}

export const dictionaryT: DictionaryT = (key, options) =>
  i18n.t(key, { ns: DICTIONARY_NAMESPACE, ...options }) as string;
