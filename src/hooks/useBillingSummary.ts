import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { getValidatedAuthGeneration, subscribeAuthRequestContext } from "../lib/authRequestContext";
import {
  currentBillingIdentity,
  isSameBillingIdentity,
  type BillingIdentity,
} from "../lib/billingRequestIdentity";
import { getBillingSummary, type WorkspaceBillingSummary } from "../services/BillingSummaryService";

export type BillingSummaryView =
  | { kind: "disabled" }
  | { kind: "personal" }
  | { kind: "workspace"; workspaceId: string; canManageBilling: boolean };

interface BillingSummaryResult {
  summary: WorkspaceBillingSummary | undefined;
  refresh: () => void;
}

interface StoredSummary {
  identity: BillingIdentity;
  summary: WorkspaceBillingSummary | undefined;
}

export function useBillingSummary(
  view: BillingSummaryView,
  subscriptionKey?: string
): BillingSummaryResult {
  const generation = useSyncExternalStore(subscribeAuthRequestContext, getValidatedAuthGeneration);
  const workspaceId =
    view.kind === "personal"
      ? null
      : view.kind === "workspace" && view.canManageBilling
        ? view.workspaceId
        : undefined;
  // Keep a distinct identity object per visit, even for A → B → A with the same sign-in.
  const identity = useMemo(
    () =>
      workspaceId === undefined || generation === null
        ? null
        : { workspaceId, authGeneration: generation, subscriptionKey },
    [workspaceId, generation, subscriptionKey]
  );
  const activeIdentity = useRef<BillingIdentity | null>(null);
  const latestRequest = useRef(0);
  const [stored, setStored] = useState<StoredSummary>();

  const refresh = useCallback((): void => {
    if (
      !identity ||
      activeIdentity.current !== identity ||
      !isSameBillingIdentity(identity, currentBillingIdentity(identity.workspaceId))
    ) {
      return;
    }

    const request = ++latestRequest.current;
    void getBillingSummary(identity).then((summary) => {
      if (
        activeIdentity.current === identity &&
        latestRequest.current === request &&
        isSameBillingIdentity(identity, currentBillingIdentity(identity.workspaceId))
      ) {
        setStored({ identity, summary });
      }
    });
  }, [identity]);

  useLayoutEffect(() => {
    activeIdentity.current = identity;
    refresh();
    return () => {
      activeIdentity.current = null;
    };
  }, [identity, refresh]);

  return { summary: stored?.identity === identity ? stored.summary : undefined, refresh };
}
