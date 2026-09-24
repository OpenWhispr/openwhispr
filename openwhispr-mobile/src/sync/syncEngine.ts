import { clearPrivateNoteDeletionQueue, pushPrivateNoteDeletes } from './privateNoteDeletion';
import { createSyncContext } from './createSyncContext';
import { SyncCancelledError, type SyncCheckpoint } from './syncContext';
import * as Sentry from '@sentry/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useNotesStore } from '@/store/useNotesStore';
import { notesRepository } from '@/data';
import { fetchUsage } from '@/data/remote/usageApi';
import { pullFolders } from './pullFolders';
import { pullFoldersTeam } from './pullFoldersTeam';
import { pullNotes } from './pullNotes';
import { pullNotesTeam } from './pullNotesTeam';
import { pushFolders } from './pushFolders';
import { pushNotes } from './pushNotes';
import { pullDictionary } from './pullDictionary';
import { pushDictionary } from './pushDictionary';
import { pullSnippets } from './pullSnippets';
import { pushSnippets } from './pushSnippets';
import { syncSpaces, type SyncSpacesResult } from './syncSpaces';
import { useDictionaryStore } from '@/store/useDictionaryStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';
import { runInitialBackfillIfNeeded } from './initialBackfill';
import { resetAllPullCursors } from './pullCursors';
import {
  clearAnonymousLink,
  getLastSyncedUserId,
  isLinkFromAnonymous,
  recordAnonymousUser,
  setLastSyncedUserId,
} from './syncIdentity';
import { useSyncStore } from './useSyncStore';
import { ApiError, isPolicyCloudBackupBlockedError } from '@/lib/apiClient';

export type SyncReason = 'after-write' | 'foreground' | 'sign-in' | 'manual';

let inFlight = false;
let pendingTrigger: SyncReason | null = null;
let postWriteTimer: ReturnType<typeof setTimeout> | null = null;

// The snippets endpoints (/api/snippets/*) may not be deployed yet on the
// backend. A missing route returns 404/405; treat that as "endpoint unavailable"
// and skip snippet sync for the rest of the session (resets on next launch) so a
// not-yet-shipped API doesn't spam Sentry with caught 404s on every sync. Pull
// runs before push, so a missing endpoint trips here before push can mistake the
// 404 for a terminal per-row rejection. Mirrors fusedCleanupEndpointUnavailable.
let snippetsEndpointUnavailable = false;

function isEndpointUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}

// Shared by every call site that can observe POLICY_CLOUD_BACKUP_BLOCKED
// (the top-level catch, and the dictionary/snippets isolating catches below):
// an expected gate, not a failure, so it sets state without touching
// lastError or reporting to Sentry the way a genuine sync error does.
function stopSyncForPolicyBlock(): void {
  useSyncStore.getState().set({ policyBlocked: true, status: 'idle', lastError: null });
  Sentry.addBreadcrumb({
    category: 'sync',
    message: 'policy blocked (POLICY_CLOUD_BACKUP_BLOCKED); stopping run',
    level: 'info',
  });
}

// Everything that isn't a policy block or a real server answer (ApiError) is a
// network-level failure: offline, DNS, timeout — fetch throwing a plain
// TypeError/Error. Runs that skip the personal gate happen on every foreground
// trigger for every unpaid user, the largest segment, so surfacing "offline" as
// a sync error there would spam status:'error' + Sentry on every one of them.
function isQuietNetworkError(err: unknown): boolean {
  return !isPolicyCloudBackupBlockedError(err) && !(err instanceof ApiError);
}

// Ends the run as a clean idle: no lastError, no captureException, and a
// partial set so the gate's subscriptionRequired survives untouched.
function endRunQuietly(message: string, err: unknown): void {
  Sentry.addBreadcrumb({
    category: 'sync',
    message,
    level: 'info',
    data: { err: String(err) },
  });
  useSyncStore.getState().set({ status: 'idle', lastError: null });
}

const POST_WRITE_DEBOUNCE_MS = 1500;
const SUBSCRIPTION_CACHE_TTL_MS = 60_000;
const FOREGROUND_THROTTLE_MS = 30_000;

let lastForegroundSyncAt = 0;

let subscriptionCachedAt = 0;
let subscriptionCached = false;

