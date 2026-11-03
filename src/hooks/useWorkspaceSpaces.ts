import { useCallback, useEffect, useRef, useState } from "react";
import { SpacesService } from "../services/SpacesService";
import type { WorkspaceSpace } from "../types/electron";

export interface WorkspaceSpacesState {
  status: "idle" | "loading" | "failed" | "ready";
  /** As the directory returned them. Fields an older API leaves out stay missing. */
  spaces: WorkspaceSpace[];
  /** The last reload failed, so the list on screen may be out of date. */
  stale: boolean;
  /**
   * Resolves once the list has settled, with the list it read, or null when the read failed or
   * was overtaken. Never rejects.
   */
  reload: () => Promise<WorkspaceSpace[] | null>;
}

// What the last answer for one workspace left behind. `spaces` stays null until a load succeeds,
// which is what tells a failed first load apart from a failed reload.
interface WorkspaceSlot {
  workspaceId: string;
  spaces: WorkspaceSpace[] | null;
  failed: boolean;
}

const NO_SPACES: WorkspaceSpace[] = [];

/**
 * The live space directory for one workspace. The page reads it rather than the local mirror,
 * since most rows (spaces the caller isn't in) are never mirrored.
 */
export function useWorkspaceSpaces(
  workspaceId: string | null,
  enabled: boolean = true
): WorkspaceSpacesState {
  const [slot, setSlot] = useState<WorkspaceSlot | null>(null);
  const currentWorkspaceRef = useRef<string | null>(workspaceId);
  const latestRequestRef = useRef(0);

  // Declared before the load effect so a workspace switch updates the ref before that load starts.
  useEffect(() => {
    currentWorkspaceRef.current = workspaceId;
    return () => {
      currentWorkspaceRef.current = null;
    };
  }, [workspaceId]);

  const load = useCallback(
    async (targetWorkspaceId: string | null): Promise<WorkspaceSpace[] | null> => {
      // A caller can hold a reload from before a workspace switch; it must not touch the slot or
      // supersede the current workspace's request.
      if (!targetWorkspaceId || currentWorkspaceRef.current !== targetWorkspaceId) return null;
      const requestId = ++latestRequestRef.current;
      setSlot((current) =>
        current?.workspaceId === targetWorkspaceId
          ? { ...current, failed: false }
          : { workspaceId: targetWorkspaceId, spaces: null, failed: false }
      );
      let spaces: WorkspaceSpace[] | null = null;
      try {
        spaces = await SpacesService.listInWorkspace(targetWorkspaceId);
      } catch {
        // Marks the slot as failed. The page offers Try again, and reloads after a join or a create.
      }
      // A switch, an unmount, or a newer request for this workspace makes this answer stale.
      if (currentWorkspaceRef.current !== targetWorkspaceId) return null;
      if (latestRequestRef.current !== requestId) return null;
      setSlot((current) => {
        const base =
          current?.workspaceId === targetWorkspaceId
            ? current
            : { workspaceId: targetWorkspaceId, spaces: null, failed: false };
        return spaces
          ? { workspaceId: targetWorkspaceId, spaces, failed: false }
          : { ...base, failed: true };
      });
      return spaces;
    },
    []
  );

  useEffect(() => {
    if (enabled) void load(workspaceId);
  }, [enabled, workspaceId, load]);

  const reload = useCallback(
    (): Promise<WorkspaceSpace[] | null> => load(workspaceId),
    [load, workspaceId]
  );

  // A slot left over from another workspace is invisible until its own load lands.
  const own = slot && slot.workspaceId === workspaceId ? slot : null;
  const spaces = own?.spaces ?? NO_SPACES;
  let status: WorkspaceSpacesState["status"];
  if (!enabled || !workspaceId) status = "idle";
  else if (own?.spaces) status = "ready";
  else if (own?.failed) status = "failed";
  else status = "loading";

  return { status, spaces, stale: Boolean(own?.spaces && own.failed), reload };
}
