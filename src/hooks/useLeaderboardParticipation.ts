import { useCallback, useEffect } from "react";
import {
  getAuthRequestContextSnapshot,
  getValidatedAuthGeneration,
} from "../lib/authRequestContext";
import { writePendingLeaderboardLeave } from "../lib/pendingLeaderboardLeave";
import { useLeaderboardParticipationStore } from "../stores/leaderboardParticipationStore";
import type { LeaderboardParticipationAuthContext } from "../services/LeaderboardService";
import { useAuth } from "./useAuth";

// Settings and Insights mount often; an answer this recent is still the account's.
const PARTICIPATION_FRESH_MS = 5 * 60 * 1000;

function currentParticipationContext(userId: string): LeaderboardParticipationAuthContext | null {
  const snapshot = getAuthRequestContextSnapshot();
  const authGeneration = getValidatedAuthGeneration();
  if (snapshot.sessionUserId !== userId || authGeneration == null) return null;
  return { userId, authGeneration };
}

/** `autoRefresh: false` reads nothing on mount, for a surface that isn't showing the answer yet. */
export function useLeaderboardParticipation({
  autoRefresh = true,
}: { autoRefresh?: boolean } = {}) {
  const { isLoaded, isSignedIn, user } = useAuth();
  const userId = user?.id ?? null;
  const authGeneration = getValidatedAuthGeneration();
  const enabled = useLeaderboardParticipationStore((state) => state.enabled);
  const ready = useLeaderboardParticipationStore((state) => state.ready);
  const error = useLeaderboardParticipationStore((state) => state.error);
  const updating = useLeaderboardParticipationStore((state) => state.updating);
  const leavePending = useLeaderboardParticipationStore((state) => state.leavePending);

  const refresh = useCallback(
    async ({ keepAnswer = false }: { keepAnswer?: boolean } = {}) => {
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
      await store.refresh(context, { keepAnswer });
    },
    [authGeneration, isLoaded, isSignedIn, userId]
  );

  useEffect(() => {
    if (!autoRefresh) return;
    const current = useLeaderboardParticipationStore.getState();
    // The read delivers an owed leave and clears an error, so neither waits. An
    // unvalidated session never skips: refresh() resets the answer for it.
    if (
      userId &&
      authGeneration != null &&
      current.answeredUserId === userId &&
      !current.leavePending &&
      !current.error &&
      Date.now() - current.answeredAt < PARTICIPATION_FRESH_MS
    )
      return;
    void refresh({ keepAnswer: true });
  }, [authGeneration, autoRefresh, refresh, userId]);

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

  return { enabled, error, join, leave, leavePending, ready, refresh, updating };
}
