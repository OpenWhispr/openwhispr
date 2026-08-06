import { create } from "zustand";
import { syncService } from "../services/SyncService.js";
import { resolveRendererCloudNoteCreateBatch } from "../services/noteCreateAck";
import {
  createClearedAccountNoteState,
  invalidateKeyedLoadGenerations,
  removeNoteFromLists,
  teardownNoteContainers,
} from "./noteListOps";
import {
  addNoteConflict,
  clearNoteConflicts,
  readNoteConflicts,
  removeNoteConflictId,
} from "../lib/noteConflictRegistry";
import { findDefaultFolder } from "../components/notes/shared";
import type { CloudNote } from "../services/NotesService.js";
import type {
  FolderItem,
  NoteAccessState,
  NoteItem,
  NoteShareInvitation,
  ShareSettings,
  SpaceItem,
} from "../types/electron";

export interface NoteShareCacheEntry {
  share: ShareSettings;
  invitations: NoteShareInvitation[];
  access?: NoteAccessState;
  // Raw token is returned by the API exactly once (on generate or rotate)
  // and is only kept in memory for the active dialog session.
  rawToken: string | null;
}

export interface ActiveContext {
  spaceId: number;
  folderId: number | null;
}

interface NoteState {
  notes: NoteItem[];
  spaces: SpaceItem[];
  folders: FolderItem[];
  folderCounts: Record<number, number>;
  // Notes sitting at a space root (folder_id NULL), keyed by space id — the
  // tree's space rows show true totals without loading containers.
  spaceRootCounts: Record<number, number>;
  notesByContainer: Record<string, NoteItem[]>;
  expandedContainers: Set<string>;
  activeContext: ActiveContext | null;
  activeNoteId: number | null;
  isTreeLoading: boolean;
  migration: { total: number; done: number } | null;
  shareByCloudId: Map<string, NoteShareCacheEntry>;
  // Cloud versions that arrived while the local row had unpushed edits,
  // keyed by client_note_id. Consumed by the editor's conflict banner.
  noteConflicts: Record<string, CloudNote>;
}

const EXPANDED_STORAGE_KEY = "notesTree.expanded";

function readExpandedContainers(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function persistExpandedContainers(expanded: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...expanded]));
  } catch {
    // localStorage unavailable — expansion just won't persist
  }
}

const useNoteStore = create<NoteState>()(() => ({
  notes: [],
  spaces: [],
  folders: [],
  folderCounts: {},
  spaceRootCounts: {},
  notesByContainer: {},
  expandedContainers: readExpandedContainers(),
  activeContext: null,
  activeNoteId: null,
  isTreeLoading: true,
  migration: null,
  shareByCloudId: new Map<string, NoteShareCacheEntry>(),
  noteConflicts: readNoteConflicts(),
}));

// Drive SyncService's faster pull off the open note. Keyed on activeNoteId (not
// just open/closed) so switching notes also refreshes, and so account-reset
// teardown that clears it via setState stops the fast pull too.
let syncedActiveNoteId: number | null = null;
useNoteStore.subscribe((state) => {
  if (state.activeNoteId === syncedActiveNoteId) return;
  syncedActiveNoteId = state.activeNoteId;
  syncService.setNoteOpen(state.activeNoteId != null);
});

let hasBoundIpcListeners = false;
const DEFAULT_LIMIT = 50;
let currentLimit = DEFAULT_LIMIT;
let loadGeneration = 0;
let treeLoadGeneration = 0;
let spacesLoadGeneration = 0;
let foldersLoadGeneration = 0;
let migrationGeneration = 0;
let accountGeneration = 0;
// Folder navigation requested before folders load; consumed once by initializeNotesTree.
let pendingFolderPreset: number | null = null;

export function folderContainerKey(folderId: number): string {
  return `f:${folderId}`;
}

export function spaceContainerKey(spaceId: number): string {
  return `s:${spaceId}`;
}

export function contextContainerKey(context: ActiveContext): string {
  return context.folderId != null
    ? folderContainerKey(context.folderId)
    : spaceContainerKey(context.spaceId);
}

function noteContainerKey(note: NoteItem): string {
  return note.folder_id != null
    ? folderContainerKey(note.folder_id)
    : spaceContainerKey(note.space_id);
}

function findNoteInState(state: NoteState, id: number): NoteItem | null {
  for (const items of Object.values(state.notesByContainer)) {
    const note = items.find((n) => n.id === id);
    if (note) return note;
  }
  return state.notes.find((n) => n.id === id) ?? null;
}

