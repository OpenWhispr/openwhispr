import { notesRepository } from '@/data';
import {
  resolveActivePrivateWorkspaceId,
  resolveDefaultPrivateWorkspaceId,
  type PrivateWorkspace,
} from '@/lib/privateWorkspaces';

// Persisted in sync_state (shared key/value store — see notesRepository
// getSyncState/setSyncState) rather than its own table: this is a single
// session-spanning flag, not sync data with its own lifecycle.
const KEY = 'team_spaces_capability';

/**
 * Whether the deployed backend supports team spaces (GET /api/me/spaces is
 * deployed). Written by syncSpaces() after each probe/sync attempt.
 *
 * - `true` — confirmed capable; scope-aware pushes/pulls may proceed.
 * - `false` — confirmed a 404/405/501; omit all scope fields.
 * - `null` — never probed yet (no sync has run on this device/account).
 */
export function getTeamSpacesCapability(): boolean | null {
  const value = notesRepository.getSyncState(KEY);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function setTeamSpacesCapability(capable: boolean): void {
  notesRepository.setSyncState(KEY, capable ? 'true' : 'false');
}

// Stored with the account's other sync state and cleared by its existing wipe.
const DEFAULT_PRIVATE_WORKSPACE_KEY = 'private_default_workspace_id';

export function getDefaultPrivateWorkspaceId(): string | null {
  return notesRepository.getSyncState(DEFAULT_PRIVATE_WORKSPACE_KEY) || null;
}

export function setDefaultPrivateWorkspaceId(workspaceId: string | null): void {
  notesRepository.setSyncState(DEFAULT_PRIVATE_WORKSPACE_KEY, workspaceId ?? '');
}

// Whether the API files personal notes and folders per workspace Private
// (`private_workspace_placement` on GET /api/me/spaces). Until it does, every
// Private row is the default workspace's and the app shows just that one.
const PRIVATE_PLACEMENT_KEY = 'private_workspace_placement';
// GET /api/workspaces as the last spaces pass read it, for the workspace switcher offline.
const PRIVATE_WORKSPACES_KEY = 'private_workspaces';
// The workspace the user last picked in the switcher; never written by the app itself.
const ACTIVE_PRIVATE_WORKSPACE_KEY = 'private_active_workspace_id';

export function getPrivateWorkspacePlacement(): boolean {
  return notesRepository.getSyncState(PRIVATE_PLACEMENT_KEY) === 'true';
}

export function setPrivateWorkspacePlacement(supported: boolean): void {
  notesRepository.setSyncState(PRIVATE_PLACEMENT_KEY, supported ? 'true' : 'false');
}

function isPrivateWorkspace(value: unknown): value is PrivateWorkspace {
  if (!value || typeof value !== 'object') return false;
  const { id, name } = value as Record<string, unknown>;
  return typeof id === 'string' && id.length > 0 && typeof name === 'string';
}

export function getPrivateWorkspaces(): PrivateWorkspace[] {
  const raw = notesRepository.getSyncState(PRIVATE_WORKSPACES_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPrivateWorkspace) : [];
  } catch {
    return [];
  }
}

export function setPrivateWorkspaces(workspaces: PrivateWorkspace[]): void {
  const stored: PrivateWorkspace[] = workspaces.map(({ id, name, is_default, plan, status }) => ({
    id,
    name,
    ...(is_default !== undefined ? { is_default } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(status !== undefined ? { status } : {}),
  }));
  notesRepository.setSyncState(PRIVATE_WORKSPACES_KEY, JSON.stringify(stored));
}

export function setActivePrivateWorkspaceChoice(workspaceId: string | null): void {
  notesRepository.setSyncState(ACTIVE_PRIVATE_WORKSPACE_KEY, workspaceId ?? '');
}

export interface PrivateWorkspaceContext {
  /** The API keeps a Private per workspace; false shows the default's alone. */
  placementSupported: boolean;
  /** The workspaces the switcher offers; empty while placement isn't supported. */
  workspaces: PrivateWorkspace[];
  /** The workspace whose Private holds unplaced folders and notes. */
  defaultId: string | null;
  /** The workspace whose Private and team spaces are on screen. */
  activeId: string | null;
}

export function readPrivateWorkspaceContext(): PrivateWorkspaceContext {
  const placementSupported = getPrivateWorkspacePlacement();
  const workspaces = placementSupported ? getPrivateWorkspaces() : [];
  const defaultId = resolveDefaultPrivateWorkspaceId(workspaces, getDefaultPrivateWorkspaceId());
  const activeId = placementSupported
    ? resolveActivePrivateWorkspaceId({
        workspaces,
        savedId: notesRepository.getSyncState(ACTIVE_PRIVATE_WORKSPACE_KEY) || null,
        defaultId,
      })
    : defaultId;
  return { placementSupported, workspaces, defaultId, activeId };
}

/** The workspace whose Private holds folders and notes that carry no placement. */
export function getResolvedDefaultPrivateWorkspaceId(): string | null {
  return readPrivateWorkspaceContext().defaultId;
}
