import { useCallback, useEffect, useState } from "react";
import { WorkspacesService } from "../services/WorkspacesService";
import type { JoinableWorkspace } from "../types/electron";

const DISMISSED_KEY = "workspaces.joinPromptDismissed";

/**
 * Workspace ids this account has already said "not now" to, so the prompt
 * doesn't reappear on every launch. Keyed by user so switching accounts starts
 * clean, and stored per-workspace so a *new* invitation still prompts.
 */
function readDismissed(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${DISMISSED_KEY}.${userId}`);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(userId: string, ids: Set<string>): void {
  localStorage.setItem(`${DISMISSED_KEY}.${userId}`, JSON.stringify([...ids]));
}

export function useJoinableWorkspaces(userId: string | null, enabled: boolean) {
  const [joinable, setJoinable] = useState<JoinableWorkspace[]>([]);

  useEffect(() => {
    if (!enabled || !userId) {
      setJoinable([]);
      return;
    }
    let cancelled = false;
    // A failure here must stay silent: this is a proactive nudge, not
    // something the user asked for.
    WorkspacesService.listJoinable()
      .then((entries) => {
        if (cancelled) return;
        const dismissed = readDismissed(userId);
        setJoinable(entries.filter((entry) => !dismissed.has(entry.workspace_id)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, userId]);

  const dismiss = useCallback(() => {
    if (!userId) return;
    const dismissed = readDismissed(userId);
    for (const entry of joinable) dismissed.add(entry.workspace_id);
    writeDismissed(userId, dismissed);
    setJoinable([]);
  }, [joinable, userId]);

  const markRequested = useCallback((workspaceId: string) => {
    setJoinable((entries) =>
      entries.map((entry) =>
        entry.workspace_id === workspaceId ? { ...entry, request_state: "pending" } : entry
      )
    );
  }, []);

  // A workspace whose request is already pending is context, not a prompt —
  // re-opening the dialog just to show "Requested" would be nagging.
  const hasActionable = joinable.some((entry) => entry.request_state === "none");

  return { joinable: hasActionable ? joinable : [], dismiss, markRequested };
}
