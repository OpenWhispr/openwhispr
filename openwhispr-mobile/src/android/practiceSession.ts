import { create } from 'zustand';
import type { DictationMode } from './pipeline';

export const usePracticeSession = create<{
  active: boolean;
  completedMode: DictationMode | null;
  revision: number;
  complete: (mode: DictationMode) => void;
}>((set, get) => ({
  active: false,
  completedMode: null,
  revision: 0,
  complete: (mode) => {
    if (get().active) set((state) => ({ completedMode: mode, revision: state.revision + 1 }));
  },
}));
