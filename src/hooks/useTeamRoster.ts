import { useEffect, useState } from "react";
import { SpacesService } from "../services/SpacesService";
import type { TeamMember } from "../types/electron";

// Union rosters cached per cloud space so repeated lookups (conflict
// attribution, note authorship) don't refetch.
const rosterCache = new Map<string, Promise<TeamMember[]>>();

export function fetchSpaceRoster(cloudSpaceId: string): Promise<TeamMember[]> {
  let roster = rosterCache.get(cloudSpaceId);
  if (!roster) {
    roster = SpacesService.listMembers(cloudSpaceId);
    roster.catch(() => rosterCache.delete(cloudSpaceId));
    rosterCache.set(cloudSpaceId, roster);
  }
  return roster;
}

export function useSpaceRoster(cloudSpaceId: string | null): Map<string, TeamMember> | null {
  const [membersById, setMembersById] = useState<Map<string, TeamMember> | null>(null);

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
  }, [cloudSpaceId]);

  return membersById;
}
