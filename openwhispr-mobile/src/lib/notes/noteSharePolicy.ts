import type { ExternalSharingMode, ShareVisibility } from '@/data/remote/noteSharingTypes';

/** Mirrors the server's isSharingBlocked; an unknown policy is left to the server to enforce. */
export function isShareVisibilityAllowed(
  mode: ExternalSharingMode | null,
  visibility: ShareVisibility,
): boolean {
  if (visibility === 'private' || !mode || mode === 'allowed') return true;
  return mode === 'domain_only' && visibility === 'domain';
}
