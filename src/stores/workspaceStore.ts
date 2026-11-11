import { create } from "zustand";
import type { SpaceItem, Workspace, WorkspaceMember } from "../types/electron";
import { WorkspacesService } from "../services/WorkspacesService";
import logger from "../utils/logger";
import { usePolicyStore } from "./policyStore";
import { useEnterpriseIdentityStore } from "./enterpriseIdentityStore";
import {
  defaultActiveWorkspaceId,
  isOwnDefault,
  resolveDefaultWorkspaceId,
  withDefaultFirst,
} from "../lib/workspaceSwitcher";

interface WorkspaceState {
  workspaces: Workspace[];
  loaded: boolean;
  loading: boolean;
  error: boolean;
  activeWorkspaceId: string | null;
  /**
   * The active workspace is the app's pick from a list without the account's own default
   * (ACTIVE_WORKSPACE_SOURCE_KEY). Main hears no active workspace meanwhile (publishWorkspaceScope).
   */
  activeWorkspaceProvisional: boolean;
  /** The account's default workspace (see resolveDefaultWorkspaceId), from the list shown. */
  defaultWorkspaceId: string | null;
  /**
   * The account the list shown belongs to: null until a list (or this account's cache) lands.
   * Calls to main carry it, so one made for an account that has since signed out is refused.
   */
  listAccountId: string | null;
  members: WorkspaceMember[];
  /**
   * The workspace `members` belongs to. A reader that shows one workspace reads the roster through
   * `rosterFor`, so a list answered for another workspace never shows as this one's.
   */
  membersWorkspaceId: string | null;

  /** The user's choice: the switcher, a link, opening something of another workspace. */
  setActiveWorkspaceId: (id: string | null) => void;
  /**
   * Drops a workspace the user just left or deleted, so a failed refresh can't show it again, and
   * moves the active workspace off it.
   */
  forgetWorkspace: (id: string) => void;
  resetForAccountChange: () => void;
  /**
   * Joins the request in flight, if any. `fresh` is for callers that just changed the list on the
   * server: an answer to a request sent before that change is dropped, and a new one is sent.
   */
  refresh: (options?: { fresh?: boolean }) => Promise<void>;
  createWorkspace: (name: string) => Promise<Workspace>;
  refreshMembers: (workspaceId: string) => Promise<void>;
}

// Shared by every window of this origin; the dictation window mirrors it (lib/accountScopeMirror).
export const ACTIVE_WORKSPACE_KEY = "activeWorkspaceId";

// The workspace every window uses right now. A window's store follows it
// through storage events, which arrive a task later; work that must not run for
// a workspace another window just left reads this instead.
export function readActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_WORKSPACE_KEY);
}

// Where builds with a Personal switcher entry saved that choice. The default workspace replaced
// Personal, so the next list read turns a saved Personal into the default workspace.
const LEGACY_PERSONAL_SELECTED_KEY = "workspacePersonalSelected";

function readLegacyPersonalChoice(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(LEGACY_PERSONAL_SELECTED_KEY) === "true";
}

function dropLegacyPersonalChoice(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(LEGACY_PERSONAL_SELECTED_KEY);
}

// Who picked the saved active workspace:
// - "user": the user (the switcher, a link, opening something of it);
// - "auto": the app (`defaultActiveWorkspaceId`), from a list holding the account's own default;
// - "provisional": the app, from a list without it (a first sign-in reads the list before the
//   server makes the default). Only this one yields to the default, in whichever session first
//   lists it, and then settles (D45, D46).
// An id saved by a build that recorded no source counts as the user's, so an update moves nobody.
export const ACTIVE_WORKSPACE_SOURCE_KEY = "activeWorkspaceSource";
type ActiveWorkspaceSource = "user" | "auto" | "provisional";

function readActiveWorkspaceSource(): ActiveWorkspaceSource | null {
  if (typeof window === "undefined") return null;
  const source = localStorage.getItem(ACTIVE_WORKSPACE_SOURCE_KEY);
  return source === "user" || source === "auto" || source === "provisional" ? source : null;
}

/** The source the app's own pick from `workspaces` is saved with. */
function autoPickSource(workspaces: Workspace[]): ActiveWorkspaceSource {
  return workspaces.some(isOwnDefault) ? "auto" : "provisional";
}

