import { useEffect, useState } from "react";
import { TeamsService } from "../services/TeamsService";
import type { TeamMember } from "../types/electron";

// Rosters cached per team so repeated lookups (conflict attribution, note
// authorship) don't refetch.
const rosterCache = new Map<string, Promise<TeamMember[]>>();

export function fetchTeamRoster(teamId: string): Promise<TeamMember[]> {
  let roster = rosterCache.get(teamId);
  if (!roster) {
    roster = TeamsService.listMembers(teamId);
    roster.catch(() => rosterCache.delete(teamId));
    rosterCache.set(teamId, roster);
  }
  return roster;
}

export function useTeamRoster(teamId: string | null): Map<string, TeamMember> | null {
  const [membersById, setMembersById] = useState<Map<string, TeamMember> | null>(null);

  useEffect(() => {
    if (!teamId) {
      setMembersById(null);
      return;
    }
    let stale = false;
    fetchTeamRoster(teamId)
      .then((members) => {
        if (!stale) setMembersById(new Map(members.map((m) => [m.user_id, m])));
      })
      .catch(() => {
        if (!stale) setMembersById(null);
      });
    return () => {
      stale = true;
    };
  }, [teamId]);

  return membersById;
}
