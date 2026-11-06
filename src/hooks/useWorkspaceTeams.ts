import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { heldCloudSpaceIds, subscribeHeldSpaces } from "../lib/heldSpaceDeletes";
import { withoutHeldTeams } from "../lib/heldTeamDeletes";
import { useHeldTeamIds } from "./useHeldTeamIds";
import { TeamsService } from "../services/TeamsService";
import type { Team } from "../types/electron";

export interface WorkspaceTeamsState {
  status: "idle" | "loading" | "failed" | "ready";
  /**
   * As the API returned them, less any team or teamspace whose delete is waiting out its Undo
   * window. Fields an older API leaves out stay missing.
   */
  teams: Team[];
  /** The last reload failed, so the list on screen may be out of date. */
  stale: boolean;
  /**
   * How many reads have landed with a list since this hook mounted. The list is kept between
   * uses, so a consumer that outlives its own openings notes the count when one begins, and
   * believes the list once the count has gone up.
   */
  loads: number;
  /**
   * Resolves once the list has settled, with the list it read, or null when the read failed or
   * was overtaken. Never rejects.
   */
  reload: () => Promise<Team[] | null>;
}

// What the last answer for one workspace left behind. `teams` stays null until a load succeeds,
// which is what tells a failed first load apart from a failed reload.
interface WorkspaceSlot {
  workspaceId: string;
  teams: Team[] | null;
  failed: boolean;
}

const NO_TEAMS: Team[] = [];

/**
 * The live team list for one workspace. Teams have no local mirror, so the page reads the server.
 */
export function useWorkspaceTeams(
  workspaceId: string | null,
  enabled: boolean = true
): WorkspaceTeamsState {
  const [slot, setSlot] = useState<WorkspaceSlot | null>(null);
  const [loads, setLoads] = useState(0);
  const currentWorkspaceRef = useRef<string | null>(workspaceId);
  const latestRequestRef = useRef(0);

  // Declared before the load effect so a workspace switch updates the ref before that load starts.
  useEffect(() => {
    currentWorkspaceRef.current = workspaceId;
    return () => {
      currentWorkspaceRef.current = null;
    };
  }, [workspaceId]);

  const load = useCallback(async (targetWorkspaceId: string | null): Promise<Team[] | null> => {
    // A caller can hold a reload from before a workspace switch; it must not touch the slot or
    // supersede the current workspace's request.
    if (!targetWorkspaceId || currentWorkspaceRef.current !== targetWorkspaceId) return null;
    const requestId = ++latestRequestRef.current;
    setSlot((current) =>
      current?.workspaceId === targetWorkspaceId
        ? { ...current, failed: false }
        : { workspaceId: targetWorkspaceId, teams: null, failed: false }
    );
    let teams: Team[] | null = null;
    try {
      teams = await TeamsService.list(targetWorkspaceId);
    } catch {
      // Marks the slot as failed. The page offers Try again, and reloads after a create.
    }
    // A switch, an unmount, or a newer request for this workspace makes this answer stale.
    if (currentWorkspaceRef.current !== targetWorkspaceId) return null;
    if (latestRequestRef.current !== requestId) return null;
    setSlot((current) => {
      const base =
        current?.workspaceId === targetWorkspaceId
          ? current
          : { workspaceId: targetWorkspaceId, teams: null, failed: false };
      return teams
        ? { workspaceId: targetWorkspaceId, teams, failed: false }
        : { ...base, failed: true };
    });
    if (teams) setLoads((count) => count + 1);
    return teams;
  }, []);

  useEffect(() => {
    if (enabled) void load(workspaceId);
  }, [enabled, workspaceId, load]);

  const reload = useCallback((): Promise<Team[] | null> => load(workspaceId), [load, workspaceId]);

  // A slot left over from another workspace is invisible until its own load lands.
  const own = slot && slot.workspaceId === workspaceId ? slot : null;
  const held = useHeldTeamIds();
  const heldSpaces = useSyncExternalStore(subscribeHeldSpaces, heldCloudSpaceIds);
  const listed = own?.teams ?? NO_TEAMS;
  const teams = useMemo(
    () =>
      withoutHeldTeams(listed, held).map((team) =>
        team.spaces?.some((space) => heldSpaces.has(space.id))
          ? { ...team, spaces: team.spaces.filter((space) => !heldSpaces.has(space.id)) }
          : team
      ),
    [listed, held, heldSpaces]
  );
  let status: WorkspaceTeamsState["status"];
  if (!enabled || !workspaceId) status = "idle";
  else if (own?.teams) status = "ready";
  else if (own?.failed) status = "failed";
  else status = "loading";

  return { status, teams, stale: Boolean(own?.teams && own.failed), loads, reload };
}
