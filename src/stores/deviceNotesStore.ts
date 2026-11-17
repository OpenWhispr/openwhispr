import { create } from "zustand";
import type { DeviceNoteFolder, DeviceNoteSummary, NoteItem } from "../types/electron";
import {
  clearActiveContext,
  loadFolders,
  openNote,
  setActiveNoteId,
  subscribeNoteView,
} from "./noteStore";

export type DeviceNotesMoveResult = { moved: NoteItem[] } | { error: string };

/** The notes to move (named, or a folder's), and where: a Private folder, or each into its folder of the same name. */
export interface DeviceNotesMoveRequest {
  noteIds?: number[];
  folderId?: number;
  targetFolderId?: number;
}

interface DeviceNotesState {
  folders: DeviceNoteFolder[];
  notes: DeviceNoteSummary[];
  /** The ownerless note shown read-only in the notes pane, if any. */
  viewNoteId: number | null;
  load: () => Promise<void>;
  openView: (id: number) => void;
  closeView: () => void;
  /**
   * Once the viewed note has left the list, closes the view and opens the note where it went
   * when this account can see it (moved or claimed into it), so the pane never sits empty.
   */
  followView: () => Promise<void>;
  move: (
    request: DeviceNotesMoveRequest,
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

// The note as this account now sees it, once it has left the list (moved or claimed into the
// account), or null.
async function ownedNote(id: number): Promise<NoteItem | null> {
  try {
    const note = await window.electronAPI?.getNote?.(id);
    return note && !note.deleted_at ? note : null;
  } catch {
    return null;
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

  // Clears what the tree had open first, so the listener below doesn't close the view at once and
  // only the device note's row reads as selected.
  openView: (id) => {
    setActiveNoteId(null);
    clearActiveContext();
    set({ viewNoteId: id });
  },
  closeView: () => set({ viewNoteId: null }),

  followView: async () => {
    const id = get().viewNoteId;
    if (id == null || (await noteStillListed(id))) return;
    const note = await ownedNote(id);
    if (get().viewNoteId !== id) return;
    get().closeView();
    if (note) openNote(note);
  },

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
    // Nothing moved means another window moved them first; the reload above drops their rows.
    return { moved: result.moved };
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
    // A move or claim in any window can make folders and change counts in this one's tree; the
    // folders are loaded before the viewed note is followed, so the tree can reveal it.
    const followChange = async (): Promise<void> => {
      await Promise.allSettled([get().load(), loadFolders()]);
      await get().followView();
    };
    const stopChanged = api?.onDeviceNotesChanged?.(() => void followChange());
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
