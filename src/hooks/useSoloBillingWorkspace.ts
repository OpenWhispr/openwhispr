import { useEffect, useState } from "react";
import { WorkspacesService } from "../services/WorkspacesService";
import type { Workspace } from "../types/electron";

type SoloStatus = "checking" | "solo" | "showCard" | "unavailable";

/** Called only for a candidate from the workspace list, while a billing surface is open. */
export function useSoloBillingWorkspace(candidate: Workspace | undefined): SoloStatus {
  const [result, setResult] = useState<{ workspaceId: string; status: SoloStatus } | null>(null);
  useEffect(() => {
    if (!candidate) {
      setResult(null);
      return;
    }
    let current = true;
    const finish = (status: SoloStatus): void => {
      if (current) setResult({ workspaceId: candidate.id, status });
    };
    void WorkspacesService.getPeopleCounts(candidate.id).then(
      (counts) =>
        finish(counts.member_count === 1 && counts.pending_invitations === 0 ? "solo" : "showCard"),
      () => finish("unavailable")
    );
    return () => {
      current = false;
    };
  }, [candidate]);

  if (!candidate) return "showCard";
  if (result?.workspaceId !== candidate.id) return "checking";
  return result.status;
}
