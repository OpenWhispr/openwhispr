import { showToast } from '../settings/kit';
import { unlearn } from './learned';
import { dictionaryT } from './strings';

/** Undo toasts stay 6 s, as Notes' delete (C4b, C7). */
export const UNDO_MS = 6000;

/**
 * C7 and C10: the dictionary learned from a fix; the toast says so with Undo only. Undo
 * removes the words and never learns them again. `aboveTabBar` for screens with the tab bar.
 */
export function showLearnedToast(
  words: string[],
  options: { fixedCount?: number; aboveTabBar?: boolean } = {},
) {
  if (words.length === 0) return;
  const message =
    options.fixedCount != null
      ? options.fixedCount > 1
        ? dictionaryT('fixedLearnedMany', { count: options.fixedCount, word: words[0] })
        : dictionaryT('fixedLearnedOne', { word: words[0] })
      : words.length === 1
        ? dictionaryT('learnedToast', { word: words[0] })
        : dictionaryT('learnedManyToast', { count: words.length });
  let settled = false;
  showToast(
    message,
    'learned',
    {
      label: dictionaryT('undo'),
      onPress: () => {
        if (settled) return;
        settled = true;
        unlearn(words);
      },
      onClose: () => {
        settled = true;
      },
    },
    { durationMs: UNDO_MS, aboveTabBar: options.aboveTabBar },
  );
}