function clearActiveWorkspaceChoice(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  localStorage.removeItem(ACTIVE_WORKSPACE_SOURCE_KEY);
}

function writeActiveWorkspaceId(id: string | null, source: ActiveWorkspaceSource): void {
  if (typeof window === "undefined") return;
  if (!id) {
    clearActiveWorkspaceChoice();
    return;
  }
  localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
  localStorage.setItem(ACTIVE_WORKSPACE_SOURCE_KEY, source);
}

/**
 * The user opened something of the active workspace: the app's pick becomes their choice, so the
 * account's default showing up later doesn't take them out of what they opened (D45, D21).
 */
export function adoptActiveWorkspaceChoice(workspaceId: string): void {
  if (readActiveWorkspaceId() !== workspaceId) return;
  const source = readActiveWorkspaceSource();
  if (source !== "auto" && source !== "provisional") return;
  localStorage.setItem(ACTIVE_WORKSPACE_SOURCE_KEY, "user");
  if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
    useWorkspaceStore.setState({ activeWorkspaceProvisional: false });
  }
}

export interface ActiveWorkspaceYield {
  activeWorkspaceId: string | null;
  workspaces: Workspace[];
  defaultWorkspaceId: string | null;
}

// Registered by the note store (a callback, since it imports this store): whether the user's own
// open note or container would be hidden by the given scope.
let wouldHideUsersWork: ((next: ActiveWorkspaceYield) => boolean) | null = null;

/**
 * A provisional pick never yields to the default while that would hide what the user has open
 * (D46): it becomes their choice instead.
 */
export function setActiveWorkspaceYieldGuard(
  guard: ((next: ActiveWorkspaceYield) => boolean) | null
): void {
  wouldHideUsersWork = guard;
}

// Last successful workspace list, shown when a signed-in session can't load the list (the API
// is unreachable or the request fails). It is only read for the account that wrote it, and only
// while it is recent: the server still decides every action, but a list this old is likely wrong.
export const WORKSPACE_LIST_CACHE_KEY = "workspaceListCache";
const WORKSPACE_LIST_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function writeWorkspaceListCache(accountId: string | null, workspaces: Workspace[]): void {
  if (typeof window === "undefined" || !accountId) return;
  try {
    localStorage.setItem(
      WORKSPACE_LIST_CACHE_KEY,
      JSON.stringify({ accountId, fetchedAt: Date.now(), workspaces })
    );
  } catch {
    // Storage can be full or blocked; the cache is only a convenience.
  }
}

// `anyAge` is for finding lost workspaces: one listed then and missing now is lost however long ago
// that was, while a list this old is too stale to show.
function readWorkspaceListCache(
  accountId: string | null,
  { anyAge = false }: { anyAge?: boolean } = {}
): Workspace[] | null {
  if (typeof window === "undefined" || !accountId) return null;
  try {
    const raw = localStorage.getItem(WORKSPACE_LIST_CACHE_KEY);
    if (!raw) return null;
    const cached: unknown = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return null;
    const {
      accountId: cachedAccountId,
      fetchedAt,
      workspaces,
    } = cached as {
      accountId?: unknown;
      fetchedAt?: unknown;
      workspaces?: unknown;
    };
    if (cachedAccountId !== accountId || !Array.isArray(workspaces)) return null;
    if (
      !anyAge &&
      (typeof fetchedAt !== "number" || Date.now() - fetchedAt > WORKSPACE_LIST_CACHE_MAX_AGE_MS)
    ) {
      return null;
    }
    // A malformed entry would throw in later `.find(w => w.id …)` calls.
    const wellFormed = workspaces.every(
      (entry) => entry && typeof entry === "object" && typeof entry.id === "string"
    );
    return wellFormed ? (workspaces as Workspace[]) : null;
  } catch {
    return null;
  }
}

/**
 * The default workspace of the last list the signed-in account saw, for a window that loads no
 * list of its own (the dictation window). Null when there is no recent list, or it names none.
 */
export function readCachedDefaultWorkspaceId(): string | null {
  const cached = readWorkspaceListCache(usePolicyStore.getState().accountId);
  return cached ? resolveDefaultWorkspaceId(cached) : null;
}

