import { create } from "zustand";
import type { NoteItem } from "../types/electron";

interface NoteState {
  notes: NoteItem[];
  activeNoteId: number | null;
  activeFolderId: number | null;
}

const useNoteStore = create<NoteState>()(() => ({
  notes: [],
  activeNoteId: null,
  activeFolderId: null,
}));

let hasBoundIpcListeners = false;
const DEFAULT_LIMIT = 50;
let currentLimit = DEFAULT_LIMIT;

function ensureIpcListeners() {
  if (hasBoundIpcListeners || typeof window === "undefined") {
    return;
  }

  const disposers: Array<() => void> = [];

  if (window.electronAPI?.onNoteAdded) {
    const dispose = window.electronAPI.onNoteAdded((note) => {
      if (note) {
        addNote(note);
      }
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI?.onNoteUpdated) {
    const dispose = window.electronAPI.onNoteUpdated((note) => {
      if (note) {
        updateNoteInStore(note);
      }
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI?.onNoteDeleted) {
    const dispose = window.electronAPI.onNoteDeleted(({ id }) => {
      removeNote(id);
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  hasBoundIpcListeners = true;

  window.addEventListener("beforeunload", () => {
    disposers.forEach((dispose) => dispose());
  });
}

export async function initializeNotes(
  noteType?: string | null,
  limit = DEFAULT_LIMIT,
  folderId?: number | null
): Promise<NoteItem[]> {
  currentLimit = limit;
  ensureIpcListeners();
  const items = (await window.electronAPI?.getNotes(noteType, limit, folderId)) ?? [];
  useNoteStore.setState({ notes: items });
  return items;
}

export function addNote(note: NoteItem): void {
  if (!note) return;
  const { notes, activeFolderId } = useNoteStore.getState();
  if (activeFolderId && note.folder_id !== activeFolderId) return;
  const withoutDuplicate = notes.filter((existing) => existing.id !== note.id);
  useNoteStore.setState({ notes: [note, ...withoutDuplicate].slice(0, currentLimit) });
}

export function updateNoteInStore(note: NoteItem): void {
  if (!note) return;
  const { notes } = useNoteStore.getState();
  useNoteStore.setState({
    notes: notes.map((existing) => (existing.id === note.id ? note : existing)),
  });
}

export function removeNote(id: number): void {
  if (id == null) return;
  const { notes } = useNoteStore.getState();
  const next = notes.filter((item) => item.id !== id);
  if (next.length === notes.length) return;
  useNoteStore.setState({ notes: next });
}

export function setActiveNoteId(id: number | null): void {
  if (useNoteStore.getState().activeNoteId === id) return;
  useNoteStore.setState({ activeNoteId: id });
}

export function setActiveFolderId(id: number | null): void {
  if (useNoteStore.getState().activeFolderId === id) return;
  useNoteStore.setState({ activeFolderId: id });
}

export function getActiveNoteIdValue(): number | null {
  return useNoteStore.getState().activeNoteId;
}

export function getActiveFolderIdValue(): number | null {
  return useNoteStore.getState().activeFolderId;
}

export function useNotes(): NoteItem[] {
  return useNoteStore((state) => state.notes);
}

export function useActiveNoteId(): number | null {
  return useNoteStore((state) => state.activeNoteId);
}

export function useActiveFolderId(): number | null {
  return useNoteStore((state) => state.activeFolderId);
}
