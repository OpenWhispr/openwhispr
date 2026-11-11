import logger from "../utils/logger";
import { publishWorkspaceScope, useWorkspaceStore } from "./workspaceStore";

/**
 * Keeps main's workspace scope in step with this window's workspace store: on start, whenever
 * the active or default workspace, the list's account or whether the active pick is provisional
 * changes, and after every account change in main. Main starts a launch from the account's saved scope (a login launch may never open
 * this window) and forgets the scope on an account change in a running session, as this store
 * does (D43). Once the default workspace is known, main binds the account's pending Private to
 * it, again after each account change.
 *
 * The sign-in claim of signed-out notes isn't sent from here: main runs it inside
 * set-active-account-scope, the one moment such notes become the account's, and a later call
 * would find nothing left.
 *
 * One window runs this (the control panel, which owns the workspace choice); a second one with
 * a store that hasn't loaded its list would send main an empty scope.
 */
export function startWorkspaceScopeBridge(): () => void {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.setActiveWorkspaceScope) return () => {};
  let stopped = false;
  // The account and default main last bound. Main keeps the bind across launches, but a pending
  // Private made since (a sign-in claim, a note saved before the list loaded) needs another.
  let bound: string | null = null;
  let mainAccountId: string | null | undefined;
  let queued = false;
  let queue: Promise<void> = Promise.resolve();

  // One send at a time, in order, each reading the store when it runs: a bind or a scope never
  // overtakes the one before it, and a burst of changes sends the last state once.
  const sync = (): void => {
    if (queued) return;
    queued = true;
    queue = queue.then(async () => {
      queued = false;
      if (stopped) return;
      try {
        if (!(await publishWorkspaceScope())) return;
        const { defaultWorkspaceId, listAccountId } = useWorkspaceStore.getState();
        if (!defaultWorkspaceId || !listAccountId) return;
        const key = `${listAccountId}\n${defaultWorkspaceId}`;
        if (key === bound) return;
        const result = await api.bindDefaultPrivateSpace?.(defaultWorkspaceId, listAccountId);
        if (result?.success) bound = key;
      } catch (error) {
        logger.warn(
          "Failed to bind the default workspace's private notes",
          { error: (error as Error).message },
          "workspaces"
        );
      }
    });
  };

  const unsubscribeStore = useWorkspaceStore.subscribe((state, previous) => {
    if (
      state.activeWorkspaceId !== previous.activeWorkspaceId ||
      state.activeWorkspaceProvisional !== previous.activeWorkspaceProvisional ||
      state.defaultWorkspaceId !== previous.defaultWorkspaceId ||
      state.listAccountId !== previous.listAccountId
    ) {
      sync();
    }
  });
  // Sent on every change of main's account scope, a token rotation included, since resending
  // is harmless; the bind is repeated only when the account itself changed.
  const unsubscribeAccount = api.onDatabaseAccountScopeChanged?.((scope) => {
    if (scope.accountId !== mainAccountId) {
      mainAccountId = scope.accountId;
      bound = null;
    }
    sync();
  });
  sync();

  return () => {
    stopped = true;
    unsubscribeStore();
    unsubscribeAccount?.();
  };
}
