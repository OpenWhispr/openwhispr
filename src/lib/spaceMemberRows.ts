import type { SpaceMemberEntry } from "../services/SpacesService";
import type { SpaceInvitation, SpaceTeamRef, TeamRole } from "../types/electron";

export type SpaceMemberRow =
  // Has a direct role, so it can be changed or removed here. `adminVia` names the teams whose
  // admins are admins of this teamspace through them: while there is one, a direct Member role
  // can't make this person less than an admin.
  | {
      kind: "person";
      id: string;
      member: SpaceMemberEntry;
      editable: boolean;
      adminVia: string[];
    }
  // Reaches the teamspace only through a team, so the change belongs to that team. `promotable`
  // is the one exception: see promoteInherited.
  | {
      kind: "inherited";
      id: string;
      member: SpaceMemberEntry;
      teamName: string;
      asAdmin: boolean;
      promotable: boolean;
    }
  | { kind: "invitation"; id: string; invitation: SpaceInvitation }
  | {
      kind: "team";
      id: string;
      team: { id: string; name: string; access: TeamRole; memberCount: number | null };
    };

export interface SpaceMemberRowsInput {
  members: SpaceMemberEntry[];
  invitations: SpaceInvitation[];
  teams: SpaceTeamRef[];
  teamCounts: ReadonlyMap<string, number>;
  canManage: boolean;
  /**
   * The viewer is the only admin, can't leave until there is another, and everyone else comes
   * through a team. Making one of them an admin is the only way out, so those rows take a role.
   */
  promoteInherited?: boolean;
  /** Joins the names of the teams an inherited person comes through, in the reader's language. */
  formatNames?: (names: string[]) => string;
}

const joinNames = (names: string[]): string => names.join(", ");

/**
 * Admins as the API sorts them, then invitations, then teams, then everyone else as the API
 * sorts them. Someone with a direct role is a person even when a team also reaches them.
 */
export function buildSpaceMemberRows({
  members,
  invitations,
  teams,
  teamCounts,
  canManage,
  promoteInherited = false,
  formatNames = joinNames,
}: SpaceMemberRowsInput): SpaceMemberRow[] {
  const toRow = (member: SpaceMemberEntry): SpaceMemberRow => {
    if (member.direct_role != null || member.via_teams.length === 0) {
      return {
        kind: "person",
        id: `person:${member.user_id}`,
        member,
        // A row with no direct grant would gain one from a role change, which isn't what a menu
        // on it would mean.
        editable: canManage && member.direct_role != null,
        adminVia: member.via_teams
          .filter((team) => team.role === "admin" && team.access === "admin")
          .map((team) => team.name),
      };
    }
    return {
      kind: "inherited",
      id: `person:${member.user_id}`,
      member,
      teamName: formatNames(member.via_teams.map((team) => team.name)),
      // With no direct role, an admin is one through a team.
      asAdmin: member.role === "admin",
      promotable: canManage && promoteInherited,
    };
  };

  return [
    ...members.filter((member) => member.role === "admin").map(toRow),
    ...invitations.map((invitation): SpaceMemberRow => ({
      kind: "invitation",
      id: `invitation:${invitation.id}`,
      invitation,
    })),
    ...teams.map((team): SpaceMemberRow => ({
      kind: "team",
      id: `team:${team.id}`,
      team: {
        id: team.id,
        name: team.name,
        // A mirror written before the API sent access holds admin assignments.
        access: team.access ?? "admin",
        memberCount: teamCounts.get(team.id) ?? null,
      },
    })),
    ...members.filter((member) => member.role !== "admin").map(toRow),
  ];
}
