import { create } from 'zustand';
import { useNotesStore } from '@/android/store/useNotesStore';
import { showToast } from '../settings/kit';
import { notesT } from './strings';

/**
 * Delete with Undo, no dialog (Figma D1 and L9). The notes leave every list at once; the
 * delete itself runs only when the 6 s toast closes, so Undo never has to un-sync anything.
 */
export const usePendingDeletes = create<{ ids: number[]; restored: number[] }>(() => ({
  ids: [],
  restored: [],
}));

const UNDO_MS = 6000;

function commit(ids: number[]) {
  const { deleteNote } = useNotesStore.getState();
  for (const id of ids) {
    try {
      deleteNote(id);
    } catch {
      // A note that is already gone needs nothing more.
    }
  }
  usePendingDeletes.setState((state) => ({
    ids: state.ids.filter((id) => !ids.includes(id)),
  }));
}

export function deleteNotesWithUndo(ids: number[], title?: string) {
  if (ids.length === 0) return;
  usePendingDeletes.setState((state) => ({
    ids: [...state.ids, ...ids.filter((id) => !state.ids.includes(id))],
    restored: state.restored.filter((id) => !ids.includes(id)),
  }));
  let settled = false;
  const message =
    ids.length === 1
      ? notesT('deleted', { title: title || notesT('untitled') })
      : notesT('deletedMany', { count: ids.length });
  showToast(
    message,
    'neutral',
    {
      label: notesT('undo'),
      onPress: () => {
        if (settled) return;
        settled = true;
        usePendingDeletes.setState((state) => ({
          ids: state.ids.filter((id) => !ids.includes(id)),
          restored: [...state.restored, ...ids],
        }));
      },
      onClose: () => {
        if (settled) return;
        settled = true;
        commit(ids);
      },
    },
    { durationMs: UNDO_MS, aboveTabBar: true },
  );
}

/** A row brought back by Undo plays its way back in once, then is an ordinary row again. */
export function consumeRestored(id: number): boolean {
  const restored = usePendingDeletes.getState().restored.includes(id);
  if (restored)
    usePendingDeletes.setState((state) => ({
      restored: state.restored.filter((value) => value !== id),
    }));
  return restored;
}

export function useHiddenNoteIds(): number[] {
  return usePendingDeletes((state) => state.ids);
}
