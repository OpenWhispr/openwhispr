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
  recordPendingLeaderboardLeaveAttempt,
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
} from "./cloudApi";

export interface LeaderboardParticipationAuthContext {
  userId: string;
  authGeneration: number;
}

// The API lists 52 weeks of history plus the current week when it has no rows
// of its own, so anything longer is not a board this client can have asked for.
const LEADERBOARD_MAX_WEEK_STARTS = 53;

// The refresh window drives setInterval, which silently clamps a delay past a
// signed 32-bit millisecond count to 1ms — turning an implausible value into a
// request loop against an endpoint that re-aggregates the roster on every call.
const LEADERBOARD_MAX_REFRESH_SECONDS = 86_400;

const LEADERBOARD_METRICS = new Set<LeaderboardMetric>([
  "total_words",
  "words_per_minute",
  "current_daily_streak",
  "desktop_words",
  "mobile_words",
]);
const LEADERBOARD_ACCESS_STATES = new Set([
  "ready",
  "invite",
  "accept_invite",
  "request_join",
  "create",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// The week picker formats these with Intl in the render body, where an
// unparseable value throws past every async fallback. "Is a string" is not
// enough: the round trip also rejects a well-shaped day that does not exist.
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function responseData(value: unknown, label: string): unknown {
  if (!isRecord(value) || !("data" in value)) {
    throw new Error(`Malformed ${label} response from cloud`);
  }
  return value.data;
}

function isParticipation(value: unknown): value is AnalyticsParticipation {
  return (
    isRecord(value) &&
    typeof value.configured === "boolean" &&
    typeof value.enabled === "boolean" &&
    isNullableString(value.updatedAt)
  );
}

function isAccessScope(value: unknown): value is LeaderboardAccessScope {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    (value.kind === "workspace" || value.kind === "domain") &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isNonnegativeInteger(value.memberCount) &&
    (value.state === "ready" || value.state === "invite") &&
    (value.role === null ||
      value.role === "owner" ||
      value.role === "admin" ||
      value.role === "member")
  );
}

function isInvitation(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.workspaceId === "string" &&
      typeof value.workspaceName === "string" &&
      isNullableString(value.inviterName))
  );
}

function isJoinableWorkspace(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      isNonnegativeInteger(value.memberCount) &&
      (value.requestState === "none" || value.requestState === "pending"))
  );
}

function isLeaderboardAccess(value: unknown): value is LeaderboardAccess {
  return (
    isRecord(value) &&
    LEADERBOARD_ACCESS_STATES.has(String(value.state)) &&
    Array.isArray(value.scopes) &&
    value.scopes.every(isAccessScope) &&
    isNullableString(value.domain) &&
    isNonnegativeInteger(value.colleagueCount) &&
    isInvitation(value.invitation) &&
    isJoinableWorkspace(value.joinableWorkspace)
  );
}

function isLeaderboardMember(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.userId === "string" &&
    isNullableString(value.name) &&
    isNullableString(value.email) &&
    isNullableString(value.image) &&
    isNonnegativeInteger(value.totalWords) &&
    isNonnegativeInteger(value.desktopWords) &&
    isNonnegativeInteger(value.mobileWords) &&
    (value.averageWpm === null || isNonnegativeInteger(value.averageWpm)) &&
    isNonnegativeInteger(value.currentStreakDays) &&
    isNonnegativeInteger(value.rank) &&
    value.rank > 0
  );
}

function isLeaderboard(value: unknown): value is Leaderboard {
  if (!isRecord(value) || !isRecord(value.scope)) return false;
  return (
    typeof value.scope.key === "string" &&
    (value.scope.kind === "workspace" || value.scope.kind === "domain") &&
    typeof value.scope.id === "string" &&
    typeof value.scope.name === "string" &&
    isNullableString(value.viewerUserId) &&
    LEADERBOARD_METRICS.has(value.metric as LeaderboardMetric) &&
    (value.range === "week" || value.range === "all") &&
    (value.weekStart === null || isCalendarDate(value.weekStart)) &&
    Array.isArray(value.availableWeekStarts) &&
    value.availableWeekStarts.length <= LEADERBOARD_MAX_WEEK_STARTS &&
    value.availableWeekStarts.every(isCalendarDate) &&
    Array.isArray(value.leaders) &&
    value.leaders.every(isLeaderboardMember) &&
    Array.isArray(value.members) &&
    value.members.every(isLeaderboardMember) &&
    isNonnegativeInteger(value.totalMembers) &&
    (value.viewerRank === null ||
      (isNonnegativeInteger(value.viewerRank) && value.viewerRank > 0)) &&
    isNonnegativeInteger(value.page) &&
    isNonnegativeInteger(value.pageSize) &&
    value.pageSize > 0 &&
    typeof value.generatedAt === "string" &&
    typeof value.refreshAfterSeconds === "number" &&
    Number.isFinite(value.refreshAfterSeconds) &&
    value.refreshAfterSeconds > 0 &&
    value.refreshAfterSeconds <= LEADERBOARD_MAX_REFRESH_SECONDS
  );
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
    try {
      const response = await cloudGetForAuthGeneration<unknown>(
        "/api/analytics/participation",
        context.authGeneration
      );
      const participation = responseData(response, "leaderboard participation");
      if (!isParticipation(participation)) {
        throw new Error("Malformed leaderboard participation response from cloud");
      }
      return participation;
    } catch (error) {
      // During the staggered rollout, an older API has no participation route.
      // Preserve the existing Insights preference until the API is upgraded.
      if (error instanceof CloudApiError && error.status === 404) {
        return { configured: false, enabled: false, updatedAt: null };
      }
      throw error;
    }
  });
}

