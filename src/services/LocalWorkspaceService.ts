import type { Team, Workspace } from "../types/electron";

export const LOCAL_WORKSPACE_ID = "local-personal-workspace";

const NAME_KEY = "openwhispr.localWorkspace.name";
const CREATED_AT_KEY = "openwhispr.localWorkspace.createdAt";
const UPDATED_AT_KEY = "openwhispr.localWorkspace.updatedAt";
const TEAMS_KEY = "openwhispr.localWorkspace.teams";

export function isLocalWorkspaceId(id: string | null | undefined): boolean {
  return id === LOCAL_WORKSPACE_ID;
}

export function isLocalWorkspace(workspace: Pick<Workspace, "id"> | null | undefined): boolean {
  return isLocalWorkspaceId(workspace?.id);
}

export function getLocalWorkspace(): Workspace {
  const name = readString(NAME_KEY) || "Local workspace";
  const createdAt = readOrSetTimestamp(CREATED_AT_KEY);
  const updatedAt = readString(UPDATED_AT_KEY) || createdAt;
  return {
    id: LOCAL_WORKSPACE_ID,
    name,
    slug: slugify(name) || "local-workspace",
    created_by_user_id: "local-user",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    plan: "local",
    status: "local",
    trial_ends_at: null,
    current_period_end: null,
    cancel_at_period_end: false,
    seats: 1,
    created_at: createdAt,
    updated_at: updatedAt,
    role: "owner",
  };
}

export function renameLocalWorkspace(name: string): Workspace {
  const trimmed = name.trim() || "Local workspace";
  writeString(NAME_KEY, trimmed);
  writeString(UPDATED_AT_KEY, new Date().toISOString());
  return getLocalWorkspace();
}

export function listLocalTeams(): Team[] {
  return readTeams();
}

export function createLocalTeam(name: string, description: string | null = null): Team {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Team name is required");
  const now = new Date().toISOString();
  const team: Team = {
    id: `local-team-${createId()}`,
    workspace_id: LOCAL_WORKSPACE_ID,
    name: trimmed,
    slug: slugify(trimmed) || "team",
    description,
    created_at: now,
    updated_at: now,
    member_count: 0,
  };
  writeTeams([...readTeams(), team]);
  return team;
}

export function deleteLocalTeam(id: string): void {
  writeTeams(readTeams().filter((team) => team.id !== id));
}

function readTeams(): Team[] {
  const raw = readString(TEAMS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTeams(teams: Team[]): void {
  writeString(TEAMS_KEY, JSON.stringify(teams));
}

function readOrSetTimestamp(key: string): string {
  const existing = readString(key);
  if (existing) return existing;
  const now = new Date().toISOString();
  writeString(key, now);
  return now;
}

function readString(key: string): string | null {
  return getStorage()?.getItem(key) ?? null;
}

function writeString(key: string, value: string): void {
  getStorage()?.setItem(key, value);
}

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
