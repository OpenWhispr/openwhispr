# Offline launch keeps the last validated account (read-only)

Status: implemented in OpenWhispr/openwhispr#2927 · 2026-10-23, revised 2026-10-27 · follows #2921 (workspace list cache)

## Problem

On a launch with no network, Better Auth's `GET /get-session` throws inside
`authContextFetch`. The session atom ends with `data: null, error: <fetch error>`,
`authRequestContext` never sets `sessionResolved`, `getBoundSessionGeneration()`
returns `null`, and `useAuth` reports a guest. `fetchPolicy` never runs, so
`usePolicyStore.accountId` stays `null`, `useWorkspace` never calls `refresh()`,
and the #2921 workspace list cache is never read. Team spaces, the workspace
switcher and the account UI all disappear until the network returns.

`transientlyAuthenticated` already covered the same situation _after_ a session
resolved in this run (a later refetch fails): it keeps presenting the account
while sync stays fenced. Nothing covered it at launch, because the renderer has
no in-memory session to keep.

## What already survives offline

| Evidence                                                                                             | Where                                                                                                                                      | Strength                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Bearer token + credential generation                                                                 | main `tokenStore` (`authGetTokenState`)                                                                                                    | proves which credential is on disk, not whose                                                                        |
| Token-bound account binding `{accountId, sha256(token)}`                                             | main `accountScopeBinding.js`, written only by `set-active-account-scope` after a successful reconcile; read by `get-active-account-scope` | proves _this exact bearer_ was last validated as `accountId`. A rotated, replaced or cleared token no longer matches |
| Account-scope marker (`openwhispr:accountScopeUserId`, `…Validated`, `…PurgeRequired`, `isSignedIn`) | renderer localStorage                                                                                                                      | proves the renderer's local caches were last reconciled for that user                                                |
| DB account scope                                                                                     | main boot already calls `databaseManager.setActiveAccountId(resolveBootAccountScope(...))`                                                 | notes and team spaces are already readable for that account offline                                                  |
| Policy / managed-config disk caches                                                                  | main `workspacePolicyManager`, `enterpriseIdentityManager`, keyed by API origin + credential hash                                          | served when the network is down. Main still deletes the managed-config file on every token change and sign-out       |
| Workspace list                                                                                       | renderer `workspaceListCache` (#2921), keyed by account                                                                                    |                                                                                                                      |

The dictation window already presents this exact binding (`accountScopeMirror.ts`):
it never resolves its own session and hydrates policy from `get-active-account-scope`.
This design gives the control panel the same fallback, plus the account UI.

What is missing: the user's display fields (`name`, `email`, `image`,
`emailVerified`). Better Auth keeps them only in memory.

## Design

An **offline account** is presented in the control panel when _all_ of these hold
for the current credential generation `G`. The control panel is the only window
that resolves its own session; the dictation window's cross-origin `get-session`
always fails, so it follows main's scope through `accountScopeMirror.ts`.

1. `get-session` for `G` got no verdict: a transport error (fetch threw, but not a
   request Better Auth cancelled to start another) or any status but 401. Better
   Auth answers a dead credential with 401 or with 200 and no user, so a 403 / 404
   / 407 comes from a proxy or firewall.
2. No verdict for `G` arrived: no 200 naming a user, no 200 without a user and no
   401 for `G`.
3. Main's `get-active-account-scope` returns `{accountId: A, authGeneration: G}`,
   where `G` is still the observed generation and a token is present. That means
   the bearer hash matches the binding.
4. The renderer's account scope needs no reconciliation for `A`
   (`accountScopeRequiresReconciliation(A)` is false: previous user is `A`,
   validated, signed in, no purge flag, nothing pending).
5. A saved profile exists for `A`, stamped with a server answer from the last 30
   days.

If any check fails, the launch stays a guest, as it did before.

A **bound session whose refetch then fails** (the network drops while the app is
open) keeps its binding and is presented the same way, read-only. It is marked
`refetchFailedGeneration`, and only a new answer from the server may validate it
again: Better Auth clears `sessionError` as soon as the next refetch starts, so
without the mark reconciliation would re-commit the lease with no answer at all.
A non-401 error on a bound session reads the binding first and then drops the
session and presents the offline account in one update, so the account is never
shown signed out in between.

### Shown vs fenced

