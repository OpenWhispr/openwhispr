import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../components/ui/useToast";
import { useDialogSession } from "./useDialogSession";
import { subscribeSpaceRoster } from "../lib/spaceRosterCache";

// Local roster reads follow the committed resource and latest reload. Mutation
// services still own completed-write reconciliation, independently of this UI.
export function useMemberRoster<M>(
  resourceId: string,
  load: () => Promise<M[]>,
  onLoaded?: (members: M[]) => void
) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { sessionKey, capture, bindSession } = useDialogSession(true);
  const resourceKey = JSON.stringify(["member-roster", resourceId, sessionKey]);
  const [owner, setOwner] = useState({ load, resourceKey });
  const publishedCallback = useRef(onLoaded);
  // Callback replacement is not resource replacement: keep in-flight writes
  // and their required reload, but publish to the latest committed subscriber.
  useEffect(() => {
    publishedCallback.current = onLoaded;
  }, [onLoaded]);
  const [members, setMembers] = useState<M[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const committedOwner = useRef<typeof owner | null>(null);
  const request = useRef(0);
  const mutations = useRef(new Set<string>());

  if (owner.load !== load || owner.resourceKey !== resourceKey) {
    setOwner({ load, resourceKey });
    setMembers([]);
    setLoading(false);
    setLoadFailed(false);
    setBusyIds(new Set());
  }

  const bindRoster = useCallback(
    (node: HTMLElement | null) => {
      const cleanup = bindSession(node);
      if (!cleanup) return;
      committedOwner.current = owner;
      mutations.current.clear();
      return () => {
        cleanup();
        committedOwner.current = null;
        ++request.current;
        mutations.current.clear();
      };
    },
    [bindSession, owner]
  );

  const reload = useCallback(async () => {
    const completion = capture();
    if (!completion.isCurrent() || committedOwner.current !== owner) return;
    const read = ++request.current;
    const isCurrent = () =>
      completion.isCurrent() && committedOwner.current === owner && read === request.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const list = await load();
      if (!isCurrent()) return;
      setMembers(list);
      publishedCallback.current?.(list);
    } catch {
      if (isCurrent()) setLoadFailed(true);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [load, capture, owner]);

  useEffect(() => {
    void reload();
    return subscribeSpaceRoster(resourceKey, () => {
      void reload();
    });
  }, [reload, resourceKey]);

  const mutate = useCallback(
    async <T>(userId: string, action: () => Promise<T>, onSuccess?: (result: T) => void) => {
      const completion = capture();
      const isCurrent = () => completion.isCurrent() && committedOwner.current === owner;
      if (!isCurrent() || mutations.current.has(userId)) return;
      mutations.current.add(userId);
      setBusyIds((prev) => new Set(prev).add(userId));
      try {
        const result = await action();
        if (!isCurrent()) return;
        // The action service invalidates rosters after the write, including
        // reopened owners. Local completion only owns feedback and row state.
        onSuccess?.(result);
      } catch (err) {
        if (isCurrent()) {
          toast({
            title: t("common.error"),
            description: err instanceof Error ? err.message : t("common.unknownError"),
            variant: "destructive",
          });
        }
      } finally {
        if (isCurrent()) {
          mutations.current.delete(userId);
          setBusyIds((prev) => {
            const next = new Set(prev);
            next.delete(userId);
            return next;
          });
        }
      }
    },
    [capture, owner, toast, t]
  );

  return { members, loading, loadFailed, reload, busyIds, mutate, bindRoster };
}
