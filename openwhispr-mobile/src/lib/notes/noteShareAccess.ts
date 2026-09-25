import type { NoteAccessGrant, NoteAccessState } from '@/data/remote/noteSharingTypes';

export function isGroupPrincipal(type: NoteAccessGrant['principal']['type']): boolean {
  return type === 'team' || type === 'folder' || type === 'workspace';
}

/**
 * The server marks every stored group grant `inherited`; only synthetic `scope:` rows (space or
 * workspace membership) are read-only. Stored group grants need inherited-access management.
 */
export function canChangeGrant(
  access: NoteAccessState | undefined,
  grant: NoteAccessGrant,
): boolean {
  return Boolean(
    access?.can_manage_access &&
      !grant.id.startsWith('scope:') &&
      (!grant.inherited || access.can_manage_inherited_access),
  );
}

/** Private visibility suspends every stored grant and invitation; scope membership still applies. */
export function isPausedBySharingOff(grant: NoteAccessGrant): boolean {
  return !grant.id.startsWith('scope:');
}
