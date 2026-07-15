import { create } from "zustand";
import { syncService } from "../services/SyncService.js";
import { findDefaultFolder } from "../components/notes/shared";
import type { CloudNote } from "../services/NotesService.js";
import type {
  FolderItem,
  NoteItem,
  NoteShareInvitation,
  ShareSettings,
  SpaceItem,
} from "../types/electron";

export interface NoteShareCacheEntry {
  share: ShareSettings;
  invitations: NoteShareInvitation[];
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
  activeFolderId: number | null;
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
  activeFolderId: null,
  isTreeLoading: true,
  migration: null,
  shareByCloudId: new Map<string, NoteShareCacheEntry>(),
  noteConflicts: {},
}));

let hasBoundIpcListeners = false;
const DEFAULT_LIMIT = 50;
let currentLimit = DEFAULT_LIMIT;
let loadGeneration = 0;
let treeLoadGeneration = 0;

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

function activeContainerKey(state: NoteState): string | null {
  return state.activeContext ? contextContainerKey(state.activeContext) : null;
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
  const context = (extra.activeContext ?? state.activeContext) as ActiveContext | null;
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

  if (window.electronAPI?.onNoteAdded) {
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

  if (window.electronAPI?.onNoteUpdated) {
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

  if (window.electronAPI?.onNoteDeleted) {
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
  if (window.electronAPI?.onNoteSynced) {
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

  if (window.electronAPI?.onFolderSynced) {
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
  if (window.electronAPI?.onFolderDeleted) {
    const dispose = window.electronAPI.onFolderDeleted(({ id }) => {
      if (id == null) return;
      const state = useNoteStore.getState();
      const key = folderContainerKey(id);
      const removedNotes = state.notesByContainer[key];
      const notesByContainer = { ...state.notesByContainer };
      delete notesByContainer[key];
      const expanded = new Set(state.expandedContainers);
      if (expanded.delete(key)) persistExpandedContainers(expanded);
      const extra: Partial<NoteState> = { expandedContainers: expanded };
      if (state.activeNoteId != null && removedNotes?.some((n) => n.id === state.activeNoteId)) {
        extra.activeNoteId = null;
      }
      let fallbackContext: ActiveContext | null = null;
      if (state.activeContext?.folderId === id) {
        // The active folder vanished under us — degrade to its space root.
        fallbackContext = { spaceId: state.activeContext.spaceId, folderId: null };
        extra.activeContext = fallbackContext;
        extra.activeFolderId = null;
        extra.notes = notesByContainer[contextContainerKey(fallbackContext)] ?? [];
      }
      useNoteStore.setState({ notesByContainer, ...extra });
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
  if (window.electronAPI?.onSyncEvent) {
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

  if (window.electronAPI?.onSpacePurged) {
    const dispose = window.electronAPI.onSpacePurged(({ spaceId }) => {
      handleSpacePurged(spaceId);
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
  const items = (await window.electronAPI?.getSpaces?.()) ?? [];
  useNoteStore.setState({ spaces: items });
  return items;
}

export async function loadFolders(): Promise<FolderItem[]> {
  const [items, counts] = await Promise.all([
    window.electronAPI.getFolders(),
    window.electronAPI.getFolderNoteCounts(),
  ]);
  const folderCounts: Record<number, number> = {};
  const spaceRootCounts: Record<number, number> = {};
  counts.forEach((c) => {
    if (c.folder_id != null) folderCounts[c.folder_id] = c.count;
    else if (c.space_id != null) spaceRootCounts[c.space_id] = c.count;
  });
  useNoteStore.setState({ folders: items, folderCounts, spaceRootCounts });
  return items;
}

export async function loadContainerNotes(key: string): Promise<NoteItem[]> {
  const [kind, idStr] = key.split(":");
  const id = Number(idStr);
  const items =
    kind === "f"
      ? ((await window.electronAPI?.getNotes(null, DEFAULT_LIMIT, id)) ?? [])
      : ((await window.electronAPI?.getNotes(null, DEFAULT_LIMIT, null, id)) ?? []);
  applyContainers({ ...useNoteStore.getState().notesByContainer, [key]: items });
  return items;
}

export async function ensureContainerLoaded(key: string): Promise<NoteItem[]> {
  const cached = useNoteStore.getState().notesByContainer[key];
  if (cached) return cached;
  return loadContainerNotes(key);
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
    activeFolderId: folderId,
    notes: state.notesByContainer[key] ?? [],
  });
  void ensureContainerLoaded(key);
}

/**
 * Loads spaces, folders and counts, resolves the initial active context
 * (honoring a pre-set activeFolderId or activeContext, e.g. navigating from
 * search), loads the active container and auto-selects its first note when
 * none is pre-set.
 */
export async function initializeNotesTree(): Promise<void> {
  const gen = ++treeLoadGeneration;
  ensureIpcListeners();
  useNoteStore.setState({ isTreeLoading: true });
  try {
    const [spaces, folders] = await Promise.all([loadSpaces(), loadFolders()]);
    if (gen !== treeLoadGeneration) return;

    const presetFolderId = getActiveFolderIdValue();
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
    useNoteStore.setState({ activeContext: context, activeFolderId: context.folderId });
    const notes = await loadContainerNotes(contextContainerKey(context));
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
  const gen = ++loadGeneration;
  currentLimit = limit;
  ensureIpcListeners();
  const items = (await window.electronAPI?.getNotes(noteType, limit, folderId)) ?? [];
  if (gen !== loadGeneration) return items;
  if (folderId != null) {
    applyContainers({
      ...useNoteStore.getState().notesByContainer,
      [folderContainerKey(folderId)]: items,
    });
  } else {
    useNoteStore.setState({ notes: items });
  }
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
  const notesByContainer = { ...state.notesByContainer };
  let sourceItems: NoteItem[] | null = null;
  let sourceKey: string | null = null;
  let changed = false;
  for (const [key, items] of Object.entries(state.notesByContainer)) {
    if (!items.some((n) => n.id === id)) continue;
    sourceItems = items;
    sourceKey = key;
    notesByContainer[key] = items.filter((n) => n.id !== id);
    changed = true;
  }
  if (!changed) return;
  const extra: Partial<NoteState> = {};
  if (state.activeNoteId === id && sourceItems && sourceKey) {
    const idx = sourceItems.findIndex((n) => n.id === id);
    const next = notesByContainer[sourceKey];
    extra.activeNoteId = next[Math.min(idx, next.length - 1)]?.id ?? null;
  }
  applyContainers(notesByContainer, extra);
}

function handleSpacePurged(spaceId: number): void {
  const state = useNoteStore.getState();
  const purgedTeamId = state.spaces.find((s) => s.id === spaceId)?.cloud_team_id ?? null;
  const removedKeys = new Set<string>([spaceContainerKey(spaceId)]);
  state.folders.forEach((f) => {
    if (f.space_id === spaceId) removedKeys.add(folderContainerKey(f.id));
  });

  const notesByContainer: Record<string, NoteItem[]> = {};
  for (const [key, items] of Object.entries(state.notesByContainer)) {
    if (!removedKeys.has(key)) notesByContainer[key] = items;
  }
  const folderCounts = { ...state.folderCounts };
  state.folders.forEach((f) => {
    if (f.space_id === spaceId) delete folderCounts[f.id];
  });
  const spaceRootCounts = { ...state.spaceRootCounts };
  delete spaceRootCounts[spaceId];
  const expanded = new Set([...state.expandedContainers].filter((key) => !removedKeys.has(key)));
  persistExpandedContainers(expanded);

  // Purge completeness (plan §5.4): purged notes' share-cache entries (which
  // can hold raw link tokens) and conflict banners (which hold full cloud
  // copies) must not outlive the space in renderer memory. Conflicts are
  // matched by the team's cloud id too, since their notes' containers may
  // never have been loaded.
  const purgedCloudIds = new Set<string>();
  const purgedClientIds = new Set<string>();
  removedKeys.forEach((key) => {
    (state.notesByContainer[key] ?? []).forEach((n) => {
      if (n.cloud_id) purgedCloudIds.add(n.cloud_id);
      purgedClientIds.add(n.client_note_id);
    });
  });
  const shareByCloudId = new Map(state.shareByCloudId);
  purgedCloudIds.forEach((id) => shareByCloudId.delete(id));
  const noteConflicts = Object.fromEntries(
    Object.entries(state.noteConflicts).filter(
      ([clientId, cloudNote]) =>
        !purgedClientIds.has(clientId) &&
        (purgedTeamId == null || cloudNote.team_id !== purgedTeamId)
    )
  );

  const extra: Partial<NoteState> = {
    spaces: state.spaces.filter((s) => s.id !== spaceId),
    folders: state.folders.filter((f) => f.space_id !== spaceId),
    folderCounts,
    spaceRootCounts,
    expandedContainers: expanded,
    shareByCloudId,
    noteConflicts,
  };
  const activeNote = state.activeNoteId != null ? findNoteInState(state, state.activeNoteId) : null;
  if (activeNote?.space_id === spaceId) {
    extra.activeNoteId = null;
  }

  let fallbackContext: ActiveContext | null = null;
  if (state.activeContext?.spaceId === spaceId) {
    const privateSpace = extra.spaces?.find((s) => s.kind === "private");
    if (privateSpace) {
      const privateFolders = state.folders.filter((f) => f.space_id === privateSpace.id);
      const fallbackFolder = findDefaultFolder(privateFolders) ?? privateFolders[0];
      fallbackContext = { spaceId: privateSpace.id, folderId: fallbackFolder?.id ?? null };
      extra.activeContext = fallbackContext;
      extra.activeFolderId = fallbackContext.folderId;
      extra.notes = notesByContainer[contextContainerKey(fallbackContext)] ?? [];
    }
  }
  useNoteStore.setState({ notesByContainer, ...extra });
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
  const deletedNotes = state.notesByContainer[key];
  const notesByContainer = { ...state.notesByContainer };
  delete notesByContainer[key];
  const expanded = new Set(state.expandedContainers);
  if (expanded.delete(key)) persistExpandedContainers(expanded);
  const extra: Partial<NoteState> = { expandedContainers: expanded };
  if (state.activeNoteId != null && deletedNotes?.some((n) => n.id === state.activeNoteId)) {
    extra.activeNoteId = null;
  }
  useNoteStore.setState({ notesByContainer, ...extra });

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
  if (folderId != null) {
    setActiveFolderId(folderId);
    return;
  }
  setActiveContext(spaceId, null);
  revealContainer(spaceId, null);
}

export function setActiveFolderId(id: number | null): void {
  const state = useNoteStore.getState();
  const folder = id != null ? state.folders.find((f) => f.id === id) : undefined;
  if (folder) {
    setActiveContext(folder.space_id, folder.id);
    revealContainer(folder.space_id, folder.id);
    return;
  }
  // Folders not loaded yet (or id cleared): keep as a preset that
  // initializeNotesTree resolves on mount.
  if (state.activeFolderId === id) return;
  useNoteStore.setState({ activeFolderId: id });
}

export function getActiveNoteIdValue(): number | null {
  return useNoteStore.getState().activeNoteId;
}

export function getNoteFromStore(id: number): NoteItem | null {
  return findNoteInState(useNoteStore.getState(), id);
}

export function getActiveFolderIdValue(): number | null {
  return useNoteStore.getState().activeFolderId;
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
  return useNoteStore((state) => state.activeFolderId);
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

export function setNoteConflict(clientNoteId: string, cloudNote: CloudNote): void {
  const { noteConflicts } = useNoteStore.getState();
  useNoteStore.setState({ noteConflicts: { ...noteConflicts, [clientNoteId]: cloudNote } });
}

export function clearNoteConflict(clientNoteId: string): void {
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
  await window.electronAPI?.updateNoteShareState(noteId, updates);
}

export function getShareCacheEntry(cloudId: string): NoteShareCacheEntry | null {
  return useNoteStore.getState().shareByCloudId.get(cloudId) ?? null;
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

export function useShareCacheEntry(cloudId: string | null): NoteShareCacheEntry | null {
  return useNoteStore((state) => (cloudId ? (state.shareByCloudId.get(cloudId) ?? null) : null));
}
