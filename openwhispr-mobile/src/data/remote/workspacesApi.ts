import { api } from '@/lib/apiClient';

/** Subset of a GET /api/workspaces list entry — the Spaces list only needs the name. */
export interface RemoteWorkspace {
  id: string;
  name: string;
}

/**
 * GET /api/workspaces. The spaces endpoint returns only `workspace_id`, so the
 * names shown as separators in the Spaces list come from here and are joined
 * client-side. Like /api/me/spaces, a 404/405/501 means the deployed backend
 * predates this route — callers degrade to unnamed grouping rather than fail.
 */
export async function fetchMyWorkspaces(): Promise<{ data: RemoteWorkspace[] }> {
  return api.get<{ data: RemoteWorkspace[] }>('/api/workspaces');
}
