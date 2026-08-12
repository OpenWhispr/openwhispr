import type { NoteItem } from "../types/electron";

export interface NoteListsState {
  notesByContainer: Record<string, NoteItem[]>;
  notes: NoteItem[];
  activeNoteId: number | null;
}

export interface RemoveNoteResult extends NoteListsState {
  changed: boolean;
}

export interface NoteContainerState {
  notesByContainer: Record<string, NoteItem[]>;
  expandedContainers: Set<string>;
  activeNoteId: number | null;
}

export interface TeardownContainersResult extends NoteContainerState {
  removedNotes: NoteItem[];
}

export function createClearedAccountNoteState<TSpace, TFolder, TShare, TConflict>() {
  return {
    notes: [] as NoteItem[],
    spaces: [] as TSpace[],
    folders: [] as TFolder[],
    folderCounts: {} as Record<number, number>,
    spaceRootCounts: {} as Record<number, number>,
    notesByContainer: {} as Record<string, NoteItem[]>,
    expandedContainers: new Set<string>(),
    activeContext: null,
    activeNoteId: null,
    isTreeLoading: true,
    migration: null,
    shareByCloudId: new Map<string, TShare>(),
    noteConflicts: {} as Record<string, TConflict>,
  };
}

/** Make every currently running keyed load stale without reusing generations. */
export function invalidateKeyedLoadGenerations(generations: Map<string, number>): void {
  generations.forEach((generation, key) => {
    generations.set(key, generation + 1);
  });
}

/**
 * Remove a note from every container list AND the flat `notes` list. The flat
 * list can hold notes absent from every loaded container (flat-only loads,
 * divergence after partial refreshes), so it must be filtered independently —
 * relying on the active-container mirror alone leaves a deleted note visible.
 */
export function removeNoteFromLists(state: NoteListsState, id: number): RemoveNoteResult {
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

  const inFlat = state.notes.some((n) => n.id === id);
  const notes = inFlat ? state.notes.filter((n) => n.id !== id) : state.notes;
  changed = changed || inFlat;

  let activeNoteId = state.activeNoteId;
  if (changed && state.activeNoteId === id) {
    // Pick the neighbor from what the user is looking at: the flat list when
    // it held the note, else the note's source container.
    const previous = inFlat ? state.notes : sourceItems;
    const next = inFlat ? notes : sourceKey ? notesByContainer[sourceKey] : [];
    const idx = previous ? previous.findIndex((n) => n.id === id) : -1;
    activeNoteId = idx === -1 ? null : (next[Math.min(idx, next.length - 1)]?.id ?? null);
  }

  return { notesByContainer, notes, activeNoteId, changed };
}

/**
 * Remove cached note containers and all renderer state that points into them.
 * Folder deletion and space purging share this operation; callers remain
 * responsible for choosing a replacement active context.
 */
export function teardownNoteContainers(
  state: NoteContainerState,
  keys: Iterable<string>
): TeardownContainersResult {
  const removedKeys = new Set(keys);
  const notesByContainer: Record<string, NoteItem[]> = {};
  const removedNotes: NoteItem[] = [];

  for (const [key, items] of Object.entries(state.notesByContainer)) {
    if (removedKeys.has(key)) removedNotes.push(...items);
    else notesByContainer[key] = items;
  }

  const expandedContainers = new Set(
    [...state.expandedContainers].filter((key) => !removedKeys.has(key))
  );
  const activeNoteId =
    state.activeNoteId != null && removedNotes.some((note) => note.id === state.activeNoteId)
      ? null
      : state.activeNoteId;

  return { notesByContainer, expandedContainers, activeNoteId, removedNotes };
}
