import { useDictionaryStore, type DictionaryEntry } from '@/store/useDictionaryStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';
import type { Snippet } from '@/lib/snippets';
import { safeHaptics } from '@/lib/utils';
import { showToast } from '../settings/kit';
import { allowWords } from './learned';
import { dictionaryT } from './strings';

import { UNDO_MS } from './learnedToast';

/**
 * Words that came back from an Undo, so their row plays its way back in once. Keyed by the
 * lower-cased word (or `snippet:` + trigger).
 */
const restored = new Set<string>();
export function consumeRestoredRow(key: string): boolean {
  const had = restored.delete(key.toLowerCase());
  return had;
}

function restoreWord(entry: DictionaryEntry) {
  restored.add(entry.word.toLowerCase());
  const store = useDictionaryStore.getState();
  if (entry.source === 'learned') store.addLearnedWords([entry.word]);
  else store.addWords(entry.word);
}

/**
 * C4: the word goes at once (and syncs); Undo puts it back as it was, learned or added by
 * hand. Deleting by hand doesn't block it: dictating and fixing it again can learn it again.
 */
export function deleteWordWithUndo(entry: DictionaryEntry) {
  useDictionaryStore.getState().removeWord(entry.word);
  let settled = false;
  showToast(
    dictionaryT('deleted', { word: entry.word }),
    'success',
    {
      label: dictionaryT('undo'),
      onPress: () => {
        if (settled) return;
        settled = true;
        safeHaptics('light');
        restoreWord(entry);
      },
      onClose: () => {
        settled = true;
      },
    },
    { durationMs: UNDO_MS, aboveTabBar: true },
  );
}

export function deleteSnippetWithUndo(snippet: Snippet) {
  useSnippetsStore.getState().removeSnippet(snippet.trigger);
  let settled = false;
  showToast(
    dictionaryT('snippetDeleted', { trigger: snippet.trigger }),
    'success',
    {
      label: dictionaryT('undo'),
      onPress: () => {
        if (settled) return;
        settled = true;
        safeHaptics('light');
        restored.add(`snippet:${snippet.trigger}`.toLowerCase());
        useSnippetsStore.getState().addSnippet(snippet.trigger, snippet.replacement);
      },
      onClose: () => {
        settled = true;
      },
    },
    { durationMs: UNDO_MS, aboveTabBar: true },
  );
}

/** C2: words added by hand. Adding a word unblocks it, since the person asked for it. */
export function addWordsByHand(words: string[]) {
  const clean = words.map((word) => word.trim()).filter(Boolean);
  if (clean.length === 0) return;
  allowWords(clean);
  useDictionaryStore.getState().addWords(clean.join(','));
  showToast(
    clean.length === 1
      ? dictionaryT('addedOne', { word: clean[0] })
      : dictionaryT('addedMany', { count: clean.length }),
  );
}
