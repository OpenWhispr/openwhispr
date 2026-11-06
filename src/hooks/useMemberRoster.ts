import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../components/ui/useToast";

// Load state plus per-row mutation tracking for a roster backed by a server
// list. The team and teamspace members panels have their own tables and
// row actions; both use it for the load state.
export function useMemberRoster<M>(load: () => Promise<M[]>) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [members, setMembers] = useState<M[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // What the last read failed with, so a panel can tell a team or teamspace that is gone apart
  // from a read that can be tried again.
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // Reads after a change can land out of order, and an older list would bring back someone just
  // removed, so only the latest read is shown.
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    setLoadFailed(false);
    setLoadError(null);
    try {
      const next = await load();
      if (latest.current === request) setMembers(next);
    } catch (error) {
      if (latest.current === request) {
        setLoadFailed(true);
        setLoadError(error);
      }
    } finally {
      if (latest.current === request) setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void reload();
    // An answer for what was loaded before must not land on what is loaded now.
    return () => {
      latest.current += 1;
    };
  }, [reload]);

  const mutate = useCallback(
    async (userId: string, action: () => Promise<void>) => {
      setBusyIds((prev) => new Set(prev).add(userId));
      try {
        await action();
        await reload();
      } catch (err) {
        toast({
          title: t("common.error"),
          description: err instanceof Error ? err.message : t("common.unknownError"),
          variant: "destructive",
        });
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      }
    },
    [reload, toast, t]
  );

  return { members, loading, loadFailed, loadError, reload, busyIds, mutate };
}
