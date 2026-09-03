import type {
  AnalyticsParticipation,
  Leaderboard,
  LeaderboardAccess,
  LeaderboardAccessScope,
  LeaderboardMetric,
  LeaderboardRange,
} from "../types/electron";
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
  getAccess,
  getLeaderboard,
  getParticipation,
  setParticipation,
};
