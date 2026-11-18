import { useCallback, useEffect, useRef, useState } from "react";

export type LoadStatus = "idle" | "loading" | "ready" | "failed";

// Reads one thing for the panel and reads it again on demand. A reload keeps showing what it had,
// so the field and its chips never give way to a placeholder in the middle of someone's work.
export function useLoad<T>(
  load: (() => Promise<T>) | null,
  empty: T
): { status: LoadStatus; data: T; reload: () => Promise<T | null> } {
  const [state, setState] = useState<{ status: LoadStatus; data: T }>({
    status: load ? "loading" : "idle",
    data: empty,
  });
  const latest = useRef(0);

  // Resolves with what it read, or null when the read failed or was overtaken.
  const run = useCallback(async (): Promise<T | null> => {
    if (!load) return null;
    const request = ++latest.current;
    setState((current) =>
      current.status === "ready" ? current : { ...current, status: "loading" }
    );
    try {
      const data = await load();
      if (latest.current !== request) return null;
      setState({ status: "ready", data });
      return data;
    } catch {
      if (latest.current === request) setState((current) => ({ ...current, status: "failed" }));
      return null;
    }
  }, [load]);

  useEffect(() => {
    void run();
    // An answer for what was loaded before must not land on what is loaded now.
    return () => {
      latest.current += 1;
    };
  }, [run]);

  return { status: load ? state.status : "idle", data: state.data, reload: run };
}
