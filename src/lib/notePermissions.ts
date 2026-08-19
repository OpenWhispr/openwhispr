import type { NotePermission } from "../types/electron";

export interface NoteCapabilities {
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
  canManageInheritedAccess: boolean;
  canTransferOwnership: boolean;
}

export type NoteAclState = "loading" | "loaded" | "unavailable";

const NO_ACCESS: NoteCapabilities = {
  canView: false,
  canEdit: false,
  canShare: false,
  canDelete: false,
  canManageInheritedAccess: false,
  canTransferOwnership: false,
};

/**
 * Client-side presentation capabilities. The server remains authoritative.
 * Editors may manage direct grants and links, but ownership and inherited
 * team/folder audiences remain owner/admin controls.
 */
export function noteCapabilities(
  permission: NotePermission | null | undefined,
  hasAdminOverride = false
): NoteCapabilities {
  if (hasAdminOverride || permission === "owner") {
    return {
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: true,
      canManageInheritedAccess: true,
      canTransferOwnership: true,
    };
  }
  if (permission === "editor") {
    return {
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: false,
      canManageInheritedAccess: false,
      canTransferOwnership: false,
    };
  }
  if (permission === "viewer") {
    return { ...NO_ACCESS, canView: true };
  }
  return { ...NO_ACCESS };
}

export function resolveNotePermission({
  cachedPermission,
  aclState,
  isTeamNote,
  locallyOwned = false,
}: {
  cachedPermission?: NotePermission;
  aclState: NoteAclState;
  isTeamNote: boolean;
  locallyOwned?: boolean;
}): NotePermission | null {
  if (cachedPermission) return cachedPermission;
  // A personal cloud note may belong to this user or may be a view-only grant.
  // Fail closed only while an authenticated ACL request is active, rather
  // than making the local editor permanently read-only while signed out or
  // offline. When the local row already proves ownership (owner_user_id
  // matches the signed-in user), resolve immediately instead of holding the
  // editor read-only for a network round trip. Loaded legacy responses and
  // unavailable ACLs retain the old ownership fallback for compatibility and
  // offline editing.
  if (!isTeamNote && aclState === "loading") return locallyOwned ? "owner" : null;
  return isTeamNote ? "editor" : "owner";
}

interface SharedNoteScope {
  isTeamNote: boolean;
  hasCloudCopy: boolean;
}

// Per-note ACL grants only exist on cloud-backed personal notes: team notes
// follow space roles (spacePermissions), and rows without a cloud copy belong
// to this device.
function aclApplies({ isTeamNote, hasCloudCopy }: SharedNoteScope): boolean {
  return !isTeamNote && hasCloudCopy;
}

/**
 * Whether note-level ACLs veto deleting the note: an editor/viewer of a
 * directly shared personal note must not be offered Delete just because the
 * note sits in the (unenforced) private space. Composes with — never
 * replaces — the space-level rules in spacePermissions.
 */
export function sharedNoteBlocksDelete(
  permission: NotePermission | null,
  scope: SharedNoteScope
): boolean {
  if (!aclApplies(scope)) return false;
  return !noteCapabilities(permission).canDelete;
}

/**
 * Whether the note may be re-filed locally (folder or space moves). Moving
 * pushes a folder_id/scope PATCH the server denies for non-owners of a shared
 * personal note — the denial would fork an unexpected Personal copy — so
 * organization stays owner-only there. Team and local-only notes remain
 * freely movable (spacePermissions gates cross-space moves).
 */
export function canOrganizeNote(
  permission: NotePermission | null,
  scope: SharedNoteScope
): boolean {
  if (!aclApplies(scope)) return true;
  return permission === "owner";
}
