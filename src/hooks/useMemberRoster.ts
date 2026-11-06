import { useCallback, useEffect, useRef, useState } from "react";

// Load state for a roster backed by a server list. The team and teamspace
// members panels have their own tables and row actions.
export function useMemberRoster<M>(load: () => Promise<M[]>) {
  const [members, setMembers] = useState<M[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // What the last read failed with, so a panel can tell a team or teamspace that is gone apart
  // from a read that can be tried again.
  const [loadError, setLoadError] = useState<unknown>(null);
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

  return { members, loading, loadFailed, loadError, reload };
}
