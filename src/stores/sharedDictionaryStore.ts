import { create } from "zustand";
import type { SharedDictionarySnapshot } from "../types/sharedDictionary";
import { EMPTY_SHARED_HINTS, selectSharedHintWords } from "../utils/sharedDictionaryHints";
import logger from "../utils/logger";
import { useSettingsStore } from "./settingsStore";
import { useWorkspaceStore } from "./workspaceStore";

export type ListKey = "all" | "personal" | "allShared" | "workspace" | `space:${string}` | "hidden";

// ssoRequired and noAccess describe the active workspace: its last pass was
// refused for company SSO, or the member can no longer read its lists.
export type SharedDictionaryStatus = "unavailable" | "ready" | "ssoRequired" | "noAccess";

type AccessStatus = Extract<SharedDictionaryStatus, "ssoRequired" | "noAccess">;

// "false" once the API answered the shared dictionary routes with a plain 404
// (not deployed yet); any successful pass writes "true".
export const SHARED_DICTIONARY_CAPABILITY_KEY = "sharedDictionaryCapability";
// { [workspaceId]: status } of each workspace's last refused pass, until a
// pass for it succeeds. Shared by every window (see the storage listener below).
export const SHARED_DICTIONARY_ACCESS_KEY = "sharedDictionaryAccess";

// sharedDictionaryWelcomed.<account>.<workspace>: the arrival toast shows once
// per account and workspace on each device, so sign-out keeps these.
const SHARED_DICTIONARY_WELCOMED_PREFIX = "sharedDictionaryWelcomed.";
// { accountId, workspaceId, count } of an arrival no control panel has shown
// yet: passes often run while it's hidden in the tray, or before it opens.
export const SHARED_DICTIONARY_PENDING_ARRIVAL_KEY = "sharedDictionaryPendingArrival";

export interface SharedDictionaryArrival {
  accountId: string;
  workspaceId: string;
  count: number;
}

const welcomedKey = (accountId: string, workspaceId: string): string =>
  `${SHARED_DICTIONARY_WELCOMED_PREFIX}${accountId}.${workspaceId}`;

function isArrival(value: unknown): value is SharedDictionaryArrival {
  const arrival = value as Partial<SharedDictionaryArrival> | null;
  return (
    typeof arrival?.accountId === "string" &&
    typeof arrival.workspaceId === "string" &&
    typeof arrival.count === "number" &&
    arrival.count > 0
  );
}

export function hasWelcomedSharedDictionary(accountId: string, workspaceId: string): boolean {
  return localStorage.getItem(welcomedKey(accountId, workspaceId)) != null;
}

// Kept until a control panel shows it; a newer arrival replaces it.
export function recordSharedDictionaryArrival(arrival: SharedDictionaryArrival): void {
  if (hasWelcomedSharedDictionary(arrival.accountId, arrival.workspaceId)) return;
  try {
    localStorage.setItem(SHARED_DICTIONARY_PENDING_ARRIVAL_KEY, JSON.stringify(arrival));
  } catch {
    // Quota: this arrival goes untold.
  }
}

/**
 * The pending arrival, for the account and workspace this window shows, once:
 * it is marked welcomed as it is taken, so no other window (or a later launch)
 * shows it again. One for another account or workspace is dropped; with no
 * account resolved yet it waits.
 */
export function takeSharedDictionaryArrival(
  accountId: string | null,
  workspaceId: string | null
): SharedDictionaryArrival | null {
  const raw = localStorage.getItem(SHARED_DICTIONARY_PENDING_ARRIVAL_KEY);
  if (raw === null) return null;
  let arrival: unknown = null;
  try {
    arrival = JSON.parse(raw);
  } catch {
    // Dropped below.
  }
  if (isArrival(arrival) && !accountId) return null;
  localStorage.removeItem(SHARED_DICTIONARY_PENDING_ARRIVAL_KEY);
  if (
    !isArrival(arrival) ||
    arrival.accountId !== accountId ||
    arrival.workspaceId !== workspaceId ||
    hasWelcomedSharedDictionary(arrival.accountId, arrival.workspaceId)
  ) {
    return null;
  }
  try {
    localStorage.setItem(welcomedKey(arrival.accountId, arrival.workspaceId), "true");
  } catch {
    // Shown anyway.
  }
  return arrival;
}

