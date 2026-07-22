import type { NotePermission } from "../types/electron";

export interface NoteCapabilities {
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
  canManageInheritedAccess: boolean;
  canTransferOwnership: boolean;
}

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
