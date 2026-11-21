import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspacesService } from "../services/WorkspacesService";
import { InvitationsService } from "../services/InvitationsService";
import {
  currentBillingIdentity,
  isSameBillingIdentity,
  type BillingIdentity,
} from "../lib/billingRequestIdentity";
import { countLiveInvitations, type PeopleCount, type PeopleField } from "../lib/workspacePeople";
import type { Workspace } from "../types/electron";

interface StampedCount {
  identity: BillingIdentity;
  attempt: number;
  value: number | "failed";
}

async function loadMembers(workspaceId: string): Promise<number> {
  return (await WorkspacesService.listMembers(workspaceId)).length;
}

async function loadInvitations(workspaceId: string): Promise<number> {
  return countLiveInvitations(await InvitationsService.list(workspaceId), Date.now());
}

function useLegacyCount(
  workspaceId: string | null,
  authGeneration: number | null,
  attempt: number,
  currentAttempt: { current: number },
  load: (workspaceId: string) => Promise<number>
): PeopleField {
  const [stamped, setStamped] = useState<StampedCount | null>(null);
  // The reference scopes this result to one visit, even if the same identity is selected again.
  const identity = useMemo(
    () =>
      workspaceId !== null && authGeneration !== null ? { workspaceId, authGeneration } : null,
    [workspaceId, authGeneration]
  );

  useEffect(() => {
    if (workspaceId === null || !identity) return;
    if (!isSameBillingIdentity(identity, currentBillingIdentity(workspaceId))) return;
    let cancelled = false;
    const settle = (value: StampedCount["value"]): void => {
      if (
        !cancelled &&
        attempt === currentAttempt.current &&
        isSameBillingIdentity(identity, currentBillingIdentity(workspaceId))
      ) {
        setStamped({ identity, attempt, value });
      }
    };
    void load(workspaceId).then(settle, () => settle("failed"));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, identity, attempt, currentAttempt, load]);

  if (workspaceId === null) return null;
  if (identity === null) return "failed";
  if (stamped?.identity !== identity) return "loading";
  // Keep a known value visible during refresh. A failed value goes back to loading on retry.
  return stamped.value === "failed" && stamped.attempt !== attempt ? "loading" : stamped.value;
}

export function useWorkspacePeopleCount(
  workspace: Pick<Workspace, "id" | "member_count" | "invitation_count">,
  needsMembers: boolean,
  needsInvitations: boolean
): {
  people: PeopleCount;
  retry: () => void;
} {
  const [attempt, setAttempt] = useState(0);
  const currentAttempt = useRef(0);
  const membersId = needsMembers && workspace.member_count == null ? workspace.id : null;
  const invitationsId =
    needsInvitations && workspace.invitation_count == null ? workspace.id : null;
  const authGeneration =
    membersId !== null || invitationsId !== null
      ? (currentBillingIdentity(workspace.id)?.authGeneration ?? null)
      : null;
  const members = useLegacyCount(membersId, authGeneration, attempt, currentAttempt, loadMembers);
  const invitations = useLegacyCount(
    invitationsId,
    authGeneration,
    attempt,
    currentAttempt,
    loadInvitations
  );
  const retry = useCallback((): void => {
    currentAttempt.current += 1;
    setAttempt(currentAttempt.current);
  }, []);
  return { people: { members, invitations }, retry };
}