// Called alongside wipeAllSyncableData() on an account switch. Without this,
// a foreground-triggered run for the NEW user could reuse the PREVIOUS user's
// cached subscription answer for up to SUBSCRIPTION_CACHE_TTL_MS, sending it
// down the wrong gate branch.
function resetSubscriptionCache(): void {
  subscriptionCachedAt = 0;
  subscriptionCached = false;
}

async function hasActiveSubscription(force: boolean, checkpoint: SyncCheckpoint): Promise<boolean> {
  if (!force && Date.now() - subscriptionCachedAt < SUBSCRIPTION_CACHE_TTL_MS) {
    return subscriptionCached;
  }
  try {
    checkpoint();
    const usage = await fetchUsage();
    checkpoint();
    subscriptionCached = usage.isSubscribed;
    subscriptionCachedAt = Date.now();
    return subscriptionCached;
  } catch (err) {
    if (err instanceof SyncCancelledError) throw err;
    // Fail closed: if we can't verify, don't sync. Avoids accidental free
    // cloud writes when the usage endpoint is unreachable.
    Sentry.addBreadcrumb({
      category: 'sync',
      message: 'subscription check failed; treating as unsubscribed',
      level: 'warning',
      data: { err: String(err) },
    });
    return false;
  }
}

function currentUserId(): string | null {
  const auth = useAuthStore.getState();
  return auth.user && !auth.isGuest ? auth.user.id : null;
}

function reconcileSyncIdentity(auth: ReturnType<typeof useAuthStore.getState>): void {
  if (!auth.user || auth.isGuest) return;
  const userId = auth.user.id;

  const lastUserId = getLastSyncedUserId();
  if (lastUserId !== userId) {
    // Signing up from an anonymous onboarding session changes the user id on
    // the same device, but it is a link, not a switch: the local rows belong
    // to the person who just created the account, so they are claimed by the
    // backfill below rather than wiped.
    const linkedFromAnonymous = lastUserId !== null && isLinkFromAnonymous(lastUserId);
    if (lastUserId && !linkedFromAnonymous) {
      // Account switched on this device. Wipe the previous user's local
      // data before pulling the new user's — otherwise we'd leak the
      // previous user's folders/notes into the new user's view.
      Sentry.addBreadcrumb({
        category: 'sync',
        message: `user changed (${lastUserId} → ${userId}); wiping local data`,
        level: 'info',
      });
      notesRepository.wipeAllSyncableData();
      resetSubscriptionCache();
      // Immediately clear in-memory dictionary + snippets so any UI/transcription
      // path that reads them between now and the post-pull load() doesn't see the
      // previous user's data.
      useDictionaryStore.getState().reset();
      useSnippetsStore.getState().reset();
    } else if (lastUserId) {
      // The rows stay, but the server migrated billing only: every remote id
      // and pull cursor on this device still belongs to the anonymous user.
      // Forget them so the passes below re-create the rows under the account
      // and replay its pulls from scratch.
      Sentry.addBreadcrumb({
        category: 'sync',
        message: `anonymous ${lastUserId} linked to ${userId}; re-adopting local rows`,
        level: 'info',
      });
      notesRepository.dropRemoteIdsForAccountLink();
      clearPrivateNoteDeletionQueue();
      resetAllPullCursors();
      resetSubscriptionCache();
    }
    setLastSyncedUserId(userId);
  }
  // The link token is single-use and bound to the anonymous id that set it:
  // consumed by the run that links (or the wipe), re-issued only while the
  // session is still anonymous.
  if (auth.user.isAnonymous) recordAnonymousUser(userId);
  else clearAnonymousLink();
}

async function retryPrivateNoteDeletes(checkpoint: SyncCheckpoint): Promise<void> {
  try {
    await pushPrivateNoteDeletes(checkpoint);
  } catch (error) {
    checkpoint();
    if (error instanceof SyncCancelledError) throw error;
    // A lost team permission must not prevent unrelated notes from syncing.
    Sentry.captureException(error, { tags: { sync: 'private-note-deletion' } });
  }
}