/** Apply a notesByContainer replacement, mirroring the active container into the flat `notes` list. */
function applyContainers(
  notesByContainer: Record<string, NoteItem[]>,
  extra: Partial<NoteState> = {}
): void {
  const state = useNoteStore.getState();
  const context = state.activeContext;
  const activeKey = context ? contextContainerKey(context) : null;
  const update: Partial<NoteState> = { notesByContainer, ...extra };
  if (activeKey && notesByContainer[activeKey] && notesByContainer[activeKey] !== state.notes) {
    update.notes = notesByContainer[activeKey];
  }
  useNoteStore.setState(update);
}

function ensureIpcListeners() {
  if (hasBoundIpcListeners || typeof window === "undefined") {
    return;
  }

  const disposers: Array<() => void> = [];

  if (window.electronAPI.onNoteAdded) {
    const dispose = window.electronAPI.onNoteAdded((note) => {
      if (note) {
        addNote(note);
        loadFolders();
      }
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI.onNoteUpdated) {
    const dispose = window.electronAPI.onNoteUpdated((note) => {
      if (note) {
        const previous = findNoteInState(useNoteStore.getState(), note.id);
        updateNoteInStore(note);
        if (previous && noteContainerKey(previous) !== noteContainerKey(note)) {
          loadFolders();
        }
        // Sharing is per-note consent, and so is team-space membership: edits
        // to a shared or team note must reach the cloud promptly even when
        // the global backup toggle is off (teammates poll for them). A note
        // that just LEFT a team also pushes promptly — the server row stays
        // visible to teammates until its scope retraction lands (D6).
        const spaceKind = useNoteStore.getState().spaces.find((s) => s.id === note.space_id)?.kind;
        if (note.is_shared || spaceKind === "team" || (note.left_team && note.cloud_id)) {
          syncService.debouncedPush("note", note.id);
        }
      }
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI.onNoteDeleted) {
    const dispose = window.electronAPI.onNoteDeleted(({ id }) => {
      removeNote(id);
      loadFolders();
      // Push the tombstone right away so a shared link stops serving now,
      // not at the next ambient pass ("manual" bypasses the throttle).
      syncService.requestSyncAll("manual");
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  // Cloud-origin rows applied by a sync pull. Unlike onNoteUpdated, these
  // must NEVER trigger debouncedPush — they were just pulled from the cloud.
  // Routing through updateNoteInStore also refreshes an open clean editor
  // (PersonalNotesView's external-update resync); a dirty editor keeps its
  // buffer and the conflict-banner path covers it.
  if (window.electronAPI.onNoteSynced) {
    const dispose = window.electronAPI.onNoteSynced((note) => {
      if (!note) return;
      const state = useNoteStore.getState();
      // Backfilled team content can reference a space the store hasn't seen.
      if (!state.spaces.some((s) => s.id === note.space_id)) void loadSpaces();
      const previous = findNoteInState(state, note.id);
      if (previous) {
        updateNoteInStore(note);
        if (noteContainerKey(previous) !== noteContainerKey(note)) void loadFolders();
      } else {
        addNote(note);
        void loadFolders();
      }
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI.onFolderSynced) {
    const dispose = window.electronAPI.onFolderSynced((folder) => {
      if (!folder) return;
      void loadFolders();
      void loadSpaces();
      // A pulled folder change (rename, space move, revocation relocation)
      // can invalidate its cached container — re-read it if loaded.
      const key = folderContainerKey(folder.id);
      if (useNoteStore.getState().notesByContainer[key]) void loadContainerNotes(key);
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  // Folder hard-deletes (pulled tombstones, revocation cascades, and the
  // echo of local deletes) — drop the container and refresh counts. The
  // UI-originated deleteFolder already cleaned up by the time the echo
  // arrives, so every step here is idempotent.
  if (window.electronAPI.onFolderDeleted) {
    const dispose = window.electronAPI.onFolderDeleted(({ id }) => {
      if (id == null) return;
      const state = useNoteStore.getState();
      const key = folderContainerKey(id);
      const teardown = teardownNoteContainers(state, [key]);
      persistExpandedContainers(teardown.expandedContainers);
      const extra: Partial<NoteState> = {
        expandedContainers: teardown.expandedContainers,
        activeNoteId: teardown.activeNoteId,
      };
      let fallbackContext: ActiveContext | null = null;
      if (state.activeContext?.folderId === id) {
        // The active folder vanished under us — degrade to its space root.
        fallbackContext = { spaceId: state.activeContext.spaceId, folderId: null };
        extra.activeContext = fallbackContext;
        extra.notes = teardown.notesByContainer[contextContainerKey(fallbackContext)] ?? [];
      }
      useNoteStore.setState({ notesByContainer: teardown.notesByContainer, ...extra });
      if (fallbackContext) void ensureContainerLoaded(contextContainerKey(fallbackContext));
      void loadFolders();
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  // Conflict signals rebroadcast through the main process because the sync
  // pull usually runs in the overlay window, not the one showing the editor.
  // Broadcasts echo to the emitting window; both setters are idempotent.
  if (window.electronAPI.onSyncEvent) {
    const dispose = window.electronAPI.onSyncEvent(({ name, payload }) => {
      if (name === "note-conflict") {
        const data = payload as { clientNoteId?: string; cloudNote?: CloudNote } | undefined;
        if (data?.clientNoteId && data.cloudNote) {
          setNoteConflict(data.clientNoteId, data.cloudNote);
        }
      } else if (name === "note-conflict-clear") {
        const data = payload as { clientNoteId?: string } | undefined;
        if (data?.clientNoteId) clearNoteConflict(data.clientNoteId);
      }
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI.onSpacePurged) {
    const dispose = window.electronAPI.onSpacePurged(({ spaceId }) => {
      handleSpacePurged(spaceId);
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  // Space rows written by a sync pull or membership mutation.
  if (window.electronAPI.onSpaceSynced) {
    const dispose = window.electronAPI.onSpaceSynced((space) => {
      if (space) void loadSpaces();
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

export async function loadSpaces(): Promise<SpaceItem[]> {
  const gen = ++spacesLoadGeneration;
  const items = (await window.electronAPI.getSpaces?.()) ?? [];
  // A newer load may have resolved first.
  if (gen !== spacesLoadGeneration) return items;
  useNoteStore.setState({ spaces: items });
  return items;
}

export async function loadFolders(): Promise<FolderItem[]> {
  const gen = ++foldersLoadGeneration;
  const [items, counts] = await Promise.all([
    window.electronAPI.getFolders(),
    window.electronAPI.getFolderNoteCounts(),
  ]);
  if (gen !== foldersLoadGeneration) return items;
  const folderCounts: Record<number, number> = {};
  const spaceRootCounts: Record<number, number> = {};
  counts.forEach((c) => {
    if (c.folder_id != null) folderCounts[c.folder_id] = c.count;
    else if (c.space_id != null) spaceRootCounts[c.space_id] = c.count;
  });
  useNoteStore.setState({ folders: items, folderCounts, spaceRootCounts });
  return items;
}

const containerLoadGenerations = new Map<string, number>();
const containerLoadsInFlight = new Map<string, Promise<NoteItem[]>>();

/**
 * Synchronously remove account-scoped renderer state and invalidate every
 * async load that could otherwise repopulate it after the database purge.
 * IPC listeners stay bound; the next mounted notes view reloads clean state.
 */
export function resetForAccountChange(): void {
  currentLimit = DEFAULT_LIMIT;
  loadGeneration += 1;
  treeLoadGeneration += 1;
  spacesLoadGeneration += 1;
  foldersLoadGeneration += 1;
  migrationGeneration += 1;
  accountGeneration += 1;
  pendingFolderPreset = null;
  purgeDisplacedNote = null;

  invalidateKeyedLoadGenerations(containerLoadGenerations);
  containerLoadsInFlight.clear();

  try {
    localStorage.removeItem(EXPANDED_STORAGE_KEY);
  } catch {
    // In-memory state is still cleared below.
  }
  clearNoteConflicts();
  useNoteStore.setState(
    createClearedAccountNoteState<SpaceItem, FolderItem, NoteShareCacheEntry, CloudNote>()
  );
}

export async function loadContainerNotes(
  key: string,
  noteType: string | null = null,
  limit = DEFAULT_LIMIT
): Promise<NoteItem[]> {
  const gen = (containerLoadGenerations.get(key) ?? 0) + 1;
  containerLoadGenerations.set(key, gen);
  const load = (async (): Promise<NoteItem[]> => {
    const [kind, idStr] = key.split(":");
    const id = Number(idStr);
    const items =
      kind === "f"
        ? ((await window.electronAPI.getNotes(noteType, limit, id)) ?? [])
        : ((await window.electronAPI.getNotes(noteType, limit, null, id)) ?? []);
    // A newer load for this container may have resolved first.
    if (containerLoadGenerations.get(key) === gen) {
      applyContainers({ ...useNoteStore.getState().notesByContainer, [key]: items });
    }
    return items;
  })();
  containerLoadsInFlight.set(key, load);
  try {
    return await load;
  } finally {
    if (containerLoadsInFlight.get(key) === load) containerLoadsInFlight.delete(key);
  }
}

export async function ensureContainerLoaded(key: string): Promise<NoteItem[]> {
  const cached = useNoteStore.getState().notesByContainer[key];
  if (cached) return cached;
  return containerLoadsInFlight.get(key) ?? loadContainerNotes(key);
}

export function setContainerExpanded(key: string, expanded: boolean): void {
  const current = useNoteStore.getState().expandedContainers;
  if (current.has(key) !== expanded) {
    const next = new Set(current);
    if (expanded) next.add(key);
    else next.delete(key);
    useNoteStore.setState({ expandedContainers: next });
    persistExpandedContainers(next);
  }
  if (expanded) void ensureContainerLoaded(key);
}

export function toggleContainerExpanded(key: string): void {
  setContainerExpanded(key, !useNoteStore.getState().expandedContainers.has(key));
}

/** Expand the containers that make a space/folder (and its notes) visible in the tree. */
export function revealContainer(spaceId: number, folderId: number | null): void {
  setContainerExpanded(spaceContainerKey(spaceId), true);
  if (folderId != null) setContainerExpanded(folderContainerKey(folderId), true);
}

export function setActiveContext(spaceId: number, folderId: number | null): void {
  const state = useNoteStore.getState();
  const key = folderId != null ? folderContainerKey(folderId) : spaceContainerKey(spaceId);
  useNoteStore.setState({
    activeContext: { spaceId, folderId },
    notes: state.notesByContainer[key] ?? [],
  });
  void ensureContainerLoaded(key);
}

/**
 * Loads spaces, folders and counts, resolves the initial active context
 * (honoring a pending folder preset or a prior activeContext, e.g. navigating
 * from search), loads the active container and auto-selects its first note
 * when none is pre-set.
 */
export async function initializeNotesTree(): Promise<void> {
  const gen = ++treeLoadGeneration;
  ensureIpcListeners();
  useNoteStore.setState({ isTreeLoading: true });
  try {
    const [spaces, folders] = await Promise.all([loadSpaces(), loadFolders()]);
    if (gen !== treeLoadGeneration) return;

    const presetFolderId = pendingFolderPreset;
    pendingFolderPreset = null;
    const presetFolder =
      presetFolderId != null ? folders.find((f) => f.id === presetFolderId) : undefined;
    const preset = useNoteStore.getState().activeContext;
    const presetContext =
      preset &&
      spaces.some((s) => s.id === preset.spaceId) &&
      (preset.folderId == null || folders.some((f) => f.id === preset.folderId))
        ? preset
        : null;
    const privateSpace = spaces.find((s) => s.kind === "private") ?? spaces[0];
    let context: ActiveContext | null = null;
    if (presetFolder) {
      context = { spaceId: presetFolder.space_id, folderId: presetFolder.id };
    } else if (presetContext) {
      context = presetContext;
    } else if (privateSpace) {
      const privateFolders = folders.filter((f) => f.space_id === privateSpace.id);
      const initialFolder = findDefaultFolder(privateFolders) ?? privateFolders[0];
      context = { spaceId: privateSpace.id, folderId: initialFolder?.id ?? null };
    }
    if (!context) return;

    revealContainer(context.spaceId, context.folderId);
    useNoteStore.setState({ activeContext: context });
    // The store stays IPC-maintained across mounts, so an existing container
    // entry is current — reuse it (or revealContainer's in-flight load)
    // instead of fetching the same container twice on every init.
    const notes = await ensureContainerLoaded(contextContainerKey(context));
    if (gen !== treeLoadGeneration) return;
    // Containers restored as expanded from a previous session must load their
    // notes too, or they render expanded-but-empty until re-toggled.
    const validKeys = new Set<string>([
      ...spaces.map((s) => spaceContainerKey(s.id)),
      ...folders.map((f) => folderContainerKey(f.id)),
    ]);
    useNoteStore.getState().expandedContainers.forEach((key) => {
      if (validKeys.has(key)) void ensureContainerLoaded(key);
    });
    if (getActiveNoteIdValue() == null && notes.length > 0) {
      setActiveNoteId(notes[0].id);
    }
  } finally {
    if (gen === treeLoadGeneration) useNoteStore.setState({ isTreeLoading: false });
  }
}

export async function initializeNotes(
  noteType?: string | null,
  limit = DEFAULT_LIMIT,
  folderId?: number | null
): Promise<NoteItem[]> {
  currentLimit = limit;
  ensureIpcListeners();
  if (folderId != null) {
    return loadContainerNotes(folderContainerKey(folderId), noteType ?? null, limit);
  }

  const gen = ++loadGeneration;
  const items = (await window.electronAPI.getNotes(noteType, limit, folderId)) ?? [];
  if (gen !== loadGeneration) return items;
  useNoteStore.setState({ notes: items });
  return items;
}

export function addNote(note: NoteItem): void {
  if (!note) return;
  const state = useNoteStore.getState();
  const key = noteContainerKey(note);
  const items = state.notesByContainer[key];
  // Not-yet-loaded containers pick the note up on their lazy load.
  if (!items) return;
  const next = [note, ...items.filter((existing) => existing.id !== note.id)].slice(
    0,
    currentLimit
  );
  applyContainers({ ...state.notesByContainer, [key]: next });
}

export function updateNoteInStore(note: NoteItem): void {
  if (!note) return;
  const state = useNoteStore.getState();
  const targetKey = noteContainerKey(note);
  const notesByContainer = { ...state.notesByContainer };
  let changed = false;
  for (const [key, items] of Object.entries(state.notesByContainer)) {
    const idx = items.findIndex((existing) => existing.id === note.id);
    if (idx === -1) continue;
    changed = true;
    if (key === targetKey) {
      const next = items.slice();
      next[idx] = note;
      notesByContainer[key] = next;
    } else {
      // The note moved container (folder/space change) — relocate it.
      notesByContainer[key] = items.filter((existing) => existing.id !== note.id);
    }
  }
  const target = notesByContainer[targetKey];
  if (target && !target.some((existing) => existing.id === note.id)) {
    notesByContainer[targetKey] = [note, ...target].slice(0, currentLimit);
    changed = true;
  }
  if (changed) applyContainers(notesByContainer);
}

export function removeNote(id: number): void {
  if (id == null) return;
  const state = useNoteStore.getState();
  const result = removeNoteFromLists(state, id);
  if (!result.changed) return;
  // applyContainers only mirrors the active container into `notes`; pass the
  // filtered flat list explicitly so flat-only notes disappear too.
  const extra: Partial<NoteState> = { notes: result.notes };
  if (result.activeNoteId !== state.activeNoteId) {
    extra.activeNoteId = result.activeNoteId;
  }
  applyContainers(result.notesByContainer, extra);
}

// The note the user was reading when its space's purge cleared activeNoteId.
// The space-revoked toast (raised afterwards, from whichever window ran the
// sync pass) names it; consume-once and short-lived so a stale memo can't
// attach to a later, unrelated revocation.
let purgeDisplacedNote: { spaceId: number; title: string | null; at: number } | null = null;
const PURGE_DISPLACED_NOTE_TTL_MS = 30_000;

export function readPurgeDisplacedNote(spaceId: number): { title: string | null } | null {
  const memo = purgeDisplacedNote;
  if (!memo || memo.spaceId !== spaceId || Date.now() - memo.at > PURGE_DISPLACED_NOTE_TTL_MS) {
    return null;
  }
  purgeDisplacedNote = null;
  return { title: memo.title };
}

function handleSpacePurged(spaceId: number): void {
  const state = useNoteStore.getState();
  const purgedCloudSpaceId = state.spaces.find((s) => s.id === spaceId)?.cloud_space_id ?? null;
  const removedKeys = new Set<string>([spaceContainerKey(spaceId)]);
  state.folders.forEach((f) => {
    if (f.space_id === spaceId) removedKeys.add(folderContainerKey(f.id));
  });

  const teardown = teardownNoteContainers(state, removedKeys);
  const folderCounts = { ...state.folderCounts };
  state.folders.forEach((f) => {
    if (f.space_id === spaceId) delete folderCounts[f.id];
  });
  const spaceRootCounts = { ...state.spaceRootCounts };
  delete spaceRootCounts[spaceId];
  persistExpandedContainers(teardown.expandedContainers);

  // Purge completeness (plan §5.4): purged notes' share-cache entries (which
  // can hold raw link tokens) and conflict banners (which hold full cloud
  // copies) must not outlive the space in renderer memory. Conflicts are
  // matched by the team's cloud id too, since their notes' containers may
  // never have been loaded.
  const purgedCloudIds = new Set<string>();
  const purgedClientIds = new Set<string>();
  teardown.removedNotes.forEach((note) => {
    if (note.cloud_id) purgedCloudIds.add(note.cloud_id);
    purgedClientIds.add(note.client_note_id);
  });
  const shareByCloudId = new Map(state.shareByCloudId);
  purgedCloudIds.forEach((id) => shareByCloudId.delete(id));
  const noteConflicts = Object.fromEntries(
    Object.entries(state.noteConflicts).filter(
      ([clientId, cloudNote]) =>
        !purgedClientIds.has(clientId) &&
        (purgedCloudSpaceId == null || cloudNote.space_id !== purgedCloudSpaceId)
    )
  );
  Object.keys(state.noteConflicts).forEach((clientId) => {
    if (!(clientId in noteConflicts)) removeNoteConflictId(clientId);
  });

  const extra: Partial<NoteState> = {
    spaces: state.spaces.filter((s) => s.id !== spaceId),
    folders: state.folders.filter((f) => f.space_id !== spaceId),
    folderCounts,
    spaceRootCounts,
    expandedContainers: teardown.expandedContainers,
    activeNoteId: teardown.activeNoteId,
    shareByCloudId,
    noteConflicts,
  };
  const activeNote = state.activeNoteId != null ? findNoteInState(state, state.activeNoteId) : null;
  if (activeNote?.space_id === spaceId) {
    extra.activeNoteId = null;
    // Only synced rows are deleted by the purge; dirty rows relocate to
    // Personal and already announce themselves with a titled toast.
    if (activeNote.sync_status === "synced" && activeNote.cloud_id) {
      purgeDisplacedNote = { spaceId, title: activeNote.title, at: Date.now() };
    }
  }

  let fallbackContext: ActiveContext | null = null;
  if (state.activeContext?.spaceId === spaceId) {
    const privateSpace = extra.spaces?.find((s) => s.kind === "private");
    if (privateSpace) {
      const privateFolders = state.folders.filter((f) => f.space_id === privateSpace.id);
      const fallbackFolder = findDefaultFolder(privateFolders) ?? privateFolders[0];
      fallbackContext = { spaceId: privateSpace.id, folderId: fallbackFolder?.id ?? null };
      extra.activeContext = fallbackContext;
      extra.notes = teardown.notesByContainer[contextContainerKey(fallbackContext)] ?? [];
    }
  }
  useNoteStore.setState({ notesByContainer: teardown.notesByContainer, ...extra });
  if (fallbackContext) void ensureContainerLoaded(contextContainerKey(fallbackContext));
  // The purge relocates never-synced notes to the private space root —
  // refresh counts, and the root container when it's already cached.
  void loadFolders();
  const privateSpace = state.spaces.find((s) => s.kind === "private" && s.id !== spaceId);
  if (privateSpace) {
    const privateRootKey = spaceContainerKey(privateSpace.id);
    if (useNoteStore.getState().notesByContainer[privateRootKey]) {
      void loadContainerNotes(privateRootKey);
    }
  }
}

export async function createFolder(
  name: string,
  spaceId: number
): Promise<{ success: boolean; folder?: FolderItem; error?: string }> {
  const result = await window.electronAPI.createFolder(name, spaceId);
  if (result.success && result.folder) {
    await loadFolders();
    syncService.debouncedPush("folder", result.folder.id);
  }
  return result;
}

export async function renameFolder(
  id: number,
  name: string
): Promise<{ success: boolean; folder?: FolderItem; error?: string }> {
  const result = await window.electronAPI.renameFolder(id, name);
  if (result.success) {
    await loadFolders();
    syncService.debouncedPush("folder", id);
  }
  return result;
}

export async function deleteFolder(id: number): Promise<{ success: boolean; error?: string }> {
  const result = await window.electronAPI.deleteFolder(id);
  if (!result.success) return result;

  const state = useNoteStore.getState();
  const folder = state.folders.find((f) => f.id === id);
  const key = folderContainerKey(id);
  const teardown = teardownNoteContainers(state, [key]);
  persistExpandedContainers(teardown.expandedContainers);
  useNoteStore.setState({
    notesByContainer: teardown.notesByContainer,
    expandedContainers: teardown.expandedContainers,
    activeNoteId: teardown.activeNoteId,
  });

  await loadFolders();
  if (getActiveFolderIdValue() === id && folder) {
    const { folders } = useNoteStore.getState();
    const spaceFolders = folders.filter((f) => f.space_id === folder.space_id);
    const fallback = findDefaultFolder(spaceFolders) ?? spaceFolders[0];
    setActiveContext(folder.space_id, fallback?.id ?? null);
    if (getActiveNoteIdValue() == null) {
      const notes = await ensureContainerLoaded(
        fallback ? folderContainerKey(fallback.id) : spaceContainerKey(folder.space_id)
      );
      if (notes.length > 0) setActiveNoteId(notes[0].id);
    }
  }
  syncService.requestSyncAll("manual");
  return result;
}

export async function moveFolderToSpace(
  folderId: number,
  spaceId: number
): Promise<{ success: boolean; folder?: FolderItem; error?: string }> {
  const result = await window.electronAPI.moveFolderToSpace(folderId, spaceId);
  if (!result.success) return result;

  await loadFolders();
  const key = folderContainerKey(folderId);
  if (useNoteStore.getState().notesByContainer[key]) {
    // Refresh the container so its notes carry the new space_id.
    await loadContainerNotes(key);
  }
  const { activeContext } = useNoteStore.getState();
  if (activeContext?.folderId === folderId && activeContext.spaceId !== spaceId) {
    useNoteStore.setState({ activeContext: { spaceId, folderId } });
  }
  syncService.requestSyncAll("manual");
  return result;
}

export async function updateSpaceMeta(
  id: number,
  updates: { name?: string; emoji?: string | null }
): Promise<{ success: boolean; space?: SpaceItem; error?: string }> {
  const result = (await window.electronAPI.updateSpace?.(id, updates)) ?? { success: false };
  if (result.success && result.space) {
    const updated = result.space;
    const { spaces } = useNoteStore.getState();
    useNoteStore.setState({ spaces: spaces.map((s) => (s.id === id ? updated : s)) });
  }
  return result;
}

/** Local purge (dev override); store cleanup happens via the space-purged broadcast. */
export async function purgeSpace(id: number): Promise<{ success: boolean; error?: string }> {
  return (await window.electronAPI.purgeSpace?.(id)) ?? { success: false };
}

export function setActiveNoteId(id: number | null): void {
  if (useNoteStore.getState().activeNoteId === id) return;
  useNoteStore.setState({ activeNoteId: id });
}

/**
 * Jump navigation (CommandSearch/ControlPanel): activate and reveal a
 * space/folder. Works both with a mounted tree and as a preset that
 * initializeNotesTree resolves on mount.
 */
export function navigateToContainer(spaceId: number, folderId: number | null): void {
  // Container jumps land on the overview; flows that open a note afterwards
  // (e.g. CommandSearch note select) re-set activeNoteId themselves.
  setActiveNoteId(null);
  if (folderId != null) {
    setActiveFolderId(folderId);
    return;
  }
  setActiveContext(spaceId, null);
  revealContainer(spaceId, null);
}

export function setActiveFolderId(id: number | null): void {
  const folder = id != null ? useNoteStore.getState().folders.find((f) => f.id === id) : undefined;
  if (folder) {
    pendingFolderPreset = null;
    setActiveContext(folder.space_id, folder.id);
    revealContainer(folder.space_id, folder.id);
    return;
  }
  // Folder unknown (tree not initialized yet) or id cleared.
  pendingFolderPreset = id;
}

export function getActiveNoteIdValue(): number | null {
  return useNoteStore.getState().activeNoteId;
}

export function getNoteFromStore(id: number): NoteItem | null {
  return findNoteInState(useNoteStore.getState(), id);
}

export function getActiveFolderIdValue(): number | null {
  return useNoteStore.getState().activeContext?.folderId ?? null;
}

/** Live (non-hook) reads for deferred callbacks like undo toasts. */
export function getFoldersValue(): FolderItem[] {
  return useNoteStore.getState().folders;
}

export function getSpacesValue(): SpaceItem[] {
  return useNoteStore.getState().spaces;
}

export function useNotes(): NoteItem[] {
  return useNoteStore((state) => state.notes);
}

export function useSpaces(): SpaceItem[] {
  return useNoteStore((state) => state.spaces);
}

export function useFolders(): FolderItem[] {
  return useNoteStore((state) => state.folders);
}

export function useFolderCounts(): Record<number, number> {
  return useNoteStore((state) => state.folderCounts);
}

export function useSpaceRootCounts(): Record<number, number> {
  return useNoteStore((state) => state.spaceRootCounts);
}

export function useNotesByContainer(): Record<string, NoteItem[]> {
  return useNoteStore((state) => state.notesByContainer);
}

export function useExpandedContainers(): Set<string> {
  return useNoteStore((state) => state.expandedContainers);
}

export function useActiveContext(): ActiveContext | null {
  return useNoteStore((state) => state.activeContext);
}

export function useIsTreeLoading(): boolean {
  return useNoteStore((state) => state.isTreeLoading);
}

export function useActiveNoteId(): number | null {
  return useNoteStore((state) => state.activeNoteId);
}

export function useActiveFolderId(): number | null {
  return useNoteStore((state) => state.activeContext?.folderId ?? null);
}

export function useActiveNote(): NoteItem | null {
  return useNoteStore((state) =>
    state.activeNoteId != null ? findNoteInState(state, state.activeNoteId) : null
  );
}

export function useMigration(): { total: number; done: number } | null {
  return useNoteStore((state) => state.migration);
}

export async function startMigration(): Promise<void> {
  const gen = ++migrationGeneration;
  const accountGen = accountGeneration;
  const allNotes = (await window.electronAPI.getNotes(null, 9999, null)) ?? [];
  if (gen !== migrationGeneration) return;
  const unsynced = allNotes.filter((n) => !n.cloud_id);
  if (unsynced.length === 0) return;

  useNoteStore.setState({ migration: { total: unsynced.length, done: 0 } });

  const { NotesService } = await import("../services/NotesService.js");
  const CHUNK_SIZE = 50;

  for (let i = 0; i < unsynced.length; i += CHUNK_SIZE) {
    if (gen !== migrationGeneration) return;
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
      // A reset may invalidate the UI migration while the POST is in flight.
      // Still run every response through the atomic identity/snapshot guard so
      // a purged fork is untouched and its proven cloud orphan is cleaned up.
      await resolveRendererCloudNoteCreateBatch(
        chunk,
        created,
        (cloudId) => NotesService.delete(cloudId),
        // Migration POSTs intentionally omit transcript/diarization fields,
        // folder mapping, and space scope. Adopt the id/base but leave the row
        // pending so SyncService follows with the complete PATCH.
        {
          settleIfUnchanged: false,
          // Starting a newer migration supersedes only this run's progress.
          // Both runs target the same account and idempotent cloud identity;
          // only an account reset makes the response an orphan to delete.
          requestStillCurrent: () => accountGen === accountGeneration,
        }
      );
      if (gen !== migrationGeneration) return;
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

  if (gen === migrationGeneration) useNoteStore.setState({ migration: null });
}

export function setNoteConflict(clientNoteId: string, cloudNote: CloudNote): void {
  addNoteConflict(clientNoteId, cloudNote);
  const { noteConflicts } = useNoteStore.getState();
  useNoteStore.setState({ noteConflicts: { ...noteConflicts, [clientNoteId]: cloudNote } });
}

export function clearNoteConflict(clientNoteId: string): void {
  // Unblock the push gate even when the in-memory banner state is gone
  // (e.g. cleared in another window or dropped by a restart).
  removeNoteConflictId(clientNoteId);
  const { noteConflicts } = useNoteStore.getState();
  if (!(clientNoteId in noteConflicts)) return;
  const next = { ...noteConflicts };
  delete next[clientNoteId];
  useNoteStore.setState({ noteConflicts: next });
}

export function useNoteConflict(clientNoteId: string | null): CloudNote | null {
  return useNoteStore((state) =>
    clientNoteId ? (state.noteConflicts[clientNoteId] ?? null) : null
  );
}

export async function persistNoteShareState(
  noteId: number,
  updates: { is_shared: number; share_token?: string | null }
): Promise<void> {
  await window.electronAPI.updateNoteShareState(noteId, updates);
}

export function getShareCacheEntry(cloudId: string): NoteShareCacheEntry | null {
  return useNoteStore.getState().shareByCloudId.get(cloudId) ?? null;
}

export function updateShareCache(
  cloudId: string,
  updater: (current: NoteShareCacheEntry | undefined) => Partial<NoteShareCacheEntry>
): void {
  const { shareByCloudId } = useNoteStore.getState();
  const next = new Map(shareByCloudId);
  const current = next.get(cloudId);
  const updated = { ...current, ...updater(current) };
  if (
    updated.share === undefined ||
    updated.invitations === undefined ||
    updated.rawToken === undefined
  ) {
    throw new Error("A new share cache entry requires share, invitations, and rawToken");
  }
  next.set(cloudId, updated);
  useNoteStore.setState({ shareByCloudId: next });
}

export function useShareCacheEntry(cloudId: string | null): NoteShareCacheEntry | null {
  return useNoteStore((state) => (cloudId ? (state.shareByCloudId.get(cloudId) ?? null) : null));
}

// Whole-map subscription for list surfaces (the tree gates per-note actions
// on loaded ACLs); per-note consumers should prefer useShareCacheEntry.
export function useShareCache(): Map<string, NoteShareCacheEntry> {
  return useNoteStore((state) => state.shareByCloudId);
}
