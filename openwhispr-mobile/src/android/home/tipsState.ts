import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

const KEY = 'android.home.tips';

/** Every tip on Home, in the order they're listed. Ids, not positions, are saved as watched. */
export const TIP_IDS = ['dictate', 'assistant', 'translate', 'edit', 'size', 'hide'] as const;
export type TipId = (typeof TIP_IDS)[number];
export const TIP_COUNT = TIP_IDS.length;

/**
 * Builds before the six tips saved positions in a three-tip list: 0 start dictating, 1 bubble size,
 * 2 hide. Those map onto the same tips here, so nobody is shown a tip again that they already watched.
 */
const LEGACY_POSITIONS: Record<number, TipId> = { 0: 'dictate', 1: 'size', 2: 'hide' };

type Saved = { hidden: boolean; watched: TipId[] };

/** Reads what was saved, whether as ids or as the old three-tip positions. */
export function readWatched(value: unknown): TipId[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map((entry) =>
    typeof entry === 'number'
      ? LEGACY_POSITIONS[entry]
      : (TIP_IDS as readonly unknown[]).includes(entry)
        ? (entry as TipId)
        : undefined,
  );
  return [...new Set(ids.filter((id): id is TipId => id !== undefined))];
}

/**
 * Home's Tips: which videos the person has watched, and whether Tips is gone. Watching all
 * of them, or "Hide", removes Tips from Home for good. Kept on this phone only.
 */
export const useTips = create<
  Saved & {
    loaded: boolean;
    load: () => Promise<void>;
    watch: (id: TipId) => void;
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
        const saved = raw ? (JSON.parse(raw) as { hidden?: unknown; watched?: unknown }) : {};
        set({ hidden: saved.hidden === true, watched: readWatched(saved.watched), loaded: true });
      } catch {
        set({ loaded: true });
      }
    },
    watch: (id) => {
      if (get().watched.includes(id)) return;
      set({ watched: [...get().watched, id] });
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
