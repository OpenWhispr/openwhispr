import { router } from 'expo-router';
import { extractCorrectionPairs } from '@/lib/correctionLearner';
import { buildEffectiveDictionaryWords } from '@/lib/dictationHints';
import { AndroidDictation, dictationEvents } from '../../../modules/android-dictation/src';
import { forgetLearned, learnCorrections, loadLearnedWords, unlearn } from './learned';
import { dictionaryT } from './strings';

/**
 * Dictionary's C11: after the bubble types into another app, the accessibility service reads that
 * one field again for 45 s. When the person fixes a word there, the edit arrives here, is learned
 * silently, and the bubble's tab says so with Undo. Nothing leaves the phone except as an ordinary
 * learned dictionary word.
 */
/** A fix of the same misheard word within this long replaces the earlier one (45 s watch + slack). */
const FIX_MEMORY_MS = 60_000;

export function observeFieldLearning(): () => void {
  if (!dictationEvents || !AndroidDictation) return () => undefined;
  const native = AndroidDictation;
  // Words the tab is showing right now, so a second learn says "Learned 2 words".
  let showing: string[] = [];
  let showingUntil = 0;
  // What each misheard word was fixed to during this watch. Every report compares the field with the
  // text right after the dictation, so fixing "Sakets" to "Saket" and then to "Sakett" reports the
  // same misheard word twice: the newer spelling replaces the one learned a moment ago.
  const fixedTo = new Map<string, { word: string; at: number }>();

  const edited = dictationEvents.addListener('onFieldEdited', ({ before, after }) => {
    void loadLearnedWords().then(() => {
      const now = Date.now();
      for (const [from, fix] of fixedTo) if (now - fix.at > FIX_MEMORY_MS) fixedTo.delete(from);
      const pairs = extractCorrectionPairs(before, after, buildEffectiveDictionaryWords()).filter(
        (pair) =>
          fixedTo.get(pair.from.toLowerCase())?.word.toLowerCase() !== pair.word.toLowerCase(),
      );
      if (pairs.length === 0) return;
      const replaced: string[] = [];
      for (const pair of pairs) {
        const earlier = fixedTo.get(pair.from.toLowerCase());
        if (earlier) {
          forgetLearned(earlier.word);
          replaced.push(earlier.word.toLowerCase());
        }
      }
      const learned = learnCorrections(pairs, { kind: 'app' });
      for (const pair of pairs)
        if (learned.includes(pair.word))
          fixedTo.set(pair.from.toLowerCase(), { word: pair.word, at: now });
      if (learned.length === 0) return;
      const still =
        now < showingUntil ? showing.filter((w) => !replaced.includes(w.toLowerCase())) : [];
      showing = [...still, ...learned];
      showingUntil = now + 5000;
      void native.showLearnedTab({
        words: showing,
        message:
          showing.length === 1
            ? dictionaryT('learnedToast', { word: showing[0] })
            : dictionaryT('learnedManyToast', { count: showing.length }),
        undo: dictionaryT('undo'),
        undone:
          showing.length === 1
            ? dictionaryT('wontLearn', { word: showing[0] })
            : dictionaryT('wontLearnMany', { count: showing.length }),
      });
    });
  });
  const undone = dictationEvents.addListener('onLearnedUndo', ({ words }) => {
    for (const [from, fix] of fixedTo) if (words.includes(fix.word)) fixedTo.delete(from);
    showing = [];
    showingUntil = 0;
    void loadLearnedWords().then(() => unlearn(words));
  });
  // The app is coming to the front; its navigator may still be mounting, so this waits a beat.
  const open = dictationEvents.addListener('onOpenDictionary', () => {
    setTimeout(() => {
      try {
        router.navigate('/(tabs)/(dictionary)');
      } catch {
        // Not mounted yet: the app opens where it was, which is fine.
      }
    }, 400);
  });
  return () => {
    edited.remove();
    undone.remove();
    open.remove();
  };
}