async function runSyncNow(reason: SyncReason): Promise<void> {
  const auth = useAuthStore.getState();
  if (!auth.user || auth.isGuest) return;
  if (inFlight) {
    pendingTrigger = reason;
    return;
  }

  const cloudBackupEnabled = useConfigStore.getState().config?.cloudBackupEnabled ?? true;

  // Foreground triggers fire on every AppState→active transition, which can
  // be noisy (window focus, sim re-focus). Skip if we synced very recently.
  // Applies to every run below, personal or team-only.
  if (reason === 'foreground' && Date.now() - lastForegroundSyncAt < FOREGROUND_THROTTLE_MS) {
    return;
  }

  // Claimed before the paygate's network round trip, not after it. A run that
  // parks on that request while the user signs up would otherwise overlap the
  // sign-in run and, resuming with its pre-signup `auth` snapshot, read the
  // new id as an account switch and wipe. Triggers that arrive meanwhile queue
  // through pendingTrigger and run once this one settles.
  inFlight = true;
  const { checkpoint, dispose } = createSyncContext();

  try {
    checkpoint();
    reconcileSyncIdentity(auth);
    const userId = auth.user.id;
    await retryPrivateNoteDeletes(checkpoint);
    checkpoint();
    // Paygate: personal sync (everything — private content, dictionary,
    // snippets) requires cloud backup enabled AND an active subscription.
    // Team collaboration is free (since Aug 2026) and runs independently of
    // both — see the personalSyncAllowed branch below. Skip the network
    // subscription check entirely when cloud backup itself is off; there's
    // nothing it could unlock on its own.
    let personalSyncAllowed = false;
    let subscriptionRequired = false;
    if (cloudBackupEnabled) {
      // Manual taps and sign-in transitions force a fresh check so a
      // just-subscribed user (or a new account) doesn't have to wait for the
      // cache to expire.
      const forceFresh = reason === 'manual' || reason === 'sign-in';
      const subscribed = await hasActiveSubscription(forceFresh, checkpoint);
      personalSyncAllowed = subscribed;
      subscriptionRequired = !subscribed;
    }

    checkpoint();

    // The identity this run was scheduled for can be gone by now (signed up
    // or out during the await). Its own trigger is queued behind us; let that
    // run reconcile the new id rather than acting on a stale snapshot.
    if (useAuthStore.getState().user?.id !== auth.user.id) return;

    // An unsubscribed anonymous session has nothing to sync — no personal
    // entitlement, no teams — so don't run the spaces probe and team crawl on
    // every foreground and note write from mid-onboarding on. Its rows get
    // their first bookkeeping when it either subscribes or becomes an account.
    if (auth.user.isAnonymous && !personalSyncAllowed) {
      useSyncStore
        .getState()
        .set({ status: 'idle', lastError: null, subscriptionRequired, policyBlocked: false });
      return;
    }

    useSyncStore
      .getState()
      .set({ status: 'running', lastError: null, subscriptionRequired, policyBlocked: false });
    Sentry.addBreadcrumb({ category: 'sync', message: `start (${reason})`, level: 'info' });

    // Runs first, ahead of any content pass: probes team-spaces capability
    // and mirrors space membership so the team pull passes below can resolve
    // every space they encounter. `capable === false` means the backend
    // predates team spaces, so those passes are skipped entirely.
    let spacesResult: SyncSpacesResult;
    try {
      spacesResult = await syncSpaces(checkpoint);
      checkpoint();
    } catch (err) {
      if (err instanceof SyncCancelledError) throw err;
      // This pass sits ahead of both branches, so a gated run (the team-only
      // one below) has to apply the same quiet-network rule its own catch
      // does — otherwise every offline foreground trigger for an unpaid user
      // lands in the top-level catch as status:'error' + Sentry. Full-sync
      // runs still surface the failure normally.
      if (personalSyncAllowed || !isQuietNetworkError(err)) throw err;
      endRunQuietly('spaces pass: network-level error (offline?); ending quietly', err);
      return;
    }
    Sentry.addBreadcrumb({
      category: 'sync',
      message: `spaces (capable=${spacesResult.capable}, active=${spacesResult.activeSpaces.length})`,
      level: 'info',
    });

    if (personalSyncAllowed) {
      await runInitialBackfillIfNeeded(userId, checkpoint);
      checkpoint();

      // Personal and team passes are independent crawls with independent
      // cursors. Folders lead notes in both scopes so a note's folder is
      // already local by the time the note arrives. A team pass that parks
      // (space or folder not mirrored yet) completes normally — the next run
      // picks up where it stopped.
      await pullFolders(checkpoint);
      checkpoint();
      if (spacesResult.capable) await pullFoldersTeam(checkpoint);
      checkpoint();
      await pullNotes(checkpoint);
      checkpoint();
      if (spacesResult.capable) await pullNotesTeam(checkpoint);
      checkpoint();

      // Re-check the gate before any upload. The toggle is lazy — turning cloud
      // backup off doesn't abort a run already in flight — so without this a sync
      // that started while it was on would keep pushing notes/dictionary after the
      // user opted out. Pulls above are harmless downloads; pushes must stop the
      // instant the opt-out lands.
      if (!(useConfigStore.getState().config?.cloudBackupEnabled ?? true)) {
        useSyncStore.getState().set({
          status: 'idle',
          lastError: null,
          subscriptionRequired: false,
          policyBlocked: false,
        });
        return;
      }

      await retryPrivateNoteDeletes(checkpoint);
      checkpoint(true);
      await pushFolders(false, checkpoint);
      checkpoint();
      checkpoint(true);
      await pushNotes(false, checkpoint);
      checkpoint();

      // Dictionary sync is independent of notes/folders. Isolate its errors so a
      // dictionary endpoint outage doesn't block unrelated note uploads — except
      // a policy block, which must stop the whole run the same way it does for
      // notes/folders (checked first, before the isolating capture below).
      try {
        await pullDictionary(checkpoint);
        checkpoint();
        checkpoint(true);
        await pushDictionary(checkpoint);
        checkpoint();
      } catch (err) {
        if (err instanceof SyncCancelledError) throw err;
        if (isPolicyCloudBackupBlockedError(err)) {
          stopSyncForPolicyBlock();
          return;
        }
        Sentry.captureException(err, { tags: { sync: 'dictionary' } });
      }

      // Snippets sync is likewise independent. Isolate its errors too (with the
      // same policy-block exception as dictionary above), and skip it entirely
      // once the endpoint has been seen as unavailable this session.
      if (!snippetsEndpointUnavailable) {
        try {
          await pullSnippets(checkpoint);
          checkpoint();
          checkpoint(true);
          await pushSnippets(checkpoint);
          checkpoint();
        } catch (err) {
          if (err instanceof SyncCancelledError) throw err;
          if (isPolicyCloudBackupBlockedError(err)) {
            stopSyncForPolicyBlock();
            return;
          }
          if (isEndpointUnavailable(err)) {
            snippetsEndpointUnavailable = true;
            Sentry.addBreadcrumb({
              category: 'sync',
              message: 'snippets endpoint unavailable; skipping snippet sync this session',
              level: 'info',
            });
          } else {
            Sentry.captureException(err, { tags: { sync: 'snippets' } });
          }
        }
      }

      // Sync mutated SQLite directly; tell the React-facing stores to reload so
      // the UI reflects the new folders/notes/spaces/dictionary/snippets.
      useNotesStore.getState().loadFolders();
      useNotesStore.getState().loadSpaces();
      useNotesStore.getState().loadNotes();
      void useDictionaryStore.getState().load();
      void useSnippetsStore.getState().load();

      useSyncStore.getState().set({
        status: 'idle',
        lastError: null,
        lastSyncAt: new Date().toISOString(),
      });
    } else if (spacesResult.capable) {
      // Team-only pass: the personal gate is closed (backup off, or
      // unsubscribed), but team collaboration is free and unaffected by
      // either — keep team spaces in sync, scoped to team rows only.
      // Everything paid-gated (backfill, personal pulls/pushes, dictionary,
      // snippets) is skipped entirely.
      try {
        await pullFoldersTeam(checkpoint);
        checkpoint();
        await pullNotesTeam(checkpoint);
        checkpoint();
        checkpoint(true);
        await pushFolders(true, checkpoint);
        checkpoint();
        checkpoint(true);
        await pushNotes(true, checkpoint);
        checkpoint();

        useNotesStore.getState().loadFolders();
        useNotesStore.getState().loadSpaces();
        useNotesStore.getState().loadNotes();

        useSyncStore.getState().set({ status: 'idle', lastError: null });
      } catch (err) {
        if (err instanceof SyncCancelledError) throw err;
        // A policy block or a real server error (ApiError, e.g. 5xx) is a
        // genuine failure — let it propagate to the top-level catch exactly
        // like a full-sync failure would. Anything else ends quietly (see
        // isQuietNetworkError) — the next trigger retries.
        if (!isQuietNetworkError(err)) throw err;
        endRunQuietly('team-only pass: network-level error (offline?); ending quietly', err);
      }
    } else {
      // Personal gate closed AND not team-spaces capable: nothing this
      // device can sync right now. Clean idle, not an error.
      useSyncStore.getState().set({ status: 'idle', lastError: null });
    }

    if (reason === 'foreground') lastForegroundSyncAt = Date.now();
    Sentry.addBreadcrumb({ category: 'sync', message: 'done', level: 'info' });
  } catch (err) {
    if (err instanceof SyncCancelledError) {
      useSyncStore.getState().set({ status: 'idle', lastError: null });
      return;
    }
    // Org-level policy (not the user's own toggle above) rejected a sync
    // write. This is an expected gate, not a failure: stop the run without
    // marking any row failed or clearing pendingSync (pushNotes.ts/
    // pushFolders.ts/pushDictionary.ts/pushSnippets.ts rethrow before
    // mutating anything for the row that tripped it) so the next sync
    // retries once the policy allows it again.
    if (isPolicyCloudBackupBlockedError(err)) {
      stopSyncForPolicyBlock();
      return;
    }
    const error = err instanceof Error ? err : new Error(String(err));
    useSyncStore.getState().set({ status: 'error', lastError: error });
    Sentry.captureException(error, { tags: { sync: 'runSync' } });
  } finally {
    dispose();
    inFlight = false;
    if (pendingTrigger) {
      const next = pendingTrigger;
      pendingTrigger = null;
      runSyncNow(next).catch(() => {});
    }
  }
}

