import { uncheckedSync, type SyncCheckpoint } from './syncContext';
import { spacesRepository } from '@/data';
import type { Space } from '@/data/spacesTypes';
import { fetchMySpaces } from '@/data/remote/spacesApi';
import { fetchMyWorkspaces } from '@/data/remote/workspacesApi';
import { ApiError } from '@/lib/apiClient';
import { setTeamSpacesCapability } from './teamSpacesCapability';

// Mirrors syncEngine.ts's isEndpointUnavailable: a missing/undeployed route
// answers with 404 (not found), 405 (method not allowed behind a catch-all),
// or 501 (not implemented) depending on how the server fronts it.
function isEndpointUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}

/**
 * Workspace id → name, for the separators the Spaces list groups under.
 * Purely cosmetic, so every failure degrades to an empty map rather than
 * failing the sync pass: spaces still mirror, they just group unnamed until a
 * later pass resolves the names.
 */
async function fetchWorkspaceNames(checkpoint: SyncCheckpoint): Promise<Map<string, string>> {
  try {
    checkpoint();
    const { data } = await fetchMyWorkspaces();
    checkpoint();
    return new Map(data.map((workspace) => [workspace.id, workspace.name]));
  } catch {
    checkpoint();
    return new Map();
  }
}

export interface SyncSpacesResult {
  capable: boolean;
  activeSpaces: Space[];
}

/**
 * Runs first in every sync pass: probes team-spaces capability, mirrors the
 * caller's cloud spaces into local rows, and soft-deletes team spaces this
 * device lost access to (removed, archived, or membership revoked). Content
 * (notes/folders) is out of scope here — later pull/push passes handle it.
 */
export async function syncSpaces(
  checkpoint: SyncCheckpoint = uncheckedSync,
): Promise<SyncSpacesResult> {
  checkpoint();
  let remote: Awaited<ReturnType<typeof fetchMySpaces>>;
  try {
    checkpoint();
    remote = await fetchMySpaces();
    checkpoint();
  } catch (err) {
    checkpoint();
    if (isEndpointUnavailable(err)) {
      // Backend predates team spaces: not an error, just the probe result.
      setTeamSpacesCapability(false);
      return { capable: false, activeSpaces: [] };
    }
    throw err;
  }

  setTeamSpacesCapability(true);

  // Only reached once team spaces are known to exist, so accounts without them
  // never pay for this request.
  checkpoint();
  const workspaceNames = await fetchWorkspaceNames(checkpoint);
  checkpoint();

  const remoteIds = new Set(remote.data.map((s) => s.id));
  for (const space of remote.data) {
    spacesRepository.upsertFromRemote(space, workspaceNames.get(space.workspace_id));
  }

  const local = spacesRepository.listSpaces();
  // Every local team space absent from this response lost access (deleted,
  // archived, or every assigned team's membership revoked). The private
  // space is never a candidate — it has no cloud_space_id to match against.
  const revoked = new Set(
    local.filter((s) => s.kind === 'team' && s.cloudSpaceId && !remoteIds.has(s.cloudSpaceId)),
  );
  for (const space of revoked) {
    spacesRepository.softDeleteByCloudId(space.cloudSpaceId as string);
  }

  return { capable: true, activeSpaces: local.filter((s) => !revoked.has(s)) };
}