const isAccessStatus = (status: unknown): status is AccessStatus =>
  status === "ssoRequired" || status === "noAccess";

interface SharedDictionaryState {
  workspaceId: string | null;
  status: SharedDictionaryStatus;
  snapshot: SharedDictionarySnapshot | null;
  syncing: boolean;
  // The later of the shared lists' last pass and the page's last Sync, which
  // also syncs the personal dictionary (the only work it does without a workspace).
  lastSyncedAt: string | null;
  // Set by the arrival toast's "View words".
  requestedList: ListKey | null;
  // Personal words whose row was shared into a team list.
  movedPersonal: string[];
  // Bumped on every account or active-workspace change; work started under an
  // older generation never publishes.
  generation: number;
  load: (workspaceId: string | null, generation: number) => Promise<void>;
  reload: () => Promise<void>;
  handleScopeChange: (workspaceId: string | null) => void;
  resetForAccountChange: () => void;
  setRequestedList: (list: ListKey | null) => void;
  // `workspaceId` is the workspace the pass ran for; the current one by default.
  setStatus: (status: SharedDictionaryStatus, workspaceId?: string | null) => void;
  setSyncing: (syncing: boolean) => void;
  // A Sync started under `generation` finished; ignored after an account or workspace change.
  markSynced: (generation: number) => void;
}

const laterOf = (left: string | null, right: string | null): string | null =>
  left === null || (right !== null && Date.parse(right) > Date.parse(left)) ? right : left;

function readAccessMap(): Record<string, AccessStatus> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SHARED_DICTIONARY_ACCESS_KEY) ?? "{}");
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter((entry): entry is [string, AccessStatus] =>
        isAccessStatus(entry[1])
      )
    );
  } catch {
    return {};
  }
}

function writeAccessStatus(workspaceId: string, status: AccessStatus | null): void {
  const map = readAccessMap();
  if (status) map[workspaceId] = status;
  else delete map[workspaceId];
  if (Object.keys(map).length === 0) localStorage.removeItem(SHARED_DICTIONARY_ACCESS_KEY);
  else localStorage.setItem(SHARED_DICTIONARY_ACCESS_KEY, JSON.stringify(map));
}

function readAccessStatus(workspaceId: string | null): AccessStatus | null {
  if (!workspaceId || typeof localStorage === "undefined") return null;
  return readAccessMap()[workspaceId] ?? null;
}

function readStatus(workspaceId: string | null): SharedDictionaryStatus {
  if (typeof localStorage === "undefined") return "ready";
  if (localStorage.getItem(SHARED_DICTIONARY_CAPABILITY_KEY) === "false") return "unavailable";
  return readAccessStatus(workspaceId) ?? "ready";
}