export function requestSync(reason: SyncReason): void {
  if (reason === 'after-write') {
    if (postWriteTimer) clearTimeout(postWriteTimer);
    postWriteTimer = setTimeout(() => {
      postWriteTimer = null;
      runSyncNow('after-write').catch(() => {});
    }, POST_WRITE_DEBOUNCE_MS);
    return;
  }
  runSyncNow(reason).catch(() => {});
}

let unsubscribeAuth: (() => void) | null = null;
let appStateSub: { remove(): void } | null = null;

export function initSyncTriggers(): void {
  if (appStateSub) return;

  appStateSub = AppState.addEventListener('change', (s: AppStateStatus) => {
    if (s === 'active') requestSync('foreground');
  });

  // Tracked by id, not by a signed-in boolean: signing up from an anonymous
  // onboarding session keeps that boolean true the whole time, so an edge
  // detector would miss the one transition the identity reconciliation exists
  // for, and would leave a stale unsubscribed verdict cached from the
  // anonymous session.
  let lastUserId = currentUserId();
  unsubscribeAuth = useAuthStore.subscribe((state, prevState) => {
    const nowUserId = state.user && !state.isGuest ? state.user.id : null;
    if (nowUserId !== lastUserId) {
      if (nowUserId) {
        try {
          reconcileSyncIdentity(state);
          useNotesStore.getState().loadFolders();
          useNotesStore.getState().loadSpaces();
          useNotesStore.getState().loadNotes();
        } catch (err) {
          // Runs inside the auth store's setState: a local wipe/reload failure
          // must not reject the sign-in or skip later auth subscribers. The
          // queued sign-in run reconciles again and reports its own failure.
          Sentry.captureException(err, { tags: { sync: 'reconcileOnSignIn' } });
        }
        resetSubscriptionCache();
        requestSync('sign-in');
      } else {
        // Sign-out: clear in-memory dictionary + snippets so the previous
        // user's data doesn't bleed into a guest session or transcription
        // prompts before the next sync wipes/reloads SQLite.
        useDictionaryStore.getState().reset();
        useSnippetsStore.getState().reset();
        // After a real account signs out, whoever signs in next is a new
        // account, not a link, so the next id change has to be free to wipe.
        // An anonymous session signing out keeps the link armed: the rows
        // still belong to whoever holds the device, and their eventual
        // signup must claim them rather than wipe them.
        if (!prevState.user?.isAnonymous) clearAnonymousLink();
      }
    }
    lastUserId = nowUserId;
  });
}

export function teardownSyncTriggers(): void {
  appStateSub?.remove();
  appStateSub = null;
  unsubscribeAuth?.();
  unsubscribeAuth = null;
}
