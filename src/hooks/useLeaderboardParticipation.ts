import { useCallback, useEffect } from "react";
import {
  getAuthRequestContextSnapshot,
  getValidatedAuthGeneration,
} from "../lib/authRequestContext";
import { writePendingLeaderboardLeave } from "../lib/pendingLeaderboardLeave";
import { useLeaderboardParticipationStore } from "../stores/leaderboardParticipationStore";
import type { LeaderboardParticipationAuthContext } from "../services/LeaderboardService";
import { useAuth } from "./useAuth";

function currentParticipationContext(userId: string): LeaderboardParticipationAuthContext | null {
  const snapshot = getAuthRequestContextSnapshot();
  const authGeneration = getValidatedAuthGeneration();
  if (snapshot.sessionUserId !== userId || authGeneration == null) return null;
  return { userId, authGeneration };
}

export function useLeaderboardParticipation() {
  const { isLoaded, isSignedIn, user } = useAuth();
  const userId = user?.id ?? null;
  const authGeneration = getValidatedAuthGeneration();
  const enabled = useLeaderboardParticipationStore((state) => state.enabled);
  const ready = useLeaderboardParticipationStore((state) => state.ready);
  const error = useLeaderboardParticipationStore((state) => state.error);
  const updating = useLeaderboardParticipationStore((state) => state.updating);

  const refresh = useCallback(async () => {
    const store = useLeaderboardParticipationStore.getState();
    if (!isLoaded || !isSignedIn || !userId || authGeneration == null) {
      store.reset();
      return;
    }
    const context = currentParticipationContext(userId);
    if (!context) {
      store.reset();
      return;
    }
    await store.refresh(context);
  }, [authGeneration, isLoaded, isSignedIn, userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const join = useCallback(async () => {
    if (!userId) return false;
    const store = useLeaderboardParticipationStore.getState();
    if (store.updating) return false;
    const context = currentParticipationContext(userId);
    if (!context) return false;
    return store.join(context);
  }, [userId]);

  const leave = useCallback(async () => {
    if (!userId) return true;
    const store = useLeaderboardParticipationStore.getState();
    const snapshot = getAuthRequestContextSnapshot();
    if (snapshot.sessionUserId !== userId) {
      writePendingLeaderboardLeave(userId);
      return false;
    }
    const context = currentParticipationContext(userId);
    if (!context) {
      store.queueLeave(userId);
      return false;
    }
    return store.leave(context);
  }, [userId]);

  return { enabled, error, join, leave, ready, refresh, updating };
}