// Keeps the entry's age: pruning one workspace is not a fresh read of the list.
function pruneWorkspaceListCache(accountId: string | null, workspaceId: string): void {
  const cached = readWorkspaceListCache(accountId);
  if (!cached || !cached.some((w) => w.id === workspaceId)) return;
  try {
    const { fetchedAt } = JSON.parse(localStorage.getItem(WORKSPACE_LIST_CACHE_KEY) ?? "{}") as {
      fetchedAt?: number;
    };
    localStorage.setItem(
      WORKSPACE_LIST_CACHE_KEY,
      JSON.stringify({
        accountId,
        fetchedAt,
        workspaces: cached.filter((w) => w.id !== workspaceId),
      })
    );
  } catch {
    // The cache is only a convenience; a stale entry ages out on its own.
  }
}

function clearWorkspaceListCache(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(WORKSPACE_LIST_CACHE_KEY);
  } catch {
    // Nothing to clear if storage is unreachable.
  }
}

let refreshPromise: Promise<void> | null = null;
// Bumped by a fresh refresh; a request sent under an older epoch answers for a list that changed.
let listEpoch = 0;
let refreshPromiseEpoch = 0;
let membersRequestSeq = 0;
// The latest member read. An overtaken read of the same workspace settles with it, so its caller
// doesn't move on before the roster it asked for has landed or failed.
let latestMembersRead: { seq: number; workspaceId: string; done: Promise<void> } | null = null;
let accountGeneration = 0;

function newerMembersRead(workspaceId: string, seq: number): Promise<void> | null {
  const latest = latestMembersRead;
  return latest && latest.seq > seq && latest.workspaceId === workspaceId ? latest.done : null;
}

/**
 * Managed enterprise config is keyed by account + workspace + auth generation, so it has to be
 * re-resolved whenever any of the three changes. Callers that already know the account identity
 * pass it in; the active workspace comes from this store.
 */
export function refreshManagedEnterpriseIdentity(
  accountId: string | null,
  authGeneration: number | null,
  workspaceId: string | null = useWorkspaceStore.getState().activeWorkspaceId
): void {
  const enterprise = useEnterpriseIdentityStore.getState();
  const clearOptions = accountId ? { next: { accountId, workspaceId } } : undefined;
  if (!workspaceId || !accountId || authGeneration == null) {
    enterprise.clear(clearOptions);
    return;
  }
  // refresh() drops the previous identity's config itself. clear() would also
  // delete main's disk cache, which is keyed by credential, account and
  // workspace, so the new identity could never fall back to it offline.
  void enterprise.refresh(accountId, workspaceId, authGeneration);
}

