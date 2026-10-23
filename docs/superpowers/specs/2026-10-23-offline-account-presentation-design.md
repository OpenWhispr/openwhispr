# Offline launch keeps the last validated account (read-only)

Status: draft for approval · 2026-10-23 · follows OpenWhispr/openwhispr#2921 (workspace list cache)

## Problem

On a launch with no network, Better Auth's `GET /get-session` throws inside
`authContextFetch`. The session atom ends with `data: null, error: <fetch error>`,
`authRequestContext` never sets `sessionResolved`, `getBoundSessionGeneration()`
returns `null`, and `useAuth` reports a guest. `fetchPolicy` never runs, so
`usePolicyStore.accountId` stays `null`, `useWorkspace` never calls `refresh()`,
and the #2921 workspace list cache is never read. Team spaces, the workspace
switcher and the account UI all disappear until the network returns.

`transientlyAuthenticated` already covers the same situation _after_ a session
resolved in this run (a later refetch fails): it keeps presenting the account
while sync stays fenced. Nothing covers it at launch, because the renderer has
no in-memory session to keep.

## What already survives offline

| Evidence                                                                                             | Where                                                                                                                                      | Strength                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Bearer token + credential generation                                                                 | main `tokenStore` (`authGetTokenState`)                                                                                                    | proves which credential is on disk, not whose                                                                        |
| Token-bound account binding `{accountId, sha256(token)}`                                             | main `accountScopeBinding.js`, written only by `set-active-account-scope` after a successful reconcile; read by `get-active-account-scope` | proves _this exact bearer_ was last validated as `accountId`. A rotated, replaced or cleared token no longer matches |
| Account-scope marker (`openwhispr:accountScopeUserId`, `…Validated`, `…PurgeRequired`, `isSignedIn`) | renderer localStorage                                                                                                                      | proves the renderer's local caches were last reconciled for that user                                                |
| DB account scope                                                                                     | main boot already calls `databaseManager.setActiveAccountId(resolveBootAccountScope(...))`                                                 | notes and team spaces are already readable for that account offline                                                  |
| Policy / managed-config disk caches                                                                  | main `workspacePolicyManager`, `enterpriseIdentityManager`, keyed by API origin + credential hash                                          | served when the network is down                                                                                      |
| Workspace list                                                                                       | renderer `workspaceListCache` (#2921), keyed by account                                                                                    |                                                                                                                      |

The dictation window already presents this exact binding (`accountScopeMirror.ts`):
it never resolves its own session and hydrates policy from `get-active-account-scope`.
This design gives the control panel the same fallback, plus the account UI.

What is missing: the user's display fields (`name`, `email`, `image`,
`emailVerified`). Better Auth keeps them only in memory.

## Design

