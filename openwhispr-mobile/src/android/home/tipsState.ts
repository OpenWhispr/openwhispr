import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

const KEY = 'android.home.tips';
export const TIP_COUNT = 3;

type Saved = { hidden: boolean; watched: number[] };

/**
 * Home's Tips: which videos the person has watched, and whether Tips is gone. Watching all
 * three, or "Hide", removes Tips from Home for good. Kept on this phone only.
 */
export const useTips = create<
  Saved & {
    loaded: boolean;
    load: () => Promise<void>;
    watch: (index: number) => void;
    hide: () => void;
  }
>((set, get) => {
  const save = () => {
    const { hidden, watched } = get();
    void AsyncStorage.setItem(KEY, JSON.stringify({ hidden, watched })).catch(() => undefined);
  };
  return {
    hidden: false,
    watched: [],
    loaded: false,
    load: async () => {
      if (get().loaded) return;
      try {
        const raw = await AsyncStorage.getItem(KEY);
        const saved = raw ? (JSON.parse(raw) as Partial<Saved>) : {};
        set({
          hidden: saved.hidden === true,
          watched: Array.isArray(saved.watched)
            ? saved.watched.filter((index) => Number.isInteger(index))
            : [],
          loaded: true,
        });
      } catch {
        set({ loaded: true });
      }
    },
    watch: (index) => {
      if (get().watched.includes(index)) return;
      set({ watched: [...get().watched, index] });
      save();
    },
    hide: () => {
      set({ hidden: true });
      save();
    },
  };
});

/** Tips shows until the person hides it or has watched every video. */
export function tipsVisible({ loaded, hidden, watched }: Saved & { loaded: boolean }): boolean {
  return loaded && !hidden && new Set(watched).size < TIP_COUNT;
}
