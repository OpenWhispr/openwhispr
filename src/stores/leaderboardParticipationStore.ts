import { create } from "zustand";
import {
  clearPendingLeaderboardLeave,
  writePendingLeaderboardLeave,
} from "../lib/pendingLeaderboardLeave";
import { LeaderboardService } from "../services/LeaderboardService";

/**
 * The account's leaderboard participation, shared by every surface that reads
 * or changes it. Settings and the leaderboard both mount useInsightsSyncOptIn,
 * and while each kept its own copy an opt-out taken in one left the other
 * showing a roster the user had already left.
 *
 * Nothing here joins on the user's behalf: only join() ever sends `true`, and
 * a leave the network refused is held on the device and retried until the
 * account takes it (see pendingLeaderboardLeave).
 */
interface LeaderboardParticipationState {
  /** The account row says joined. False whenever the answer is unknown. */
  enabled: boolean;
  ready: boolean;
  /** Which side failed, because they need different offers: an unknown answer
   *  gets a Retry, a refused write gets the action that failed back. */
  error: "read" | "write" | null;
  updating: boolean;
  reset: () => void;
  refresh: (userId: string | null) => Promise<void>;
  publishAnswer: (enabled: boolean) => void;
  join: (userId: string | null) => Promise<void>;
  leave: (userId: string | null) => Promise<boolean>;
}

// A completed write is the newest answer there is, so it retires every read
// still in flight — including one the sync toggle started after the request
// went out, which would otherwise settle the account on pre-write state.
let readId = 0;

export const useLeaderboardParticipationStore = create<LeaderboardParticipationState>(
  (set, get) => ({
    enabled: false,
    ready: false,
    error: null,
    updating: false,

    reset: () => {
      readId += 1;
      set({ enabled: false, ready: false, error: null });
    },

    // The retired read never reports itself finished either, hence the ready flag.
    publishAnswer: (enabled) => {
      readId += 1;
      set({ enabled, ready: true, error: null });
    },

    // Read-only, and only when a caller asks: the account preference is the one
    // source of truth for who is on a leaderboard, and nothing here may join or
    // leave one on the user's behalf.
    refresh: async (userId) => {
      // A write already in flight is the newer answer by definition — reading
      // around it would settle the account on the state it is mid-change.
      if (get().updating) return;
      const currentReadId = ++readId;
      set({ ready: false, error: null });
      try {
        // An opt-out the network never delivered is retried first, so the answer
        // below is the one the user asked for rather than the row it left behind.
        const stillLeaving = await LeaderboardService.flushPendingLeave(userId);
        const participation = await LeaderboardService.getParticipation();
        if (currentReadId !== readId) return;
        set({ enabled: participation.enabled && !stillLeaving });
      } catch (error) {
        if (currentReadId !== readId) return;
        console.error("Reading leaderboard participation failed:", error);
        // A read that failed leaves participation unknown, so it has to fail
        // closed. Keeping the last answer would also let the leaderboard's 403
        // recovery re-read, fail, and immediately re-issue the same 403 forever.
        // The surface offers a Retry rather than a Join, which would ask an
        // account that may already be on a leaderboard to join it again.
        set({ enabled: false, error: "read" });
      } finally {
        if (currentReadId === readId) set({ ready: true });
      }
    },

    join: async (userId) => {
      set({ updating: true });
      // The account says yes here, which retires any leave still queued for it —
      // before the request goes out, not after it lands, because turning the sync
      // toggle on re-reads participation and that read would flush the queued
      // leave into a PATCH racing this join. A join that then fails leaves it
      // retired too: re-arming would take the user off a board they just asked to
      // join. A declined opt-in never reaches here, so its leave is never touched.
      if (userId) clearPendingLeaderboardLeave(userId);
      try {
        const participation = await LeaderboardService.setParticipation(true);
        get().publishAnswer(participation.enabled);
      } catch (error) {
        console.error("Joining the leaderboard failed:", error);
        set({ error: "write" });
      } finally {
        set({ updating: false });
      }
    },

    leave: async (userId) => {
      set({ updating: true });
      try {
        const participation = await LeaderboardService.setParticipation(false);
        if (userId) clearPendingLeaderboardLeave(userId);
        get().publishAnswer(participation.enabled);
        return true;
      } catch (error) {
        console.error("Leaving the leaderboard failed:", error);
        // The opt-out is kept and retried until the account takes it, so this
        // device stops showing the user as participating straight away rather
        // than asking them to remember to try again.
        if (userId) writePendingLeaderboardLeave(userId);
        get().publishAnswer(false);
        return false;
      } finally {
        set({ updating: false });
      }
    },
  })
);
