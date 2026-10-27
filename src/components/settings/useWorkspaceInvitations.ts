import { useCallback, useEffect, useRef, useState } from "react";
import { InvitationsService } from "../../services/InvitationsService";
import type { WorkspaceInvitation } from "../../types/electron";

export interface WorkspaceInvitationsState {
  status: "idle" | "loading" | "failed" | "ready";
  /** As the API returned them; the tab orders them. */
  invitations: WorkspaceInvitation[];
  /** Resolves once the list has settled, and never rejects. */
  reload: () => Promise<void>;
}

// What the last answer for one workspace left behind. `invitations` stays null until a load
// succeeds, which is what tells a failed first load apart from a failed reload.
interface WorkspaceSlot {
  workspaceId: string;
  invitations: WorkspaceInvitation[] | null;
  failed: boolean;
}

const NO_INVITATIONS: WorkspaceInvitation[] = [];

export function useWorkspaceInvitations(
  workspaceId: string,
  enabled: boolean
): WorkspaceInvitationsState {
  const [slot, setSlot] = useState<WorkspaceSlot>({
    workspaceId,
    invitations: null,
    failed: false,
  });
  const currentWorkspaceRef = useRef<string | null>(workspaceId);
  const latestRequestRef = useRef(0);

  // Declared before the load effect so a workspace switch updates the ref before that load starts.
  useEffect(() => {
    currentWorkspaceRef.current = workspaceId;
    return () => {
      currentWorkspaceRef.current = null;
    };
  }, [workspaceId]);

  const load = useCallback(async (targetWorkspaceId: string): Promise<void> => {
    // A caller can hold a reload from before a workspace switch; it must not touch the slot or
    // supersede the current workspace's request.
    if (currentWorkspaceRef.current !== targetWorkspaceId) return;
    const requestId = ++latestRequestRef.current;
    setSlot((current) =>
      current.workspaceId === targetWorkspaceId
        ? { ...current, failed: false }
        : { workspaceId: targetWorkspaceId, invitations: null, failed: false }
    );
    let invitations: WorkspaceInvitation[] | null = null;
    try {
      invitations = await InvitationsService.list(targetWorkspaceId);
    } catch {
      // Marks the slot as failed. The list loads once per People mount and again after a resend,
      // a cancel or an invite, and the failed view offers Try again.
    }
    // A switch, an unmount, or a newer request for this workspace makes this answer stale.
    if (currentWorkspaceRef.current !== targetWorkspaceId) return;
    if (latestRequestRef.current !== requestId) return;
    setSlot((current) => {
      const base =
        current.workspaceId === targetWorkspaceId
          ? current
          : { workspaceId: targetWorkspaceId, invitations: null, failed: false };
      return invitations
        ? { workspaceId: targetWorkspaceId, invitations, failed: false }
        : { ...base, failed: true };
    });
  }, []);

  useEffect(() => {
    if (enabled) void load(workspaceId);
  }, [enabled, workspaceId, load]);

  const reload = useCallback((): Promise<void> => load(workspaceId), [load, workspaceId]);

  // A slot left over from another workspace is invisible until its own load lands.
  const own = slot.workspaceId === workspaceId ? slot : null;
  const invitations = own?.invitations ?? NO_INVITATIONS;
  let status: WorkspaceInvitationsState["status"];
  if (!enabled) status = "idle";
  else if (own?.invitations) status = "ready";
  else if (own?.failed) status = "failed";
  else status = "loading";

  return { status, invitations, reload };
}
