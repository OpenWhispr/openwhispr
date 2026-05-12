import { create } from "zustand";
import type { NoteItem, NoteShareInvitation, ShareSettings } from "../types/electron";

export interface NoteShareCacheEntry {
  share: ShareSettings;
  invitations: NoteShareInvitation[];
  // Raw token is returned by the API exactly once (on generate or rotate)
  // and is only kept in memory for the active dialog session.
  rawToken: string | null;
}

interface NoteState {
  notes: NoteItem[];
  activeNoteId: number | null;
  activeFolderId: number | null;
  migration: { total: number; done: number } | null;
  shareByCloudId: Map<string, NoteShareCacheEntry>;
}

const useNoteStore = create<NoteState>()(() => ({
  notes: [],
  activeNoteId: null,
  activeFolderId: null,
  migration: null,
  shareByCloudId: new Map<string, NoteShareCacheEntry>(),
}));

let hasBoundIpcListeners = false;
const DEFAULT_LIMIT = 50;
let currentLimit = DEFAULT_LIMIT;
let loadGeneration = 0;

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
  const gen = ++loadGeneration;
  currentLimit = limit;
  ensureIpcListeners();
  const items = (await window.electronAPI?.getNotes(noteType, limit, folderId)) ?? [];
  if (gen !== loadGeneration) return items;
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
  const { notes, activeNoteId } = useNoteStore.getState();
  const next = notes.filter((item) => item.id !== id);
  if (next.length === notes.length) return;
  const update: Partial<NoteState> = { notes: next };
  if (activeNoteId === id) {
    const idx = notes.findIndex((item) => item.id === id);
    const neighbor = next[Math.min(idx, next.length - 1)] ?? null;
    update.activeNoteId = neighbor?.id ?? null;
  }
  useNoteStore.setState(update);
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
          client_note_id: n.client_note_id,
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
      const notesByClientId = new Map(chunk.map((n) => [n.client_note_id, n]));
      await Promise.all(
        created.map(({ client_note_id, id: cloudId }) => {
          const local = notesByClientId.get(client_note_id);
          return local
            ? window.electronAPI.updateNoteCloudId(local.id, cloudId)
            : Promise.resolve();
        })
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

export function setShareCache(cloudId: string, entry: NoteShareCacheEntry): void {
  const { shareByCloudId } = useNoteStore.getState();
  const next = new Map(shareByCloudId);
  next.set(cloudId, entry);
  useNoteStore.setState({ shareByCloudId: next });
}

export function updateShareCache(
  cloudId: string,
  updater: (current: NoteShareCacheEntry | undefined) => NoteShareCacheEntry
): void {
  const { shareByCloudId } = useNoteStore.getState();
  const next = new Map(shareByCloudId);
  next.set(cloudId, updater(next.get(cloudId)));
  useNoteStore.setState({ shareByCloudId: next });
}

export function clearShareCache(cloudId: string): void {
  const { shareByCloudId } = useNoteStore.getState();
  if (!shareByCloudId.has(cloudId)) return;
  const next = new Map(shareByCloudId);
  next.delete(cloudId);
  useNoteStore.setState({ shareByCloudId: next });
}

export function useShareCacheEntry(cloudId: string | null): NoteShareCacheEntry | null {
  return useNoteStore((state) =>
    cloudId ? state.shareByCloudId.get(cloudId) ?? null : null
  );
}
