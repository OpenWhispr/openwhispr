import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { SpacesService } from "../services/SpacesService";
import {
  fetchCachedSpaceRoster,
  readSpaceRosterVersion,
  subscribeSpaceRoster,
} from "../lib/spaceRosterCache";
import type { TeamMember } from "../types/electron";

export function fetchSpaceRoster(cloudSpaceId: string): Promise<TeamMember[]> {
  return fetchCachedSpaceRoster(cloudSpaceId, () => SpacesService.listMembers(cloudSpaceId));
}

export function useSpaceRoster(cloudSpaceId: string | null): Map<string, TeamMember> | null {
  const [membersById, setMembersById] = useState<Map<string, TeamMember> | null>(null);
  const subscribe = useCallback(
    (listener: () => void) =>
      cloudSpaceId ? subscribeSpaceRoster(cloudSpaceId, listener) : () => {},
    [cloudSpaceId]
  );
  const getVersion = useCallback(() => readSpaceRosterVersion(cloudSpaceId), [cloudSpaceId]);
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);

  useEffect(() => {
    if (!cloudSpaceId) {
      setMembersById(null);
      return;
    }
    let stale = false;
    fetchSpaceRoster(cloudSpaceId)
      .then((members) => {
        if (!stale) setMembersById(new Map(members.map((m) => [m.user_id, m])));
      })
      .catch(() => {
        if (!stale) setMembersById(null);
      });
    return () => {
      stale = true;
    };
  }, [cloudSpaceId, version]);

  return membersById;
}
