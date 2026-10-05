import type { SpaceItem } from "../types/electron";
import type { MySpace } from "./SpacesService";

export interface AccountSpacePartition {
  proven: SpaceItem[];
  unproven: SpaceItem[];
}

function legacyMatch(local: SpaceItem, remoteSpaces: MySpace[]): MySpace | null {
  if (local.cloud_space_id || !local.cloud_team_id) return null;
  const candidates = remoteSpaces.filter(
    (space) => space.teams.length === 1 && space.teams[0]?.id === local.cloud_team_id
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Exact cloud-space identity is authoritative. A pre-spaces row may instead
 * be proven by one unambiguous remote space whose sole assigned team is the
 * row's legacy cloud_team_id; broad membership or name matching is unsafe.
 */
export function partitionLocalTeamSpaces(
  localSpaces: SpaceItem[],
  remoteSpaces: MySpace[]
): AccountSpacePartition {
  const remoteIds = new Set(remoteSpaces.map((space) => space.id));
  const proven: SpaceItem[] = [];
  const unproven: SpaceItem[] = [];

  for (const local of localSpaces.filter((space) => space.kind === "team")) {
    const matched =
      (local.cloud_space_id != null && remoteIds.has(local.cloud_space_id)) ||
      legacyMatch(local, remoteSpaces) != null;
    (matched ? proven : unproven).push(local);
  }

  return { proven, unproven };
}
