import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { useAuthStore } from '@/store/useAuthStore';
import { useDictionaryStore, type DictionaryEntry } from '@/store/useDictionaryStore';

const KEY = 'android.dictionary.learned';

/** Where a learned word came from. Kept on this phone only; the API only knows "learned". */
export type LearnedOrigin =
  | { kind: 'note'; noteId: number; title: string }
  | { kind: 'transcript'; noteId: number; title: string }
  | { kind: 'app' };

export type LearnedInfo = {
  /** The misheard spelling it replaced ("Sinty" for "Synty"). */
  from: string | null;
  origin: LearnedOrigin;
  learnedAt: number;
  /** Set once Keep was tapped (or the word was edited): it leaves the review stack. */
  keptAt: number | null;
};

type AccountState = {
  /** By lower-cased word. */
  learned: Record<string, LearnedInfo>;
  /** Lower-cased words never to learn again: Undo on a learned toast, Remove in review. */
  blocked: string[];
};

type Saved = Record<string, AccountState>;

const EMPTY: AccountState = { learned: {}, blocked: [] };

function accountKey(): string {
  return useAuthStore.getState().user?.id ?? 'guest';
}

export const useLearnedWords = create<{ saved: Saved; loaded: boolean }>(() => ({
  saved: {},
  loaded: false,
}));

let loading: Promise<void> | null = null;
export function loadLearnedWords(): Promise<void> {
  if (useLearnedWords.getState().loaded) return Promise.resolve();
  loading ??= AsyncStorage.getItem(KEY)
    .then((raw) => {
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      const saved = parsed && typeof parsed === 'object' ? (parsed as Saved) : {};
      // A write that landed before the read finished wins over what was on disk.
      const current = useLearnedWords.getState().saved;
      useLearnedWords.setState({ saved: { ...saved, ...current }, loaded: true });
    })
    .catch(() => useLearnedWords.setState({ loaded: true }));
  return loading;
}

function persist() {
  void AsyncStorage.setItem(KEY, JSON.stringify(useLearnedWords.getState().saved)).catch(
    () => undefined,
  );
}

function update(change: (state: AccountState) => AccountState) {
  const key = accountKey();
  const saved = useLearnedWords.getState().saved;
  useLearnedWords.setState({ saved: { ...saved, [key]: change(saved[key] ?? EMPTY) } });
  persist();
}

export function accountLearned(saved: Saved): AccountState {
  return saved[accountKey()] ?? EMPTY;
}

export function useAccountLearned(): AccountState {
  const saved = useLearnedWords((state) => state.saved);
  return accountLearned(saved);
}

const lower = (word: string) => word.trim().toLowerCase();

/**
 * Learns the corrections a fix revealed, leaving out words the person said no to and words
 * already in the dictionary. Returns the words it actually added.
 */
export function learnCorrections(
  pairs: { word: string; from: string | null }[],
  origin: LearnedOrigin,
): string[] {
  const { blocked } = accountLearned(useLearnedWords.getState().saved);
  const known = new Set(useDictionaryStore.getState().entries.map((entry) => lower(entry.word)));
  const fresh = pairs.filter(
    (pair) =>
      pair.word.trim() && !blocked.includes(lower(pair.word)) && !known.has(lower(pair.word)),
  );
  if (fresh.length === 0) return [];
  useDictionaryStore.getState().addLearnedWords(fresh.map((pair) => pair.word));
  const now = Date.now();
  update((state) => {
    const learned = { ...state.learned };
    for (const pair of fresh)
      learned[lower(pair.word)] = { from: pair.from, origin, learnedAt: now, keptAt: null };
    return { ...state, learned };
  });
  return fresh.map((pair) => pair.word);
}

/** Undo on a learned toast, or Remove in review: the word goes and is never learned again. */
export function unlearn(words: string[]) {
  for (const word of words) useDictionaryStore.getState().removeWord(word);
  update((state) => {
    const learned = { ...state.learned };
    for (const word of words) delete learned[lower(word)];
    const blocked = new Set(state.blocked);
    for (const word of words) blocked.add(lower(word));
    return { learned, blocked: [...blocked] };
  });
}

/** Keep: a learned word leaves the review stack and becomes one of "your words". */
export function keepLearned(word: string) {
  update((state) => {
    const info = state.learned[lower(word)];
    if (!info) return state;
    return {
      ...state,
      learned: { ...state.learned, [lower(word)]: { ...info, keptAt: Date.now() } },
    };
  });
}

/** An edit carries the word's history to its new spelling; editing counts as keeping it. */
export function renameLearned(from: string, to: string) {
  if (lower(from) === lower(to)) return;
  update((state) => {
    const info = state.learned[lower(from)];
    if (!info) return state;
    const learned = { ...state.learned };
    delete learned[lower(from)];
    learned[lower(to)] = { ...info, keptAt: info.keptAt ?? Date.now() };
    return { ...state, learned };
  });
}

/** A word added by hand is no longer blocked: the person asked for it. */
export function allowWords(words: string[]) {
  const asked = new Set(words.map(lower));
  update((state) => ({ ...state, blocked: state.blocked.filter((word) => !asked.has(word)) }));
}

export function learnedInfo(state: AccountState, word: string): LearnedInfo | null {
  return state.learned[lower(word)] ?? null;
}

/** Learned words still waiting for Keep or Remove, newest first. Only this phone's fixes. */
export function reviewQueue(
  entries: DictionaryEntry[],
  state: AccountState,
): (DictionaryEntry & { info: LearnedInfo })[] {
  return entries
    .filter((entry) => entry.source === 'learned')
    .flatMap((entry) => {
      const info = state.learned[lower(entry.word)];
      return info && info.keptAt == null ? [{ ...entry, info }] : [];
    })
    .sort((a, b) => b.info.learnedAt - a.info.learnedAt);
}

/** Undo of Remove: the word and its history come back as they were. */
export function restoreLearned(word: string, info: LearnedInfo) {
  update((state) => ({
    learned: { ...state.learned, [lower(word)]: info },
    blocked: state.blocked.filter((blocked) => blocked !== lower(word)),
  }));
  useDictionaryStore.getState().addLearnedWords([word]);
}

/**
 * A word learned a moment ago that the person then fixed again (Saket → Sakett): it goes quietly,
 * without being blocked, so the newer spelling can take its place.
 */
export function forgetLearned(word: string) {
  useDictionaryStore.getState().removeWord(word);
  update((state) => {
    const learned = { ...state.learned };
    delete learned[lower(word)];
    return { ...state, learned };
  });
}
