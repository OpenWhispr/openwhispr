import { router } from 'expo-router';
import { extractCorrectionPairs } from '@/lib/correctionLearner';
import { buildEffectiveDictionaryWords } from '@/lib/dictationHints';
import { AndroidDictation, dictationEvents } from '../../../modules/android-dictation/src';
import { learnCorrections, loadLearnedWords, unlearn } from './learned';
import { dictionaryT } from './strings';

/**
 * Dictionary's C11: after the bubble types into another app, the accessibility service reads that
 * one field again for 30 s. When the person fixes a word there, the edit arrives here, is learned
 * silently, and the bubble's tab says so with Undo. Nothing leaves the phone except as an ordinary
 * learned dictionary word.
 */
export function observeFieldLearning(): () => void {
  if (!dictationEvents || !AndroidDictation) return () => undefined;
  const native = AndroidDictation;
  // Words the tab is showing right now, so a second learn says "Learned 2 words".
  let showing: string[] = [];
  let showingUntil = 0;

  const edited = dictationEvents.addListener('onFieldEdited', ({ before, after }) => {
    void loadLearnedWords().then(() => {
      const pairs = extractCorrectionPairs(before, after, buildEffectiveDictionaryWords());
      if (pairs.length === 0) return;
      const learned = learnCorrections(pairs, { kind: 'app' });
      if (learned.length === 0) return;
      showing = Date.now() < showingUntil ? [...showing, ...learned] : learned;
      showingUntil = Date.now() + 5000;
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