function refreshForWorkspace(workspaceId: string | null): void {
  const { accountId, authGeneration } = usePolicyStore.getState();
  refreshManagedEnterpriseIdentity(accountId, authGeneration, workspaceId);
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  loaded: false,
  loading: false,
  error: false,
  activeWorkspaceId: readActiveWorkspaceId(),
  activeWorkspaceProvisional: readActiveWorkspaceSource() === "provisional",
  defaultWorkspaceId: null,
  listAccountId: null,
  members: [],
  membersWorkspaceId: null,

  setActiveWorkspaceId: (id) => selectActiveWorkspace(id, "user"),

  forgetWorkspace: (id) => {
    // The Enterprise workspace that stood in as the default is gone: this session's answer that
    // the account gets no default of its own no longer holds.
    if (id === get().defaultWorkspaceId) askForDefaultAgain();
    const workspaces = get().workspaces.filter((w) => w.id !== id);
    const defaultWorkspaceId = resolveDefaultWorkspaceId(workspaces);
    set(
      get().membersWorkspaceId === id
        ? { workspaces, defaultWorkspaceId, members: [], membersWorkspaceId: null }
        : { workspaces, defaultWorkspaceId }
    );
    pruneWorkspaceListCache(usePolicyStore.getState().accountId, id);
    // Chosen now, not by the refresh that follows: a failed refresh keeps the old active id.
    if (get().activeWorkspaceId === id) {
      selectActiveWorkspace(defaultActiveWorkspaceId(workspaces), autoPickSource(workspaces));
    }
  },

  resetForAccountChange: () => {
    accountGeneration += 1;
    membersRequestSeq += 1;
    // Let the next account start its own request. The identity check in the
    // old request prevents its result/finally block from touching new state.
    refreshPromise = null;
    dropLegacyPersonalChoice();
    clearActiveWorkspaceChoice();
    clearWorkspaceListCache();
    useEnterpriseIdentityStore.getState().clear();
    set({
      workspaces: [],
      loaded: false,
      loading: false,
      error: false,
      activeWorkspaceId: null,
      activeWorkspaceProvisional: false,
      defaultWorkspaceId: null,
      listAccountId: null,
      members: [],
      membersWorkspaceId: null,
    });
  },

  refresh: ({ fresh = false } = {}) => {
    if (fresh) listEpoch += 1;
    if (refreshPromise && refreshPromiseEpoch === listEpoch) return refreshPromise;
    const generation = accountGeneration;
    const epoch = listEpoch;
    const superseded = (): boolean => generation !== accountGeneration || epoch !== listEpoch;
    set({ loading: true });
    let request!: Promise<void>;
    request = (async () => {
      let lost: string[] = [];
      // Set by a successful, non-empty answer once the default is known: main's private rows are
      // checked against it too.
      let rowCheck: { listed: Workspace[]; accountId: string; defaultWorkspaceId: string } | null =
        null;
      try {
        const answer = await WorkspacesService.list();
        if (superseded()) return;
        const accountId = usePolicyStore.getState().accountId;
        const previousDefaultId = get().defaultWorkspaceId;
        if (previousDefaultId && !answer.some((w) => w.id === previousDefaultId)) {
          askForDefaultAgain();
        }
        const defaultWorkspaceId = resolveDefaultWorkspaceId(answer);
        const workspaces = withDefaultFirst(answer, defaultWorkspaceId);
        // Workspaces this account had and no longer has. Only a successful answer counts, and
        // never an empty one: every account has a default workspace, so an empty list is a fault,
        // not the loss of everything.
        const previous =
          workspaces.length > 0 ? readWorkspaceListCache(accountId, { anyAge: true }) : null;
        lost = (previous ?? [])
          .map((w) => w.id)
          .filter((id) => !workspaces.some((w) => w.id === id));
        // Both choices come from storage: another window may have changed them a task before
        // this answer, ahead of its storage events. Memory only says what this window showed.
        const activeId = get().activeWorkspaceId;
        const savedActiveId = readActiveWorkspaceId();
        // A saved Personal choice ends with the first answer: it becomes the default workspace.
        const savedPersonal = readLegacyPersonalChoice();
        if (savedPersonal) dropLegacyPersonalChoice();
        const stillValid =
          !savedPersonal && savedActiveId && workspaces.some((w) => w.id === savedActiveId);
        let source = readActiveWorkspaceSource();
        let keepsSaved = Boolean(stillValid);
        // A provisional pick is made again once a list holds the account's own default (D45),
        // unless that would hide what the user has open: then it becomes their choice (D46).
        if (stillValid && source === "provisional" && workspaces.some(isOwnDefault)) {
          const next = defaultActiveWorkspaceId(workspaces);
          const keepsUsersWork =
            next !== savedActiveId &&
            wouldHideUsersWork?.({ activeWorkspaceId: next, workspaces, defaultWorkspaceId }) ===
              true;
          if (keepsUsersWork) {
            source = "user";
            localStorage.setItem(ACTIVE_WORKSPACE_SOURCE_KEY, source);
          } else {
            keepsSaved = false;
          }
        }
        const resolvedActiveId = keepsSaved ? savedActiveId : defaultActiveWorkspaceId(workspaces);
        const activeChanged = resolvedActiveId !== activeId;
        if (activeChanged) membersRequestSeq++;
        // Written before the state changes, as setActiveWorkspaceId does: the
        // subscribers publish for the workspace localStorage names. Rewriting the same id
        // fires no storage event in the other windows.
        if (!keepsSaved) {
          source = autoPickSource(workspaces);
          writeActiveWorkspaceId(resolvedActiveId, source);
        }
        set({
          workspaces,
          loaded: true,
          loading: false,
          error: false,
          activeWorkspaceId: resolvedActiveId,
          activeWorkspaceProvisional: resolvedActiveId != null && source === "provisional",
          defaultWorkspaceId,
          listAccountId: accountId,
          ...(activeChanged ? { members: [], membersWorkspaceId: null } : {}),
        });
        if (workspaces.length > 0) writeWorkspaceListCache(accountId, workspaces);
        if (workspaces.length > 0 && accountId && defaultWorkspaceId) {
          rowCheck = { listed: workspaces, accountId, defaultWorkspaceId };
        }
        refreshForWorkspace(resolvedActiveId);
      } catch (error) {
        if (superseded()) return;
        logger.error(
          "Failed to load workspaces",
          { error: (error as Error).message },
          "workspaces"
        );
        // Nothing in memory: show the last list this account saw. `error` stays true so the
        // reconnect retry replaces it with the server's answer and the UI marks it out of date.
        const accountId = usePolicyStore.getState().accountId;
        const cached = get().workspaces.length === 0 ? readWorkspaceListCache(accountId) : null;
        const cachedDefaultId = cached ? resolveDefaultWorkspaceId(cached) : null;
        set({
          ...(cached
            ? {
                workspaces: withDefaultFirst(cached, cachedDefaultId),
                defaultWorkspaceId: cachedDefaultId,
                listAccountId: accountId,
              }
            : {}),
          loading: false,
          loaded: true,
          error: true,
        });
      } finally {
        if (refreshPromise === request) refreshPromise = null;
      }
      // After the new list is in place, so main is told its active workspace first. Not skipped
      // for a newer request: the cache already holds this list, so no later answer would find
      // these missing (main's rows would, on the next list). Main refuses the move if another
      // account has signed in since.
      const orphaned = rowCheck ? await orphanedPrivateWorkspaces(rowCheck) : [];
      const toRelocate = [...new Set([...lost, ...orphaned])];
      if (toRelocate.length > 0) await relocateLostWorkspaces(toRelocate);
    })();
    refreshPromise = request;
    refreshPromiseEpoch = epoch;
    return request;
  },

  createWorkspace: async (name) => {
    const generation = accountGeneration;
    const workspace = await WorkspacesService.create(name);
    if (generation === accountGeneration) {
      set((s) => ({ workspaces: [...s.workspaces, workspace] }));
      // A list request sent before the create would answer without it and drop it again.
      if (refreshPromise) void get().refresh({ fresh: true });
    }
    return workspace;
  },

  refreshMembers: (workspaceId) => {
    const seq = ++membersRequestSeq;
    const done = (async (): Promise<void> => {
      let members: WorkspaceMember[];
      try {
        members = await WorkspacesService.listMembers(workspaceId);
      } catch (error) {
        const newer = newerMembersRead(workspaceId, seq);
        if (newer) return newer;
        logger.error(
          "Failed to load workspace members",
          { error: (error as Error).message },
          "workspaces"
        );
        throw error;
      }
      if (seq === membersRequestSeq) {
        set({ members, membersWorkspaceId: workspaceId });
        return;
      }
      // Overtaken: by another workspace's read or a switch, this answer is discarded; by a newer
      // read of this workspace, that read's answer is this caller's too.
      await newerMembersRead(workspaceId, seq);
    })();
    latestMembersRead = { seq, workspaceId, done };
    return done;
  },
}));