An **offline account** is presented in the control panel (the only window that
resolves its own session; the dictation window's cross-origin `get-session` always
fails and it follows main's scope through `accountScopeMirror.ts`) when _all_ of
these hold for the current credential generation `G`:

1. `get-session` for `G` failed without a verdict: a transport error (fetch threw)
   or any status but 401. Better Auth answers a dead credential with 401 or with
   200 and no user, so a 403 / 404 / 407 comes from a proxy or firewall.
2. No verdict for `G` arrived: no successful `get-session` (`sessionResolved` for
   `G`), no 200 without a user and no 401 for `G`.
3. Main's `get-active-account-scope` returns `{accountId: A, authGeneration: G}`,
   where `G` is still the observed generation and a token is present. That means
   the bearer hash matches the binding.
4. The renderer's account scope needs no reconciliation for `A`
   (`getAccountScopeAction(A) === "none"`: previous user is `A`, validated, signed
   in, no purge flag, nothing pending).
5. A cached profile exists for `A` and was written by a validation in the last
   30 days.

If any check fails, the launch stays a guest, as it does today.

### Shown vs fenced

|                                                                                                      | Offline account                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `useAuth().isSignedIn`, `user` (cached profile), `isLoaded`                                          | shown (`true`, profile, `true`), also while a refetch is pending                                                            |
| `useAuth().session`                                                                                  | `null` (no server session object exists)                                                                                    |
| new `useAuth().isOfflineAccount`                                                                     | `true`                                                                                                                      |
| Policy (`fetchPolicy(A, G)`)                                                                         | runs; main serves its disk cache for `A`/`G`, or fails closed (`error`)                                                     |
| Managed enterprise identity                                                                          | runs (`refreshManagedEnterpriseIdentity(A, G)`); main serves its disk cache, which an identity change no longer deletes     |
| Workspace switcher / settings                                                                        | `refresh()` runs. `cloudGet` refuses without a validated generation, so the catch path shows `workspaceListCache` for `A`   |
| Team spaces / notes                                                                                  | already scoped by main to `A` at boot. They now render because `isSignedIn` is true                                         |
| Sync, leaderboard, insights upload                                                                   | **fenced**: `commitValidatedAuthContext` never runs, so `getValidatedAuthGeneration()` is `null`                            |
| Every authenticated `cloudApi` call                                                                  | **fenced**: no validated generation, so main answers `AUTH_CONTEXT_UNVALIDATED` without a request                           |
| Checkout, billing portal, plan switch and preview, referral invites (bearer IPCs with no generation) | **fenced in the renderer** (`hasValidatedAuthContext()`); usage and referral reads still run                                |
| Account UI                                                                                           | read-only: an "offline" notice, name, password and delete account disabled, the profile menu says Offline                   |
| Account-scope reconcile, purge, verify, `set-active-account-scope`, `settingsStore.setIsSignedIn`    | **not run**. They run only after a real `get-session`                                                                       |
| Better Auth client calls (update profile, change password, …)                                        | not fenced in the renderer. They reach the server with the bearer, which authenticates it; offline they fail at the network |

### How a later online `get-session` settles it

Better Auth refetches when the window becomes visible and on `online` only, so
neither fires when the auth server recovers while the network stayed up. While an
offline account is shown, `auth.ts` also asks again on window focus and once a
minute until a verdict arrives.

- **200, same user `A`**: `recordSessionResolution(G, A)` clears the offline
  state, and the session binds. Reconcile finds `"none"`, commits the validated
  lease, then sync, `setIsSignedIn(true)`, policy and workspace refresh run as today.
- **200, different user `B`** (cannot happen with a matching binding, but is
  handled): it binds `B`, and reconcile sees a previous user `A` ≠ `B`. That means
  `purge` → `resetRendererCaches` (workspace list, profile cache, rosters), as today.
- **200, no user** (revoked or expired session): it binds `null`, and reconcile
  purges and signs out, as today.
- **401**: the offline state is cleared, `G` is marked rejected and the saved
  profile is dropped, so neither a later transport failure in `G` nor a later
  launch brings it back. The presentation drops to guest, as a 401 does today. A
  401 alone does not purge, which is also unchanged.

### Threat model

| Scenario                                                                                     | Outcome                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account switch while offline                                                                 | Signing in needs the network. `signOut()` offline clears the token, which bumps the generation (`observeState` drops the offline state). `signOut()` also clears the profile cache. The next account resolves online and goes through reconcile/purge.                                |
| Token belonging to another user (replaced on disk, deep-link sign-in that never validated)   | `sha256(token)` no longer matches the binding, so `get-active-account-scope` returns `null`: guest.                                                                                                                                                                                   |
| Binding for `A`, but the renderer marker says `B` or a purge is pending (interrupted switch) | Check 4 fails: guest.                                                                                                                                                                                                                                                                 |
| Revoked session, device offline                                                              | `A` is shown read-only with data that is already on this device for `A`. Main already exposes the same data at boot through the DB scope. Nothing syncs or mutates. The first online `get-session` purges. The 30-day profile age bounds how long an offline device keeps presenting. |
| Credential rotates mid-launch                                                                | The generation changes, and `observeState` drops the offline state. The binding lookup result is discarded unless its `authGeneration` is still the observed one.                                                                                                                     |
| Stale profile from a previous account                                                        | It is read only when `profile.id === A` (the binding's account), and cleared on purge and sign-out.                                                                                                                                                                                   |
| Flaky network: `get-session` fails, other calls succeed                                      | Authenticated `cloudApi` calls still need a validated generation, so they stay fenced. Policy and managed-config IPC check only the generation, which is the credential the binding vouches for. This is the same trust the dictation window already uses.                            |

## Code changes

**`src/lib/authRequestContext.ts`**

- Snapshot gains `offlineAccount: { userId, generation } | null` and
  `sessionRejectedGeneration: number | null`. `observeState` drops both on a
  generation change, and `recordSessionResolution` clears `offlineAccount` (a
  resolution with no user also marks `G` rejected).
- `authContextFetch` catch for `get-session` (after the existing context check)
  calls `noteSessionUnreachable(generation)`. `handleAuthRequestError` takes the
  response: 401 sets `sessionRejectedGeneration`, clears `offlineAccount` and the
  saved profile; any other status calls `noteSessionUnreachable`.
- `noteSessionUnreachable(G)` is async. It returns early outside the control
  panel or if `G` has a verdict.
  Otherwise it reads `electronAPI.getActiveAccountScope()` and sets `offlineAccount`
  only if the result's `authGeneration === G === observedGeneration`, `hasToken`
  holds, and no verdict for `G` arrived in the meantime.
- `getOfflineAccount(): { userId, generation } | null` re-checks the same
  conditions at read time.

**`src/lib/offlineAccountProfile.ts`** (new, small): read, write and clear
`openwhispr:accountProfile` `{ id, name, email, image, emailVerified, validatedAt }`.
A read takes the expected id and rejects other ids, malformed entries and entries
older than 30 days.

**`src/hooks/useAuth.ts`**

- Profile written after `commitValidatedAuthContext` succeeds, and again while
  validated whenever the ambient user's display fields change.
- `offlineAccount` presented when the session is not bound, `getOfflineAccount()`
  matches (not gated on `isPending`: Better Auth sets it for every refetch while it
  holds no session), `getAccountScopeAction(A) === "none"` and the
  profile reads back. The decision lives in a pure exported helper
  (`resolveOfflineAccount`) so it can be unit-tested.
- When presented: `isSignedIn` and `isLoaded` are true, `user` is the profile,
  `session` is null and `isOfflineAccount` is true. An effect runs
  `fetchPolicy(A, G)`, then `refreshManagedEnterpriseIdentity(A, G)` (which calls
  workspace `refresh()`).
- Reconcile effect: unchanged. It still requires a bound session, so it never
  runs offline.
- `resetRendererCaches` also clears the profile cache.

**`src/lib/auth.ts`**: `markSignedOutState()` (the end of `signOut()`, after the
token is cleared) clears the profile cache. While an account is shown without a
validated credential (offline, or bound by a session whose refetch failed;
`sessionAwaitsVerdict()`), the session is asked for again on window focus and
every 60 s.

**`src/stores/workspaceStore.ts`**: `refreshManagedEnterpriseIdentity` no longer
calls `clear()` when the identity changes: `refresh()` already drops the previous
identity's config, and `clear()` also deleted main's disk cache, so an offline
launch could never read it. Its catch path already reads the workspace list cache
for `usePolicyStore.accountId`, and only while it is under 30 days old.

**Main process**: `enterpriseIdentityManager` drops cache entries written under an
older credential for the same API origin when it writes one, since nothing clears
the file on an identity change any more.

**UI**: Settings → Account shows an offline notice and disables name, password and
delete account; the profile menu shows Offline instead of the plan; the
leaderboard offers Retry instead of Sign in; accepting an invitation explains it
needs a connection. Checkout, billing portal, plan switch and preview, and referral
invites refuse without a validated session.

## Tests

- `test/lib/authRequestContext.test.js`
  - A transport failure on `get-session` with a matching binding yields
    `getOfflineAccount()` for that user and generation, and nothing validates it.
  - A bearer the binding wasn't validated for yields `null`.
  - A 503 counts as offline.
  - After a 401 for `G`, a later transport failure yields `null`.
  - A 200 for `G` clears the offline account. A refetch failure after it is the
    transient case, not offline. Sign-out (no token, new generation) clears it.
- `test/lib/offlineAccountProfile.test.js`
  - Profile cache: an id mismatch, a malformed entry and an age over 30 days are
    rejected, and clearing works.
  - `resolveOfflineAccount`: any scope action but `"none"`, a live session or a
    mismatched profile means guest.
- `test/hooks/useAuthOfflineAccount.test.js` mounts `useAuth` over the real
  `authRequestContext` and `authAccountScope`:
  - An offline launch presents `user-a` read-only: policy and workspace refresh
    run, while `set-active-account-scope`, `setIsSignedIn` and the validated
    generation stay untouched.
  - A scope reconciled for another account, or a pending purge, stays a guest.
  - Back online:
    - Same user: confirmed without a purge.
    - Different user: purged, and its profile replaces `user-a`'s.
    - No user: purged as a sign-out.
    - 401: guest.
- `test/stores/workspaceListCache.test.js`: when `cloudGet` refuses with
  `AUTH_CONTEXT_UNVALIDATED`, `refresh()` shows the account's own cached list
  and never another account's.
