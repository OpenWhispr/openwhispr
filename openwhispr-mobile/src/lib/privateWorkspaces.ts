import type { Folder } from '@/data';

/**
 * Every workspace has its own Private section, as on desktop (PR #3167). A Private folder
 * names its workspace in `privateWorkspaceId`; one without it (made before placement was
 * recorded, or on a backend that predates it) is the default workspace's.
 */

/** The fields of a GET /api/workspaces entry the Private sections read. */
export interface PrivateWorkspace {
  id: string;
  name: string;
  is_default?: boolean;
  plan?: string | null;
  status?: string | null;
}

const ENTITLED_STATUSES = new Set(['active', 'trialing']);
const MEETINGS_FOLDER_NAME = 'meetings';
const PERSONAL_FOLDER_NAME = 'personal';

// Mirrors desktop's isEnterpriseWorkspaceEntitled (src/components/onboarding/flow.ts).
function isEnterpriseWorkspaceEntitled(workspace: PrivateWorkspace): boolean {
  return workspace.plan === 'enterprise' && ENTITLED_STATUSES.has(workspace.status ?? '');
}

/**
 * The workspace whose Private holds unplaced content: the default the server reported, else
 * the listed own default, else an entitled Enterprise workspace (the server makes no default
 * for an Enterprise member). Mirrors desktop's resolveDefaultWorkspaceId and the API's
 * legacyPlacementWorkspaceId.
 */
export function resolveDefaultPrivateWorkspaceId(
  workspaces: PrivateWorkspace[],
  serverDefaultId: string | null,
): string | null {
  if (serverDefaultId) return serverDefaultId;
  return (
    (
      workspaces.find((w) => w.is_default === true) ??
      workspaces.find(isEnterpriseWorkspaceEntitled)
    )?.id ?? null
  );
}

/**
 * The workspace to show when the user hasn't picked one, as desktop picks it: an entitled
 * Enterprise workspace first (its managed providers apply only while it is active), then the
 * own default, then the first listed.
 */
export function defaultActiveWorkspaceId(workspaces: PrivateWorkspace[]): string | null {
  return (
    (
      workspaces.find(isEnterpriseWorkspaceEntitled) ??
      workspaces.find((w) => w.is_default === true) ??
      workspaces[0]
    )?.id ?? null
  );
}

/** The user's saved choice while it is still listed, else the app's own pick. */
export function resolveActivePrivateWorkspaceId({
  workspaces,
  savedId,
  defaultId,
}: {
  workspaces: PrivateWorkspace[];
  savedId: string | null;
  defaultId: string | null;
}): string | null {
  if (workspaces.length === 0) return defaultId;
  if (savedId && workspaces.some((w) => w.id === savedId)) return savedId;
  // Mobile-only accounts may not have provisioned a default yet. Their existing
  // unplaced folders must remain reachable until the server gives them a home.
  if (defaultId === null) return null;
  return defaultActiveWorkspaceId(workspaces) ?? defaultId;
}

export interface PrivateWorkspaceOption {
  id: string | null;
  name: string;
}

export function privateWorkspaceOptions(
  workspaces: PrivateWorkspace[],
  defaultId: string | null,
): PrivateWorkspaceOption[] {
  return defaultId === null && workspaces.length > 0
    ? [{ id: null, name: 'Personal' }, ...workspaces]
    : workspaces;
}

/** The workspace whose Private a folder sits in. */
export function privateWorkspaceOf(
  folder: Pick<Folder, 'privateWorkspaceId'>,
  defaultId: string | null,
): string | null {
  return folder.privateWorkspaceId ?? defaultId;
}

/**
 * The folders of one workspace's Private. With `listedIds`, the default workspace also shows
 * folders of a workspace the account no longer lists, so their notes stay reachable; pickers
 * leave `listedIds` out and only ever see the workspace's own folders.
 */
export function foldersInPrivateWorkspace<F extends Pick<Folder, 'privateWorkspaceId'>>(
  folders: F[],
  workspaceId: string | null,
  defaultId: string | null,
  listedIds?: string[],
): F[] {
  const listed = listedIds ? new Set(listedIds) : null;
  const showsLost = listed !== null && workspaceId === defaultId;
  return folders.filter((folder) => {
    const owner = privateWorkspaceOf(folder, defaultId);
    if (owner === workspaceId) return true;
    return showsLost && owner !== null && !listed.has(owner);
  });
}

const isNamed = (folder: Pick<Folder, 'name'>, name: string): boolean =>
  folder.name.trim().toLowerCase() === name;

/** Where a new note goes in a Private: its Personal, else another default folder, else the first. */
export function pickPrivateDefaultFolder<F extends Pick<Folder, 'name' | 'isDefault'>>(
  folders: F[],
): F | null {
  return (
    folders.find((f) => f.isDefault === 1 && isNamed(f, PERSONAL_FOLDER_NAME)) ??
    folders.find((f) => f.isDefault === 1) ??
    folders[0] ??
    null
  );
}

/** Where a new meeting goes in a Private: its Meetings folder, when it has one. */
export function pickPrivateMeetingsFolder<F extends Pick<Folder, 'name'>>(folders: F[]): F | null {
  return folders.find((f) => isNamed(f, MEETINGS_FOLDER_NAME)) ?? null;
}

export interface PrivateFolderGroup<F> {
  workspaceId: string | null;
  name: string;
  folders: F[];
}

/**
 * Private folders grouped under each listed workspace, `firstId`'s first and the rest in list
 * order, including unplaced Personal folders until a default exists. A workspace no longer
 * listed is left out, so nothing is filed there.
 */
export function groupPrivateFoldersByWorkspace<F extends Pick<Folder, 'privateWorkspaceId'>>(
  folders: F[],
  {
    workspaces,
    firstId,
    defaultId,
  }: { workspaces: PrivateWorkspace[]; firstId: string | null; defaultId: string | null },
): PrivateFolderGroup<F>[] {
  const options = privateWorkspaceOptions(workspaces, defaultId);
  const ordered = [
    ...options.filter((workspace) => workspace.id === firstId),
    ...options.filter((workspace) => workspace.id !== firstId),
  ];
  return ordered.map((workspace) => ({
    workspaceId: workspace.id,
    name: workspace.name,
    folders: foldersInPrivateWorkspace(folders, workspace.id, defaultId),
  }));
}
