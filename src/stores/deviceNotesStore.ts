import { create } from "zustand";
import type { DeviceNoteFolder, DeviceNoteSummary, NoteItem } from "../types/electron";
import { loadFolders, subscribeNoteView } from "./noteStore";

export type DeviceNotesMoveResult = { moved: NoteItem[] } | { error: string };

interface DeviceNotesState {
  folders: DeviceNoteFolder[];
  notes: DeviceNoteSummary[];
  /** The ownerless note shown read-only in the notes pane, if any. */
  viewNoteId: number | null;
  load: () => Promise<void>;
  openView: (id: number) => void;
  closeView: () => void;
  move: (
    request: { noteIds?: number[]; folderId?: number },
    context: { workspaceId: string | null }
  ) => Promise<DeviceNotesMoveResult>;
  /** Keeps the list and the view current; returns the way to stop. */
  startListening: () => () => void;
}

// Main's active account, from its database scope rather than the auth snapshot: a move names it,
// so main refuses one asked for before an account switch.
let accountId: string | null = null;
let loadGeneration = 0;

async function noteStillListed(id: number): Promise<boolean> {
  try {
    return (await window.electronAPI?.getDeviceNote?.(id)) != null;
  } catch {
    return false;
  }
}

export const useDeviceNotesStore = create<DeviceNotesState>()((set, get) => ({
  folders: [],
  notes: [],
  viewNoteId: null,

  load: async () => {
    const generation = ++loadGeneration;
    try {
      const list = await window.electronAPI?.getDeviceNotes?.();
      if (list && generation === loadGeneration) set({ folders: list.folders, notes: list.notes });
    } catch {
      // The list stays as it was; the next change reads it again.
    }
  },

  openView: (id) => set({ viewNoteId: id }),
  closeView: () => set({ viewNoteId: null }),

  move: async (request, { workspaceId }) => {
    let result;
    try {
      result = await window.electronAPI?.moveDeviceNotes?.({ ...request, workspaceId, accountId });
    } catch (error) {
      return { error: (error as Error).message };
    }
    if (!result) return { error: "unavailable" };
    if (!result.success) return { error: result.code };
    // Awaited so a caller opening the moved note finds its folder.
    await Promise.allSettled([loadFolders(), get().load()]);
    return result.moved.length > 0 ? { moved: result.moved } : { error: "nothing_moved" };
  },

  startListening: () => {
    const api = window.electronAPI;
    let heardScope = false;
    api?.getDatabaseAccountScope?.().then(
      (scope) => {
        if (!heardScope) accountId = scope.accountId;
      },
      () => {}
    );
    const stopScope = api?.onDatabaseAccountScopeChanged?.((scope) => {
      heardScope = true;
      if (scope.accountId !== accountId) get().closeView();
      accountId = scope.accountId;
      void get().load();
    });
    const stopChanged = api?.onDeviceNotesChanged?.(() => {
      void get().load();
      const id = get().viewNoteId;
      if (id == null) return;
      void noteStillListed(id).then((listed) => {
        if (!listed && get().viewNoteId === id) get().closeView();
      });
    });
    // Opening a note or a container replaces the view.
    const stopNoteView = subscribeNoteView((view, previous) => {
      if (view.activeNoteId != null || view.activeContext !== previous.activeContext) {
        get().closeView();
      }
    });
    // Nothing keeps the view current once these stop, so it closes with them.
    return () => {
      stopScope?.();
      stopChanged?.();
      stopNoteView();
      get().closeView();
    };
  },
}));