export const useSharedDictionaryStore = create<SharedDictionaryState>((set, get) => {
  const isCurrent = (workspaceId: string | null, generation: number): boolean =>
    get().generation === generation && get().workspaceId === workspaceId;

  return {
    workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
    status: readStatus(useWorkspaceStore.getState().activeWorkspaceId),
    snapshot: null,
    syncing: false,
    lastSyncedAt: null,
    requestedList: null,
    movedPersonal: [],
    generation: 0,

    load: async (workspaceId, generation) => {
      if (!workspaceId) {
        if (!isCurrent(workspaceId, generation)) return;
        set({ snapshot: null, movedPersonal: [] });
        useSettingsStore.getState().setSharedDictionaryHints(EMPTY_SHARED_HINTS, null);
        return;
      }
      const api = window.electronAPI;
      let snapshot: SharedDictionarySnapshot | undefined;
      let movedPersonal: string[] | undefined;
      try {
        [snapshot, movedPersonal] = await Promise.all([
          api?.getSharedDictionary?.(workspaceId),
          api?.getMovedDictionaryWords?.(),
        ]);
      } catch (error) {
        logger.warn(
          "Failed to load the shared dictionary",
          { error: (error as Error)?.message },
          "dictionary"
        );
        return;
      }
      if (!snapshot || !isCurrent(workspaceId, generation)) return;
      set({
        snapshot,
        movedPersonal: movedPersonal ?? [],
        lastSyncedAt: laterOf(get().lastSyncedAt, snapshot.meta?.syncedAt ?? null),
      });
      useSettingsStore
        .getState()
        .setSharedDictionaryHints(
          selectSharedHintWords(snapshot, movedPersonal ?? []),
          workspaceId
        );
    },

    reload: () => get().load(get().workspaceId, get().generation),

    handleScopeChange: (workspaceId) => {
      const generation = get().generation + 1;
      const { status } = get();
      set({
        workspaceId,
        generation,
        // An access status belongs to the workspace it was refused for.
        status: status === "unavailable" ? status : (readAccessStatus(workspaceId) ?? "ready"),
        snapshot: null,
        movedPersonal: [],
        lastSyncedAt: null,
        requestedList: null,
        syncing: false,
      });
      // Emptied before the load so the old workspace's words never reach a
      // dictation that starts in between; this also resends them to main.
      useSettingsStore.getState().setSharedDictionaryHints(EMPTY_SHARED_HINTS, workspaceId);
      void get().load(workspaceId, generation);
    },

    // The tables and cursors are cleared by the caller (SyncService). The
    // workspace stays whatever workspaceStore holds, so a load for it after
    // the reset still publishes.
    resetForAccountChange: () => {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(SHARED_DICTIONARY_ACCESS_KEY);
      }
      set((state) => ({
        generation: state.generation + 1,
        status: "ready",
        snapshot: null,
        movedPersonal: [],
        lastSyncedAt: null,
        requestedList: null,
        syncing: false,
      }));
      useSettingsStore.getState().setSharedDictionaryHints(EMPTY_SHARED_HINTS, null);
    },

    setRequestedList: (requestedList) => set({ requestedList }),

    setStatus: (status, workspaceId = get().workspaceId) => {
      const isCurrentWorkspace = workspaceId === get().workspaceId;
      if (typeof localStorage === "undefined") {
        if (isCurrentWorkspace) set({ status });
        return;
      }
      try {
        localStorage.setItem(
          SHARED_DICTIONARY_CAPABILITY_KEY,
          status === "unavailable" ? "false" : "true"
        );
        if (workspaceId && status !== "unavailable") {
          writeAccessStatus(workspaceId, isAccessStatus(status) ? status : null);
        }
      } catch {
        // The status still applies for this session.
      }
      // A pass for a workspace this window has left still says whether the
      // routes exist, but its access says nothing about the current one's.
      set({ status: isCurrentWorkspace ? status : readStatus(get().workspaceId) });
    },

    setSyncing: (syncing) => set({ syncing }),

    markSynced: (generation) => {
      if (get().generation === generation) set({ lastSyncedAt: new Date().toISOString() });
    },
  };
});

// A pass in another window (often the dictation overlay) wrote a status:
// follow it for this window's workspace.
export function handleSharedDictionaryStatusStorage(event: StorageEvent): void {
  if (
    event.key !== SHARED_DICTIONARY_ACCESS_KEY &&
    event.key !== SHARED_DICTIONARY_CAPABILITY_KEY
  ) {
    return;
  }
  const state = useSharedDictionaryStore.getState();
  const status = readStatus(state.workspaceId);
  if (status !== state.status) useSharedDictionaryStore.setState({ status });
}

// Registered once for the window's lifetime, like the store itself.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", handleSharedDictionaryStatusStorage);
}

// Every change of the active workspace (setActiveWorkspaceId, refresh()'s
// auto-select and clear, resetForAccountChange) switches the shared lists.
useWorkspaceStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId !== previous.activeWorkspaceId) {
    useSharedDictionaryStore.getState().handleScopeChange(state.activeWorkspaceId);
  }
});
