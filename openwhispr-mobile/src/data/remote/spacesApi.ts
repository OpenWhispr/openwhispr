import { api } from '@/lib/apiClient';
import type { RemoteSpace } from '../spacesTypes';

/**
 * GET /api/me/spaces. A 404 (or 405/501) means the deployed backend predates
 * team spaces — callers treat that as the capability probe result, not an
 * error (see syncSpaces.ts).
 */
interface MySpacesResponse {
  data: RemoteSpace[];
  private_workspace_placement?: boolean;
  default_workspace_id?: string | null;
}

export async function fetchMySpaces(): Promise<MySpacesResponse> {
  return api.get<MySpacesResponse>('/api/me/spaces');
}
