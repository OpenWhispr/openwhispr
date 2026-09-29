import { api } from '@/lib/apiClient';
import type { RemoteSpace } from '../spacesTypes';

/**
 * GET /api/me/spaces. A 404 (or 405/501) means the deployed backend predates
 * team spaces — callers treat that as the capability probe result, not an
 * error (see syncSpaces.ts).
 */
export async function fetchMySpaces(): Promise<{ data: RemoteSpace[] }> {
  return api.get<{ data: RemoteSpace[] }>('/api/me/spaces');
}