|                                                                                                   | Offline account (or a session whose refetch failed)                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useAuth().isSignedIn`, `user` (saved profile, or the session's user), `isLoaded`                 | shown (`true`, profile, `true`), also while a refetch is pending                                                                                                                                      |
| `useAuth().session`                                                                               | `null` offline (no server session object exists)                                                                                                                                                      |
| `useAuth().isOfflineAccount`                                                                      | `true`                                                                                                                                                                                                |
| Policy (`fetchPolicy(A, G)`)                                                                      | requested once per account and generation; main serves its disk cache, or fails closed (`error`)                                                                                                      |
| Managed enterprise identity                                                                       | requested alongside; main serves its disk cache. A different identity's config never stands in for it, even to fail closed                                                                            |
| Workspace switcher / settings                                                                     | `refresh()` runs. `cloudGet` refuses without a validated generation, so the catch path shows `workspaceListCache` for `A`                                                                             |
| Team spaces / notes                                                                               | already scoped by main to `A` at boot. They render because `isSignedIn` is true                                                                                                                       |
| Sync, leaderboard, insights upload                                                                | **fenced**: nothing validates the generation, so `getValidatedAuthGeneration()` is `null`                                                                                                             |
| Every authenticated `cloudApi` call                                                               | **fenced**: main answers `AUTH_CONTEXT_UNVALIDATED` without a request; the error reads as translated copy (`auth.unconfirmedSession`)                                                                 |
| Checkout, billing portal, plan switch and preview, referral invites (bearer IPCs, no generation)  | **fenced in the renderer** (`hasValidatedAuthContext()`), with the same copy; usage and referral reads still run                                                                                      |
| Account UI                                                                                        | read-only: a notice in Settings → Account, name, password and delete account disabled, Offline in the profile menu, Retry instead of Sign in on the leaderboard, upgrade disabled in the limit prompt |
| Account-scope reconcile, purge, verify, `set-active-account-scope`, `settingsStore.setIsSignedIn` | **not run** until the server answers                                                                                                                                                                  |
| Better Auth client calls (update profile, change password, …)                                     | disabled in the UI; the server authenticates the bearer either way                                                                                                                                    |

### How a later answer settles it

Better Auth refetches when the window becomes visible and on `online` only, so
neither fires when the auth server recovers while the network stayed up. While an
account is shown without a validated session (`sessionAwaitsVerdict()`), `auth.ts`
also asks again on window focus and once a minute, unless a request is already in
flight (starting another would cancel it, so a slow server would never answer).

- **200, same user `A`**: the session binds and the offline account stays
  presented until reconciliation finds `"none"` and commits the validated lease, so
  coming back online never passes through a signed-out state. Then sync,
  `setIsSignedIn(true)`, policy and workspace refresh run as before.
- **200, different user `B`** (cannot happen with a matching binding, but is
  handled): the offline account ends, it binds `B`, and reconcile sees a previous
  user `A` ≠ `B`: `purge` → `resetRendererCaches` (workspace list, profile, rosters).
- **200, no user** (revoked or expired session): `G` is marked rejected, it binds
  `null`, and reconcile purges and signs out, as before. A later 5xx can't bring
  the account back.
- **401**: the offline state is cleared, `G` is marked rejected and the saved
  profile is dropped, so neither a later failure in `G` nor a later launch brings
  it back. The presentation drops to guest. A 401 alone does not purge, as before.

### Saved profile

`openwhispr:accountProfile` holds `{ id, name, email, image, emailVerified,
validatedAt }`, where `validatedAt` is when the server last answered for a
validated session: written by `useAuth` when a session validates (stamped with
that session's answer, not the time of the commit) and by `authRequestContext` on
each later answer. A commit without a new answer (a reconciliation retry) never
moves it, so its age bounds how long an offline device keeps presenting an
account the server may have revoked. It is cleared on purge, sign-out, a 401 and
right after the server deletes the account.

### Threat model

| Scenario                                                                                     | Outcome                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account switch while offline                                                                 | Signing in needs the network. `signOut()` offline clears the token, which bumps the generation (`observeState` drops the offline state), and clears the profile. The next account resolves online and goes through reconcile/purge.                                                     |
| Token belonging to another user (replaced on disk, deep-link sign-in that never validated)   | `sha256(token)` no longer matches the binding, so `get-active-account-scope` returns `null`: guest.                                                                                                                                                                                     |
| Binding for `A`, but the renderer marker says `B` or a purge is pending (interrupted switch) | Check 4 fails: guest.                                                                                                                                                                                                                                                                   |
| Revoked session, device offline                                                              | `A` is shown read-only with data that is already on this device for `A`. Main already exposes the same data at boot through the DB scope. Nothing syncs or mutates. The first answer purges. The profile's age (last server answer) bounds how long an offline device keeps presenting. |
| Auth server unreachable for weeks while the app stays open                                   | Refetches fail, nothing re-validates the session and the profile is not restamped, so after 30 days an offline relaunch is a guest.                                                                                                                                                     |
| App crashes between the server deleting the account and sign-out                             | The profile was already cleared: guest.                                                                                                                                                                                                                                                 |
| Credential rotates mid-launch                                                                | The generation changes, and `observeState` drops the offline state. The binding lookup result is discarded unless its `authGeneration` is still the observed one.                                                                                                                       |
| Stale profile from a previous account                                                        | It is read only when `profile.id === A` (the binding's account), and cleared on purge and sign-out.                                                                                                                                                                                     |
| Flaky network: `get-session` fails, other calls succeed                                      | Authenticated `cloudApi` calls and billing still need a validated generation, so they stay fenced. Policy and managed-config IPC check only the generation, which is the credential the binding vouches for. This is the same trust the dictation window already uses.                  |

## Code changes

- **`src/lib/authRequestContext.ts`**: snapshot fields `offlineAccount`,
  `sessionRejectedGeneration` and `refetchFailedGeneration`; `noteSessionUnreachable`
  (control panel only, binding read before an optional session clear, applied in one
  update); `getOfflineAccount()` (offline, or confirmed for the same account until
  validated); `sessionAwaitsVerdict()`; `getSessionAnsweredAt()`; cancelled requests
  ignored; only 401 is a rejection.
- **`src/lib/offlineAccountProfile.ts`**: read, write and clear the saved profile.
- **`src/hooks/useAuth.ts`**: presents the offline account and the failed-refetch
  session read-only (`isOfflineAccount`), loads the offline account's caches once
  per account and generation, and saves the profile when a session validates.
- **`src/lib/auth.ts`**: sign-out clears the profile; the session retry.
- **`src/services/cloudApi.ts`**: `AUTH_CONTEXT_UNVALIDATED` reads as
  `auth.unconfirmedSession`.
- **`src/hooks/useUsage.ts`, `src/lib/billingPortalError.ts`, `ReferralDashboard`,
  `UpgradePrompt`, `SettingsPage`**: the billing and referral fence and its copy.
- **`src/stores/workspaceStore.ts`**: `refreshManagedEnterpriseIdentity` no longer
  calls `clear()` (which deleted main's disk cache) when the identity changes;
  `enterpriseIdentityStore` falls back only to the same identity's last config.
- **`src/helpers/enterpriseIdentityManager.js`**: a write drops entries from older
  credentials for the same API origin.
- **`src/lib/accountDeletionFlow.ts`**: clears the profile once the server deleted
  the account.
- **UI**: Settings → Account notice, `ProfileSection` `readOnly`, delete account
  disabled, profile menu badge, leaderboard Retry.

## Tests

- `test/lib/authRequestContext.test.js`: binding match and mismatch; a 503, 403,
  404 or 407 counts as offline; a cancelled request doesn't; 401 rejects and drops
  the profile; a no-user answer stays a verdict through a later outage; the same
  account stays presented until validated; after a failed refetch only a new
  answer validates; a mid-session server error never shows the account signed
  out; answers for a validated session refresh the profile; the dictation window
  never presents an offline account.
- `test/hooks/useAuthOfflineAccount.test.js` mounts `useAuth` over the real
  `authRequestContext` and `authAccountScope`: offline launch read-only with
  reconcile fenced; another account's scope or a pending purge stays a guest; a
  pending refetch keeps the account; back online with the same user (both event
  orders, never signed out), a different user, no user, 401; losing the network
  mid-session is read-only and nothing re-validates or restamps until an answer.
- `test/lib/offlineSessionRetry.test.js`: retries on focus and every minute, skips
  while a request is in flight, stops once validated.
- `test/lib/offlineAccountProfile.test.js`, `test/lib/accountDeletionFlow.test.js`,
  `test/lib/billingPortalError.test.js`,
  `test/services/cloudApiUnconfirmedSession.test.js`,
  `test/components/profileMenu.test.js`, `test/components/profileSectionReadOnly.test.js`.
- `test/lib/accountScopeMirror.test.js` (main's cache survives boot),
  `test/stores/enterpriseIdentityStoreEnforcement.test.js` (no inherited scopes),
  `test/helpers/enterpriseIdentityManager.test.js` (pruning keeps other origins).