async function setParticipation(
  enabled: boolean,
  authGeneration: number
): Promise<AnalyticsParticipation> {
  const response = await cloudPatchForAuthGeneration<unknown>(
    "/api/analytics/participation",
    { enabled },
    authGeneration
  );
  const participation = responseData(response, "leaderboard participation");
  if (!isParticipation(participation)) {
    throw new Error("Malformed leaderboard participation response from cloud");
  }
  return participation;
}

// Codes the main process raises from its auth fence, which runs before the
// request is put on the wire. Nothing reached the API under either of them.
const LOCAL_AUTH_FENCE_CODES = new Set(["AUTH_CONTEXT_CHANGED", "AUTH_CONTEXT_UNVALIDATED"]);

type ParticipationWriteOutcome = "applied" | "refused" | "not_sent" | "unknown";

/**
 * What a failed participation write actually did to the account row.
 *
 * `applied` — cloudPatchForAuthGeneration raises CloudApiError for every
 * transport and HTTP failure, so any other error escaped while reading a body
 * the API had already answered 2xx with. The write landed; only the answer was
 * unreadable.
 * `refused` — a 4xx is the server's own verdict on a request it declined to act
 * on, so the row is untouched.
 * `not_sent` — fenced on this device; the request never left.
 * `unknown` — no response or a server error, so the row may or may not have moved.
 *
 * Only `unknown` needs compensating: banking a leave for the other three either
 * undoes work the account asked for, or strands a record with nothing to undo.
 */
function classifyParticipationWriteFailure(error: unknown): ParticipationWriteOutcome {
  if (!(error instanceof CloudApiError)) return "applied";
  if (error.code != null && LOCAL_AUTH_FENCE_CODES.has(error.code)) return "not_sent";
  if (error.status >= 400 && error.status < 500) return "refused";
  return "unknown";
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
      if (classifyParticipationWriteFailure(error) === "unknown") {
        writePendingLeaderboardLeave(userId);
      }
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
    try {
      const participation = await setParticipation(false, authGeneration);
      clearPendingLeaderboardLeave(userId);
      return participation;
    } catch (error) {
      settleUndeliveredLeave(userId, error);
      throw error;
    }
  });
}

/**
 * Retires a pending leave the API has already acted on or can never act on, and
 * otherwise charges it one attempt so it cannot preempt the sync throttle
 * forever. Returns whether the account is still waiting to come off the board.
 */
function settleUndeliveredLeave(userId: string, error: unknown): boolean {
  const outcome = classifyParticipationWriteFailure(error);
  // The row is already false — the API accepted the PATCH and only its answer
  // was unreadable, so there is nothing left to retry.
  if (outcome === "applied") {
    clearPendingLeaderboardLeave(userId);
    return false;
  }
  // An API without the participation route cannot be holding the account on a
  // leaderboard, so the leave has nothing to deliver. Every other refusal is
  // kept: a 429 or a 401 is answered by retrying later, not by dropping the
  // account's opt-out.
  if (outcome === "refused" && error instanceof CloudApiError && error.status === 404) {
    clearPendingLeaderboardLeave(userId);
    return false;
  }
  recordPendingLeaderboardLeaveAttempt(userId);
  return true;
}

/**
 * Retries a leave the user already asked for and the network never delivered,
 * for that account only: a device may take itself off a leaderboard, never put
 * itself on one. Returns whether the account is still waiting for it.
 *
 * The record survives every outcome that leaves the account row untouched, and
 * flushes are trigger-driven (a sync pass, a participation read), so a request
 * that keeps failing costs one call per trigger rather than a loop. It is
 * retired only once the API has acted on it or has shown it never can — see
 * settleUndeliveredLeave.
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
      return settleUndeliveredLeave(userId, error);
    }
  });
}

async function getAccess(): Promise<LeaderboardAccess> {
  const response = await cloudGet<unknown>("/api/leaderboard/access");
  const access = responseData(response, "leaderboard access");
  if (!isLeaderboardAccess(access))
    throw new Error("Malformed leaderboard access response from cloud");
  return access;
}

async function getLeaderboard(
  scope: LeaderboardAccessScope,
  query: {
    metric: LeaderboardMetric;
    range: LeaderboardRange;
    weekStart?: string | null;
    includeWeekStarts?: boolean;
    page: number;
  }
): Promise<Leaderboard> {
  const params = new URLSearchParams({
    metric: query.metric,
    range: query.range,
    page: String(query.page),
  });
  if (query.range === "week" && query.weekStart) params.set("weekStart", query.weekStart);
  if (query.includeWeekStarts === false) params.set("includeWeekStarts", "false");
  const path =
    scope.kind === "workspace"
      ? `/api/workspaces/${encodeURIComponent(scope.id)}/leaderboard`
      : "/api/leaderboard/domain";
  const response = await cloudGet<unknown>(`${path}?${params.toString()}`);
  const leaderboard = responseData(response, "leaderboard");
  if (!isLeaderboard(leaderboard)) throw new Error("Malformed leaderboard response from cloud");
  return leaderboard;
}

export const LeaderboardService = {
  flushPendingLeave,
  getAccess,
  getLeaderboard,
  getParticipation,
  joinParticipation,
  leaveParticipation,
};