function selectActiveWorkspace(id: string | null, source: ActiveWorkspaceSource): void {
  // A choice made before the first list read outranks a Personal choice it hasn't turned
  // into the default yet.
  dropLegacyPersonalChoice();
  writeActiveWorkspaceId(id, source);
  // Invalidate in-flight member fetches so the old workspace's roster can't
  // land under the new one.
  membersRequestSeq++;
  useWorkspaceStore.setState({
    activeWorkspaceId: id,
    activeWorkspaceProvisional: id != null && source === "provisional",
    members: [],
    membersWorkspaceId: null,
  });
  refreshForWorkspace(id);
}

export interface PublishedWorkspaceScope {
  activeWorkspaceId: string | null;
  defaultWorkspaceId: string | null;
  accountId: string | null;
}

const scopePublishedListeners = new Set<(scope: PublishedWorkspaceScope) => void>();

/**
 * Called each time main takes a scope this window sent. Main makes the active workspace's Private
 * when it next reads the spaces, so a reader of them reads again to see it.
 */
export function onWorkspaceScopePublished(
  listener: (scope: PublishedWorkspaceScope) => void
): () => void {
  scopePublishedListeners.add(listener);
  return () => {
    scopePublishedListeners.delete(listener);
  };
}

/**
 * Tells main the active and default workspace, so new private notes go to the active workspace's
 * Private and existing ones to the default's. Named for the account whose list chose them: main
 * refuses a scope that arrives after another account signed in. True once main took it.
 */
