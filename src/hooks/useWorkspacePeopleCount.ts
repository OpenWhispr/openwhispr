import { useCallback, useEffect, useState } from "react";
import { WorkspacesService } from "../services/WorkspacesService";
import { InvitationsService } from "../services/InvitationsService";
import {
  currentBillingIdentity,
  isSameBillingIdentity,
  type BillingIdentity,
} from "../lib/billingRequestIdentity";
import { countPeople, type PeopleCount } from "../lib/workspacePeople";

interface StampedCount {
  identity: BillingIdentity;
  people: PeopleCount;
}

/**
 * How many people are in a workspace, members and pending invitations. A null id reads nothing.
 * A count is shown only for the workspace and sign-in it was read under.
 */
export function useWorkspacePeopleCount(workspaceId: string | null): {
  people: PeopleCount | null;
  retry: () => void;
} {
  const [stamped, setStamped] = useState<StampedCount | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Read on every render so a new sign-in for the same workspace counts again.
  const authGeneration = workspaceId
    ? (currentBillingIdentity(workspaceId)?.authGeneration ?? null)
    : null;

  useEffect(() => {
    if (!workspaceId) return;
    const identity = currentBillingIdentity(workspaceId);
    if (!identity) return;
    let cancelled = false;
    const isCurrent = (): boolean =>
      !cancelled && isSameBillingIdentity(identity, currentBillingIdentity(workspaceId));
    Promise.all([
      WorkspacesService.listMembers(workspaceId),
      InvitationsService.list(workspaceId),
    ]).then(
      ([members, invitations]) => {
        if (!isCurrent()) return;
        const count = countPeople(members, invitations, Date.now());
        setStamped({ identity, people: { status: "known", count } });
      },
      () => {
        if (isCurrent()) setStamped({ identity, people: { status: "failed" } });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, authGeneration, attempt]);

  // A failed count goes back to loading so the retry shows; a known one stays until the new one.
  const retry = useCallback((): void => {
    setStamped((current) => (current?.people.status === "failed" ? null : current));
    setAttempt((value) => value + 1);
  }, []);

  if (!workspaceId) return { people: null, retry };
  // Nothing can be read without a validated sign-in.
  if (authGeneration === null) return { people: { status: "failed" }, retry };
  const people =
    stamped && isSameBillingIdentity(stamped.identity, { workspaceId, authGeneration })
      ? stamped.people
      : { status: "loading" as const };
  return { people, retry };
}
