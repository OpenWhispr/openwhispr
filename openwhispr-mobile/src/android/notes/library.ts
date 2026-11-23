import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { create } from 'zustand';
import { notesRepository } from '@/data';
import { spacesRepository } from '@/data/spacesRepository';
import type { Folder, Note } from '@/data';
import type { Space } from '@/data/spacesTypes';
import { getDefaultPrivateWorkspaceId } from '@/sync/teamSpacesCapability';
import { useAuthStore } from '@/store/useAuthStore';
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

/**
 * Every workspace you belong to (GET /api/workspaces), kept for the account that read it. Your
 * teamspaces only name the workspaces you're in a teamspace of, so a new workspace, or one you
 * admin without joining a teamspace, would never show without this list.
 */
export type KnownWorkspace = { id: string; name: string };
export const useKnownWorkspaces = create<{ owner: string | null; list: KnownWorkspace[] }>(() => ({
  owner: null,
  list: [],
}));

/** Your workspaces with their teamspaces, in name order; just Private when you're in none. */
export function workspacesOf(spaces: Space[], known: KnownWorkspace[] = []): Workspace[] {
  const groups = new Map<string | null, Workspace>();
  for (const workspace of known)
    groups.set(workspace.id, { id: workspace.id, name: workspace.name.trim(), teams: [] });
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

/**
 * Before you pick one: your default workspace (the server names it during sync), else the one with
 * the most of your teamspaces, so Notes doesn't open on an empty workspace that sorts first.
 */
export function defaultWorkspace(workspaces: Workspace[], defaultId: string | null): Workspace {
  return (
    workspaces.find((workspace) => defaultId != null && workspace.id === defaultId) ??
    [...workspaces].sort((left, right) => right.teams.length - left.teams.length)[0]
  );
}

/** The picked workspace, else the default; one that went away (left, deleted) falls back too. */
export function useCurrentWorkspace(): { workspaces: Workspace[]; current: Workspace } {
  const spaces = useNotesStore((state) => state.spaces);
  const picked = useNotesWorkspace((state) => state.workspaceId);
  const known = useKnownWorkspaces((state) => state.list);
  const owner = useKnownWorkspaces((state) => state.owner);
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const workspaces = useMemo(
    () => workspacesOf(spaces, owner != null && owner === userId ? known : []),
    [spaces, known, owner, userId],
  );
  const current =
    workspaces.find((workspace) => workspace.id === picked) ??
    defaultWorkspace(workspaces, getDefaultPrivateWorkspaceId());
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
