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
} from "../lib/pendingLeaderboardLeave";
import { cloudGet, cloudPatch, type DataWrap } from "./cloudApi";

async function getParticipation(): Promise<AnalyticsParticipation> {
  const response = await cloudGet<DataWrap<AnalyticsParticipation>>("/api/analytics/participation");
  return response.data;
}

async function setParticipation(enabled: boolean): Promise<AnalyticsParticipation> {
  const response = await cloudPatch<DataWrap<AnalyticsParticipation>>(
    "/api/analytics/participation",
    { enabled }
  );
  return response.data;
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
async function flushPendingLeave(userId: string | null): Promise<boolean> {
  if (!userId || !readPendingLeaderboardLeave(userId)) return false;
  try {
    await setParticipation(false);
    clearPendingLeaderboardLeave(userId);
    return false;
  } catch (error) {
    console.error("Retrying the leaderboard leave failed:", error);
    return true;
  }
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
    timeZone: string;
    page: number;
  }
): Promise<Leaderboard> {
  const params = new URLSearchParams({
    metric: query.metric,
    range: query.range,
    timeZone: query.timeZone,
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
  setParticipation,
};
