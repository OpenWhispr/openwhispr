import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { create } from 'zustand';
import { notesRepository } from '@/data';
import { spacesRepository } from '@/data/spacesRepository';
import type { Folder, Note } from '@/data';
import type { Space } from '@/data/spacesTypes';
import { useNotesStore } from '@/store/useNotesStore';
import { useHiddenNoteIds } from './pendingDeletes';

/**
 * Notes shows one workspace at a time (Figma W1): Private, then the workspace's teamspaces. The
 * title's ▾ picks the workspace (W2). `undefined` means nobody picked one yet, so the first shows.
 */
export type Workspace = { id: string | null; name: string; teams: Space[] };

export const useNotesWorkspace = create<{ workspaceId: string | null | undefined }>(() => ({
  workspaceId: undefined,
}));

export function setNotesWorkspace(workspaceId: string | null) {
  useNotesWorkspace.setState({ workspaceId });
}

/** Your teamspaces grouped by workspace, in name order; just Private when you're in none. */
export function workspacesOf(spaces: Space[]): Workspace[] {
  const groups = new Map<string | null, Workspace>();
  for (const space of spaces) {
    if (space.kind !== 'team') continue;
    const id = space.workspaceId ?? null;
    const group = groups.get(id) ?? { id, name: space.workspaceName?.trim() || '', teams: [] };
    if (!group.name && space.workspaceName?.trim()) group.name = space.workspaceName.trim();
    group.teams.push(space);
    groups.set(id, group);
  }
  const list = [...groups.values()].sort((left, right) => left.name.localeCompare(right.name));
  return list.length > 0 ? list : [{ id: null, name: '', teams: [] }];
}

/** The picked workspace, else the first; one that went away (left, deleted) falls back too. */
export function useCurrentWorkspace(): { workspaces: Workspace[]; current: Workspace } {
  const spaces = useNotesStore((state) => state.spaces);
  const picked = useNotesWorkspace((state) => state.workspaceId);
  const workspaces = useMemo(() => workspacesOf(spaces), [spaces]);
  const current = workspaces.find((workspace) => workspace.id === picked) ?? workspaces[0];
  return { workspaces, current };
}

export function privateSpaceId(): number | null {
  try {
    return spacesRepository.getPrivateSpace().id;
  } catch {
    return null;
  }
}

export function isPrivateNote(note: Pick<Note, 'spaceId'>, privateId: number | null): boolean {
  return note.spaceId == null || note.spaceId === privateId;
}

/**
 * Re-reads whatever the list is built from when the screen comes back into view and whenever
 * the notes store changes (a sync pass, a new note, a move), so rows never go stale.
 */
export function useLibraryRevision(): number {
  const [focusRevision, setFocusRevision] = useState(0);
  useFocusEffect(useCallback(() => setFocusRevision((value) => value + 1), []));
  const folderCounts = useNotesStore((state) => state.folderCounts);
  const notes = useNotesStore((state) => state.notes);
  const spaces = useNotesStore((state) => state.spaces);
  const transcriptRevision = useNotesStore((state) => state.transcriptRevision);
  const counter = useRef(0);
  return useMemo(
    () => ++counter.current,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focusRevision, folderCounts, notes, spaces, transcriptRevision],
  );
}

/** Every visible note, newest first, minus the ones waiting out their Undo. */
export function useAllNotes(revision: number): Note[] {
  const hidden = useHiddenNoteIds();
  return useMemo(
    () =>
      notesRepository.getAllNotes().filter((note) => !hidden.includes(note.id) && !note.leftTeam),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision, hidden],
  );
}

/** Private notes and the notes in the workspace's teamspaces. */
export function notesInWorkspace(
  notes: Note[],
  workspace: Workspace,
  privateId: number | null,
): Note[] {
  const teams = new Set(workspace.teams.map((space) => space.id));
  return notes.filter(
    (note) => isPrivateNote(note, privateId) || (note.spaceId != null && teams.has(note.spaceId)),
  );
}

export function teamSpaces(spaces: Space[]): Space[] {
  return spaces.filter((space) => space.kind === 'team');
}

export function spaceFoldersOf(spaceId: number): Folder[] {
  return useNotesStore.getState().getSpaceFolders(spaceId);
}

/** Where a new note goes from the Notes home: Private's default folder. */
export function defaultFolderFor(folders: Folder[]): number | undefined {
  return (folders.find((folder) => folder.isDefault) ?? folders[0])?.id;
}
