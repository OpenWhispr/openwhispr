import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../components/ui/useToast";

// Load state plus per-row mutation tracking for a roster backed by a server
// list. Shared by the team- and space-backed wrappers around MemberRoster so
// both reload after every mutation and surface failures the same way.
export function useMemberRoster<M>(load: () => Promise<M[]>) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [members, setMembers] = useState<M[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      setMembers(await load());
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void reload();
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

  return { members, loading, loadFailed, reload, busyIds, mutate };
}
