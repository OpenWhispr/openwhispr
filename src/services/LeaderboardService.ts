import type {
  AnalyticsParticipation,
  Leaderboard,
  LeaderboardAccess,
  LeaderboardAccessScope,
  LeaderboardMetric,
  LeaderboardRange,
} from "../types/electron";
import {
  clearPendingLeaderboardLeave,
  readPendingLeaderboardLeave,
  writePendingLeaderboardLeave,
} from "../lib/pendingLeaderboardLeave";
import {
  getAuthRequestContextSnapshot,
  getValidatedAuthGeneration,
} from "../lib/authRequestContext";
import {
  cloudGet,
  cloudGetForAuthGeneration,
  cloudPatchForAuthGeneration,
  CloudApiError,
  type DataWrap,
} from "./cloudApi";

export interface LeaderboardParticipationAuthContext {
  userId: string;
  authGeneration: number;
}

const participationOperationTails = new Map<string, Promise<void>>();

async function serializeParticipationOperation<T>(
  context: LeaderboardParticipationAuthContext,
  mutation: () => Promise<T>
): Promise<T> {
  const { userId, authGeneration } = context;
  const previous = participationOperationTails.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  participationOperationTails.set(userId, tail);
  await previous;
  try {
    const runForCapturedAccount = async () => {
      const current = getAuthRequestContextSnapshot();
      if (
        current.sessionUserId !== userId ||
        current.sessionGeneration !== authGeneration ||
        getValidatedAuthGeneration() !== authGeneration
      ) {
        throw new CloudApiError(
          "Authentication context changed before leaderboard participation could be reconciled",
          0,
          "AUTH_CONTEXT_CHANGED"
        );
      }
      return mutation();
    };
    const locks = globalThis.navigator?.locks;
    if (locks) {
      return await locks.request(
        `openwhispr-leaderboard-participation:${userId}`,
        runForCapturedAccount
      );
    }
    return await runForCapturedAccount();
  } finally {
    release();
    if (participationOperationTails.get(userId) === tail) {
      participationOperationTails.delete(userId);
    }
  }
}

async function getParticipation(
  context: LeaderboardParticipationAuthContext
): Promise<AnalyticsParticipation> {
  return serializeParticipationOperation(context, async () => {
    const response = await cloudGetForAuthGeneration<DataWrap<AnalyticsParticipation>>(
      "/api/analytics/participation",
      context.authGeneration
    );
    return response.data;
  });
}

async function setParticipation(
  enabled: boolean,
  authGeneration: number
): Promise<AnalyticsParticipation> {
  const response = await cloudPatchForAuthGeneration<DataWrap<AnalyticsParticipation>>(
    "/api/analytics/participation",
    { enabled },
    authGeneration
  );
  return response.data;
}

async function joinParticipation(
  context: LeaderboardParticipationAuthContext
): Promise<AnalyticsParticipation> {
  const { userId, authGeneration } = context;
  return serializeParticipationOperation(context, async () => {
    clearPendingLeaderboardLeave(userId);
    try {
      return await setParticipation(true, authGeneration);
    } catch (error) {
      // The API may have committed before a timeout or auth fence surfaced. Keep
      // a compensating leave beside the failed join until a valid pass delivers it.
      writePendingLeaderboardLeave(userId);
      throw error;
    }
  });
}

async function leaveParticipation(
  context: LeaderboardParticipationAuthContext
): Promise<AnalyticsParticipation> {
  const { userId, authGeneration } = context;
  // Persist the intent before it can wait. If auth changes while this operation
  // is queued, the request is fenced but the original account's leave survives.
  writePendingLeaderboardLeave(userId);
  return serializeParticipationOperation(context, async () => {
    const participation = await setParticipation(false, authGeneration);
    clearPendingLeaderboardLeave(userId);
    return participation;
  });
}

/**
 * Retries a leave the user already asked for and the network never delivered,
 * for that account only: a device may take itself off a leaderboard, never put
 * itself on one. Returns whether the account is still waiting for it.
 *
 * The record survives anything but a completed leave. Dropping it because a
 * request failed would leave the account on a leaderboard the user left, and
 * flushes are trigger-driven (a sync pass, a participation read), so a request
 * that keeps failing costs one call per trigger rather than a loop.
 */
async function flushPendingLeave(context: LeaderboardParticipationAuthContext): Promise<boolean> {
  const { userId, authGeneration } = context;
  return serializeParticipationOperation(context, async () => {
    // Check inside the mutation lock: an explicit join queued ahead of this
    // retry retires the older leave before it can issue a stale PATCH false.
    if (!readPendingLeaderboardLeave(userId)) return false;
    try {
      await setParticipation(false, authGeneration);
      clearPendingLeaderboardLeave(userId);
      return false;
    } catch (error) {
      console.error("Retrying the leaderboard leave failed:", error);
      return true;
    }
  });
}

async function getAccess(): Promise<LeaderboardAccess> {
  const response = await cloudGet<DataWrap<LeaderboardAccess>>("/api/leaderboard/access");
  return response.data;
}

async function getLeaderboard(
  scope: LeaderboardAccessScope,
  query: {
    metric: LeaderboardMetric;
    range: LeaderboardRange;
    weekStart?: string | null;
    page: number;
  }
): Promise<Leaderboard> {
  const params = new URLSearchParams({
    metric: query.metric,
    range: query.range,
    page: String(query.page),
  });
  if (query.range === "week" && query.weekStart) params.set("weekStart", query.weekStart);
  const path =
    scope.kind === "workspace"
      ? `/api/workspaces/${encodeURIComponent(scope.id)}/leaderboard`
      : "/api/leaderboard/domain";
  const response = await cloudGet<DataWrap<Leaderboard>>(`${path}?${params.toString()}`);
  return response.data;
}

export const LeaderboardService = {
  flushPendingLeave,
  getAccess,
  getLeaderboard,
  getParticipation,
  joinParticipation,
  leaveParticipation,
};
