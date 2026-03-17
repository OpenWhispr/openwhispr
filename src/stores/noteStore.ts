import { create } from "zustand";
import type { NoteItem } from "../types/electron";

interface NoteState {
  notes: NoteItem[];
  activeNoteId: number | null;
  activeFolderId: number | null;
  migration: { total: number; done: number } | null;
}

const useNoteStore = create<NoteState>()(() => ({
  notes: [],
  activeNoteId: null,
  activeFolderId: null,
  migration: null,
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

export function useMigration(): { total: number; done: number } | null {
  return useNoteStore((state) => state.migration);
}

export async function syncNoteToCloud(note: NoteItem): Promise<void> {
  const { NotesService } = await import("../services/NotesService.js");
  const cloudNote = await NotesService.create({
    client_note_id: String(note.id),
    title: note.title,
    content: note.content,
    enhanced_content: note.enhanced_content,
    enhancement_prompt: note.enhancement_prompt,
    note_type: note.note_type,
    source_file: note.source_file,
    audio_duration_seconds: note.audio_duration_seconds,
    created_at: note.created_at,
    updated_at: note.updated_at,
  });
  await window.electronAPI.updateNoteCloudId(note.id, cloudNote.id);
  updateNoteInStore({ ...note, cloud_id: cloudNote.id });
}

export async function syncNoteUpdateToCloud(
  note: NoteItem,
  updates: Partial<NoteItem>
): Promise<void> {
  const { NotesService } = await import("../services/NotesService.js");
  if (note.cloud_id) {
    await NotesService.update(note.cloud_id, updates);
  } else {
    await syncNoteToCloud(note);
  }
}

export async function syncNoteDeleteToCloud(cloudId: string): Promise<void> {
  const { NotesService } = await import("../services/NotesService.js");
  await NotesService.delete(cloudId);
}

export async function startMigration(): Promise<void> {
  const allNotes = (await window.electronAPI?.getNotes(null, 9999, null)) ?? [];
  const unsynced = allNotes.filter((n) => !n.cloud_id);
  if (unsynced.length === 0) return;

  useNoteStore.setState({ migration: { total: unsynced.length, done: 0 } });

  const { NotesService } = await import("../services/NotesService.js");
  const CHUNK_SIZE = 50;

  for (let i = 0; i < unsynced.length; i += CHUNK_SIZE) {
    const chunk = unsynced.slice(i, i + CHUNK_SIZE);
    try {
      const { created } = await NotesService.batchCreate(
        chunk.map((n) => ({
          client_note_id: String(n.id),
          title: n.title,
          content: n.content,
          enhanced_content: n.enhanced_content,
          enhancement_prompt: n.enhancement_prompt,
          note_type: n.note_type,
          source_file: n.source_file,
          audio_duration_seconds: n.audio_duration_seconds,
          created_at: n.created_at,
          updated_at: n.updated_at,
        }))
      );
      await Promise.all(
        created.map(({ client_note_id, id: cloudId }) =>
          window.electronAPI.updateNoteCloudId(parseInt(client_note_id, 10), cloudId)
        )
      );
      useNoteStore.setState((s) => ({
        migration: s.migration
          ? {
              total: s.migration.total,
              done: Math.min(s.migration.done + chunk.length, s.migration.total),
            }
          : null,
      }));
    } catch (err) {
      console.error("Migration chunk failed:", err);
    }
  }

  useNoteStore.setState({ migration: null });
}
