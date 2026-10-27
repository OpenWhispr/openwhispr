import type { MemberTeamRef, WorkspaceInvitation, WorkspaceMember } from "../types/electron";
import { filterMemberCandidates } from "./memberCandidates";

export const TEAM_SUMMARY_SHOWN = 2;

const DAY_MS = 86_400_000;

// One shared empty list, so a store selector returning it keeps the same reference across renders.
const NO_MEMBERS: WorkspaceMember[] = [];

/**
 * The store's roster as `workspaceId`'s, or nothing when the store holds another workspace's:
 * a request still in flight from before a workspace switch can answer for the old one.
 */
export function rosterFor(
  state: { members: WorkspaceMember[]; membersWorkspaceId: string | null },
  workspaceId: string | null | undefined
): WorkspaceMember[] {
  return workspaceId && state.membersWorkspaceId === workspaceId ? state.members : NO_MEMBERS;
}

export function filterMembers<M extends { name?: string | null; email?: string | null }>(
  members: M[],
  query: string
): M[] {
  return filterMemberCandidates(members, query);
}

// An API from before release 3 omits `teams` entirely; an empty array means the
// API sent teams and this member just has none. The column only hides in the
// first case.
export function rosterHasTeams(members: Pick<WorkspaceMember, "teams">[]): boolean {
  return members.some((member) => Array.isArray(member.teams));
}

export function teamSummary(teams: MemberTeamRef[] | undefined): { shown: string[]; more: number } {
  const all = teams ?? [];
  return {
    shown: all.slice(0, TEAM_SUMMARY_SHOWN).map((team) => team.name),
    more: Math.max(0, all.length - TEAM_SUMMARY_SHOWN),
  };
}

export type MembersView =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "noResults"; query: string }
  | { kind: "rows"; rows: WorkspaceMember[] };

export function membersView(input: {
  loading: boolean;
  error: boolean;
  members: WorkspaceMember[];
  query: string;
}): MembersView {
  const { loading, error, members, query } = input;
  // Only an empty roster blocks on loading/failure: a refresh over a cached
  // roster keeps the rows on screen instead of flashing a skeleton or error.
  if (members.length === 0) {
    if (loading) return { kind: "loading" };
    if (error) return { kind: "failed" };
  }
  const trimmed = query.trim();
  const rows = filterMembers(members, trimmed);
  if (rows.length === 0 && trimmed) return { kind: "noResults", query: trimmed };
  return { kind: "rows", rows };
}

export type InvitationStatus = "pending" | "expired";

export function invitationStatus(
  inv: Pick<WorkspaceInvitation, "expires_at">,
  now: number
): InvitationStatus {
  const expiresAt = new Date(inv.expires_at).getTime();
  // NaN fails the comparison, so an unparseable date must be handled explicitly
  // or it would read as pending forever.
  return Number.isNaN(expiresAt) || expiresAt <= now ? "expired" : "pending";
}

export function invitationDaysLeft(
  inv: Pick<WorkspaceInvitation, "expires_at">,
  now: number
): number {
  return Math.ceil((new Date(inv.expires_at).getTime() - now) / DAY_MS);
}

export function orderInvitations(
  invitations: WorkspaceInvitation[],
  now: number
): WorkspaceInvitation[] {
  const pending = invitations.filter((inv) => invitationStatus(inv, now) === "pending");
  const expired = invitations.filter((inv) => invitationStatus(inv, now) === "expired");
  return [...pending, ...expired];
}