export async function publishWorkspaceScope(): Promise<boolean> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.setActiveWorkspaceScope) return false;
  const { activeWorkspaceId, activeWorkspaceProvisional, defaultWorkspaceId, listAccountId } =
    useWorkspaceStore.getState();
  // A provisional pick isn't final (D46): main files unattended notes into the default's Private
  // (the pending row the bind folds into it) and saves no scope for launch that names the pick.
  // One that is the default (an Enterprise workspace standing in) is published as is: main files
  // into it either way, and it still scopes main's teamspaces.
  const scope = {
    activeWorkspaceId:
      activeWorkspaceProvisional && activeWorkspaceId !== defaultWorkspaceId
        ? null
        : activeWorkspaceId,
    defaultWorkspaceId,
    accountId: listAccountId,
  };
  try {
    const result = await api.setActiveWorkspaceScope(scope);
    if (result?.success !== true) return false;
    for (const listener of scopePublishedListeners) {
      try {
        listener(scope);
      } catch (error) {
        logger.warn(
          "A workspace scope listener failed",
          { error: (error as Error).message },
          "workspaces"
        );
      }
    }
    return true;
  } catch (error) {
    logger.warn(
      "Failed to send the workspace scope",
      { error: (error as Error).message },
      "workspaces"
    );
    return false;
  }
}

/**
 * Workspaces this account keeps a Private for in main that the list no longer has. The cached
 * list can't find them all: signing out or another account's sign-in clears it, and a move that
 * failed is gone from it by the next answer. The default's own row never counts.
 */
async function orphanedPrivateWorkspaces({
  listed,
  accountId,
  defaultWorkspaceId,
}: {
  listed: Workspace[];
  accountId: string;
  defaultWorkspaceId: string;
}): Promise<string[]> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.getSpaces) return [];
  // Reading the spaces makes the active workspace's Private when it has none, so main has to
  // hear which workspace is active first. A refused scope means another account signed in.
  if (!(await publishWorkspaceScope())) return [];
  let spaces: SpaceItem[];
  try {
    // Bound first, whatever the bridge has sent: a Private that was the default until now (an
    // Enterprise workspace that stood in) keeps its mark until then, and main never moves one.
    const bound = await api.bindDefaultPrivateSpace?.(defaultWorkspaceId, accountId);
    if (bound && !bound.success) return [];
    spaces = await api.getSpaces();
  } catch (error) {
    logger.warn(
      "Failed to read private spaces for lost workspaces",
      { error: (error as Error).message },
      "workspaces"
    );
    return [];
  }
  const orphaned = new Set<string>();
  for (const space of spaces) {
    const workspaceId = space.workspace_id;
    if (space.kind !== "private" || space.account_id !== accountId || !workspaceId) continue;
    if (workspaceId === defaultWorkspaceId || space.is_default_private) continue;
    if (!listed.some((w) => w.id === workspaceId)) orphaned.add(workspaceId);
  }
  return [...orphaned];
}

/**
 * Moves the Private of workspaces the account lost (left, deleted, or missing from a successful
 * list) into the default workspace's, on this device. Main must hear the new active workspace
 * first: while it still names a lost one, the next read of the spaces makes that workspace a new,
 * empty Private.
 */
export async function relocateLostWorkspaces(workspaceIds: string[]): Promise<void> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.relocatePrivateSpace) return;
  const store = useWorkspaceStore.getState();
  const accountId = store.listAccountId;
  // With no list of its own, the store can't say whose workspaces these are.
  if (!accountId) return;
  // Everything lost lands in the default's Private, which never moves itself.
  const lost = workspaceIds.filter((id) => id !== store.defaultWorkspaceId);
  if (lost.length === 0) return;
  if (store.activeWorkspaceId && lost.includes(store.activeWorkspaceId)) {
    const remaining = store.workspaces.filter((w) => !lost.includes(w.id));
    selectActiveWorkspace(defaultActiveWorkspaceId(remaining), autoPickSource(remaining));
  }
  // A scope main refused (another account signed in) or never got means nothing moves.
  if (!(await publishWorkspaceScope())) return;
  for (const workspaceId of lost) {
    try {
      const result = await api.relocatePrivateSpace(workspaceId, null, accountId);
      if (result?.success) continue;
      logger.warn(
        "Main did not relocate a lost workspace's private notes",
        { workspaceId, code: result?.code },
        "workspaces"
      );
      if (result?.code === "ACCOUNT_CHANGED" || result?.code === "SIGNED_OUT") return;
    } catch (error) {
      logger.error(
        "Failed to relocate a lost workspace's private notes",
        { workspaceId, error: (error as Error).message },
        "workspaces"
      );
    }
  }
}

