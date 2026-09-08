import { create } from "zustand";
import { writePendingLeaderboardLeave } from "../lib/pendingLeaderboardLeave";
import {
  LeaderboardService,
  type LeaderboardParticipationAuthContext,
} from "../services/LeaderboardService";

/**
 * The account's leaderboard participation, shared by every surface that reads
 * or changes it. Settings and the Insights page can both mount
 * useInsightsSyncOptIn, and while each kept its own copy an opt-out taken in one
 * left the other showing a roster the user had already left.
 *
 * Nothing here joins on the user's behalf: only join() ever sends `true`, and
 * a leave the network refused is held on the device and retried until the
 * account takes it (see pendingLeaderboardLeave).
 */
interface LeaderboardParticipationState {
  /** The account row says joined. False whenever the answer is unknown. */
  enabled: boolean;
  /** The account has explicitly chosen a participation state. */
  configured: boolean;
  ready: boolean;
  /** Which side failed, because they need different offers: an unknown answer
   *  gets a Retry, a refused write gets the action that failed back. */
  error: "read" | "write" | null;
  updating: boolean;
  reset: () => void;
  refresh: (context: LeaderboardParticipationAuthContext) => Promise<void>;
  publishAnswer: (enabled: boolean, configured: boolean, generation: number) => void;
  join: (context: LeaderboardParticipationAuthContext) => Promise<boolean>;
  leave: (context: LeaderboardParticipationAuthContext) => Promise<boolean>;
  queueLeave: (userId: string) => void;
}

// A completed write is the newest answer there is, so it retires every read
// still in flight — including one the sync toggle started after the request
// went out, which would otherwise settle the account on pre-write state.
// Writes read the same counter: one taken out for the departing account has no
// answer to give about the account that replaced it.
let readId = 0;
// Keep write invalidation separate so an older account cannot clear a newer account's pending state.
let writeId = 0;
let activeRefresh: { key: string; promise: Promise<void> } | null = null;

export const useLeaderboardParticipationStore = create<LeaderboardParticipationState>(
  (set, get) => ({
    enabled: false,
    configured: false,
    ready: false,
    error: null,
    updating: false,

    reset: () => {
      readId += 1;
      writeId += 1;
      activeRefresh = null;
      // Reset updating too: a write left running for the departing account must
      // not make refresh() skip the replacement account's read.
      set({ enabled: false, configured: false, ready: false, error: null, updating: false });
    },

    // The retired read never reports itself finished either, hence the ready flag.
    publishAnswer: (enabled, configured, generation) => {
      if (generation !== readId) return;
      readId += 1;
      set({ enabled, configured, ready: true, error: null });
    },

    // Read-only, and only when a caller asks: the account preference is the one
    // source of truth for who is on a leaderboard, and nothing here may join or
    // leave one on the user's behalf.
    refresh: async (context) => {
      const key = `${context.userId}:${context.authGeneration}`;
      if (activeRefresh?.key === key) {
        await activeRefresh.promise;
        return;
      }
      // A write already in flight is the newer answer by definition — skip a
      // read that could settle the account on the state it is mid-change.
      if (get().updating) return;

      const promise = (async () => {
        const currentReadId = ++readId;
        set({ ready: false, error: null });
        try {
          // An opt-out the network never delivered is retried first, so the answer
          // below is the one the user asked for rather than the row it left behind.
          const stillLeaving = await LeaderboardService.flushPendingLeave(context);
          const participation = await LeaderboardService.getParticipation(context);
          if (currentReadId !== readId) return;
          set({
            enabled: participation.enabled && !stillLeaving,
            configured: participation.configured || stillLeaving,
          });
        } catch (error) {
          if (currentReadId !== readId) return;
          console.error("Reading leaderboard participation failed:", error);
          // A read that failed leaves participation unknown, so it has to fail
          // closed. Keeping the last answer would also let the leaderboard's 403
          // recovery re-read, fail, and immediately re-issue the same 403 forever.
          // The surface offers a Retry rather than a Join, which would ask an
          // account that may already be on a leaderboard to join it again.
          set({ enabled: false, configured: false, error: "read" });
        } finally {
          if (currentReadId === readId) set({ ready: true });
        }
      })();
      activeRefresh = { key, promise };
      try {
        await promise;
      } finally {
        if (activeRefresh?.promise === promise) activeRefresh = null;
      }
    },

    join: async (context) => {
      const generation = readId;
      const currentWriteId = ++writeId;
      set({ updating: true });
      try {
        const participation = await LeaderboardService.joinParticipation(context);
        if (currentWriteId === writeId) {
          get().publishAnswer(participation.enabled, participation.configured, generation);
        }
        return participation.enabled;
      } catch (error) {
        console.error("Joining the leaderboard failed:", error);
        if (currentWriteId === writeId && generation === readId) {
          readId += 1;
          set({ enabled: false, configured: true, ready: true, error: "write" });
        }
        return false;
      } finally {
        if (currentWriteId === writeId) set({ updating: false });
      }
    },

    leave: async (context) => {
      const generation = readId;
      const currentWriteId = ++writeId;
      set({ updating: true });
      try {
        const participation = await LeaderboardService.leaveParticipation(context);
        if (currentWriteId === writeId) {
          get().publishAnswer(participation.enabled, participation.configured, generation);
        }
        return true;
      } catch (error) {
        console.error("Leaving the leaderboard failed:", error);
        // The opt-out is kept and retried until the account takes it, so this
        // device stops showing the user as participating straight away rather
        // than asking them to remember to try again.
        if (currentWriteId === writeId) get().publishAnswer(false, true, generation);
        return false;
      } finally {
        if (currentWriteId === writeId) set({ updating: false });
      }
    },

    // A click taken while auth is revalidating is still an opt-out. Stop
    // presenting participation now and deliver the account-scoped leave as
    // soon as that same account regains a validated credential.
    queueLeave: (userId) => {
      writePendingLeaderboardLeave(userId);
      const generation = readId;
      get().publishAnswer(false, true, generation);
    },
  })
);