let defaultEnsuredGeneration: number | null = null;
// Bumped when the session's answer stops holding; an answer to a request sent before then is
// not taken as the session's.
let defaultEnsureEpoch = 0;
let defaultEnsureRequest: { generation: number; epoch: number; promise: Promise<void> } | null =
  null;

function askForDefaultAgain(): void {
  defaultEnsureEpoch += 1;
  defaultEnsuredGeneration = null;
}

/**
 * Has the server make the account's default workspace (`name` is used the first time only),
 * then reads the list again so it shows. Asked once per account session; a failure is asked
 * again on the next call, and so is an answer that no longer holds (the Enterprise workspace
 * that stood in as the default is gone). `again` asks even after an answer, for Retry, and
 * then reads the list again whatever the answer: with no default made (enterprise_managed) or
 * a failed request, a fresh list is what can still show one.
 */
export function ensureDefaultWorkspace(
  name: string,
  { again = false }: { again?: boolean } = {}
): Promise<void> {
  if (again) askForDefaultAgain();
  const generation = accountGeneration;
  const epoch = defaultEnsureEpoch;
  if (defaultEnsuredGeneration === generation) return Promise.resolve();
  if (defaultEnsureRequest?.generation === generation && defaultEnsureRequest.epoch === epoch) {
    return defaultEnsureRequest.promise;
  }
  let request!: Promise<void>;
  request = (async () => {
    let listRead = false;
    try {
      const workspace = await WorkspacesService.ensureDefault(name);
      if (generation !== accountGeneration) return;
      if (epoch === defaultEnsureEpoch) defaultEnsuredGeneration = generation;
      // An Enterprise member gets none: their Enterprise workspace stays the default.
      const listed =
        !workspace ||
        useWorkspaceStore
          .getState()
          .workspaces.some((w) => w.id === workspace.id && w.is_default === true);
      if (!listed) {
        listRead = true;
        await useWorkspaceStore.getState().refresh({ fresh: true });
      }
    } catch (error) {
      logger.warn(
        "Failed to ensure the default workspace",
        { error: (error as Error).message },
        "workspaces"
      );
    } finally {
      if (defaultEnsureRequest?.promise === request) defaultEnsureRequest = null;
    }
    if (again && !listRead && generation === accountGeneration) {
      try {
        await useWorkspaceStore.getState().refresh({ fresh: true });
      } catch (error) {
        logger.warn(
          "Failed to read the workspaces again",
          { error: (error as Error).message },
          "workspaces"
        );
      }
    }
  })();
  defaultEnsureRequest = { generation, epoch, promise: request };
  return request;
}

// Another window switched, auto-selected or cleared the workspace: follow it,
// or this window keeps dictating, syncing and publishing shared words for the
// old one. Nothing is written back, and the managed enterprise identity is
// left to the window's own refresh (the dictation window re-resolves it in
// accountScopeMirror on this same event).
export function handleActiveWorkspaceStorage(event: StorageEvent): void {
  if (event.key === ACTIVE_WORKSPACE_SOURCE_KEY) {
    const provisional = readActiveWorkspaceSource() === "provisional";
    if (provisional !== useWorkspaceStore.getState().activeWorkspaceProvisional) {
      useWorkspaceStore.setState({ activeWorkspaceProvisional: provisional });
    }
    return;
  }
  if (event.key !== ACTIVE_WORKSPACE_KEY) return;
  const id = event.newValue;
  if (id === useWorkspaceStore.getState().activeWorkspaceId) return;
  // The old workspace's roster must not land under the new one.
  membersRequestSeq++;
  useWorkspaceStore.setState({
    activeWorkspaceId: id,
    activeWorkspaceProvisional: id != null && readActiveWorkspaceSource() === "provisional",
    members: [],
    membersWorkspaceId: null,
  });
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", handleActiveWorkspaceStorage);
}
