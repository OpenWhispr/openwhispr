const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/syncPassPolicy.ts");

// --- resolveSyncConsent -----------------------------------------------------
// Backup is a blanket copy of private content; sharing and team spaces are
// per-item consent. Conflating the two is what stranded free teammates in
// workspaces they had already been added to.

const SIGNED_IN = {
  authValidated: true,
  signedIn: true,
  backupEnabled: true,
  subscribed: true,
  backupAllowedByPolicy: true,
};

test("consent: a free account still syncs shared notes and team spaces", async () => {
  const { resolveSyncConsent } = await load();
  const consent = resolveSyncConsent({
    ...SIGNED_IN,
    subscribed: false,
    backupEnabled: false,
  });
  assert.equal(consent.shared, true);
  // The paid boundary holds: private content is still not backed up.
  assert.equal(consent.backup, false);
});

test("consent: sharing survives the cloud-backup toggle being off", async () => {
  const { resolveSyncConsent } = await load();
  const consent = resolveSyncConsent({ ...SIGNED_IN, backupEnabled: false });
  assert.deepEqual(consent, { shared: true, backup: false });
});

test("consent: backup needs the plan, the toggle, and org policy together", async () => {
  const { resolveSyncConsent } = await load();
  assert.equal(resolveSyncConsent(SIGNED_IN).backup, true);
  for (const off of ["backupEnabled", "subscribed", "backupAllowedByPolicy"]) {
    assert.equal(
      resolveSyncConsent({ ...SIGNED_IN, [off]: false }).backup,
      false,
      `backup must not run with ${off} off`
    );
  }
});

test("consent: nothing syncs without a validated signed-in session", async () => {
  const { resolveSyncConsent } = await load();
  for (const off of ["authValidated", "signedIn"]) {
    assert.deepEqual(
      resolveSyncConsent({ ...SIGNED_IN, [off]: false }),
      { shared: false, backup: false },
      `${off} off must stop every pass`
    );
  }
});

// --- ambient team-only pass backoff ----------------------------------------
// Most signed-in accounts have no shared notes and no team spaces; before the
// backoff they spent three requests every five minutes confirming that.

test("team-only backoff: an account that keeps finding work never slows down", async () => {
  const { teamOnlyPassDelayMs, shouldRunAmbientTeamOnlyPass } = await load();
  assert.equal(teamOnlyPassDelayMs(0), 0);
  // One empty pass is not a pattern — stay on the normal interval.
  assert.equal(teamOnlyPassDelayMs(1), 0);
  assert.equal(shouldRunAmbientTeamOnlyPass({ emptyStreak: 0, lastPassAt: 1000, now: 1001 }), true);
});

test("team-only backoff: consecutive empty passes double up to an hour", async () => {
  const { teamOnlyPassDelayMs } = await load();
  assert.equal(teamOnlyPassDelayMs(2), 10 * 60 * 1000);
  assert.equal(teamOnlyPassDelayMs(3), 20 * 60 * 1000);
  assert.equal(teamOnlyPassDelayMs(4), 40 * 60 * 1000);
  // Ceiling holds no matter how long the account stays idle.
  for (const streak of [5, 6, 20, 500]) {
    assert.equal(teamOnlyPassDelayMs(streak), 60 * 60 * 1000, `streak ${streak}`);
  }
});

test("team-only backoff: an idle account waits, and the first launch always runs", async () => {
  const { shouldRunAmbientTeamOnlyPass } = await load();
  const now = 10 * 60 * 60 * 1000;
  assert.equal(
    shouldRunAmbientTeamOnlyPass({ emptyStreak: 4, lastPassAt: now - 39 * 60 * 1000, now }),
    false
  );
  assert.equal(
    shouldRunAmbientTeamOnlyPass({ emptyStreak: 4, lastPassAt: now - 41 * 60 * 1000, now }),
    true
  );
  // No recorded pass (fresh profile) must never be held back.
  assert.equal(shouldRunAmbientTeamOnlyPass({ emptyStreak: 9, lastPassAt: null, now }), true);
});

// --- resolvePullCursorAdvance ----------------------------------------------
// The matrix mirrors SyncService's pullFolders/pullNotes cursor semantics: a
// wrongly advanced cursor silently drops teammate edits from the delta pulls.

const base = {
  snapshot: false,
  parked: false,
  teamOnly: false,
  teamCapable: true,
  hasTeamSpaces: true,
};

test("cursor policy: snapshots and passes with parked rows never advance", async () => {
  const { resolvePullCursorAdvance } = await load();
  for (const pass of [
    { ...base, snapshot: true },
    { ...base, parked: true },
    { ...base, snapshot: true, parked: true, teamOnly: true },
  ]) {
    assert.deepEqual(resolvePullCursorAdvance(pass), {
      advanceCursor: false,
      advanceTeamCursor: false,
    });
  }
});

test("cursor policy: a team-capable full pull advances both cursors", async () => {
  const { resolvePullCursorAdvance } = await load();
  assert.deepEqual(resolvePullCursorAdvance(base), {
    advanceCursor: true,
    advanceTeamCursor: true,
  });
});

test("cursor policy: a team-only pass advances only its own (team) cursor", async () => {
  const { resolvePullCursorAdvance } = await load();
  assert.deepEqual(resolvePullCursorAdvance({ ...base, teamOnly: true }), {
    advanceCursor: true,
    advanceTeamCursor: false,
  });
});

test("cursor policy: with no team spaces a degraded pull still advances fully", async () => {
  const { resolvePullCursorAdvance } = await load();
  assert.deepEqual(
    resolvePullCursorAdvance({ ...base, teamCapable: false, hasTeamSpaces: false }),
    { advanceCursor: true, advanceTeamCursor: true }
  );
});

test("cursor policy: a degraded full pull parks the team cursor for recovery", async () => {
  const { resolvePullCursorAdvance } = await load();
  // The gap this leaves between the cursors is exactly what teamCursorLagging
  // detects to schedule the recovery pull after a capability outage.
  assert.deepEqual(resolvePullCursorAdvance({ ...base, teamCapable: false }), {
    advanceCursor: true,
    advanceTeamCursor: false,
  });
});

test("cursor policy: a degraded team-only pass advances nothing", async () => {
  const { resolvePullCursorAdvance } = await load();
  assert.deepEqual(resolvePullCursorAdvance({ ...base, teamOnly: true, teamCapable: false }), {
    advanceCursor: false,
    advanceTeamCursor: false,
  });
});

// --- purged-space guard -----------------------------------------------------

test("purge guard: entries expire strictly at the TTL", async () => {
  const { prunePurgedSpaceEntries } = await load();
  const now = 1_000_000_000;
  const ttl = 900_000;
  const entry = (at) => ({ at, reason: "deleted" });
  const pruned = prunePurgedSpaceEntries(
    { fresh: entry(now - 1), edge: entry(now - ttl), stale: entry(now - ttl - 1) },
    now,
    ttl
  );
  assert.deepEqual(pruned, { fresh: entry(now - 1) });
  assert.deepEqual(prunePurgedSpaceEntries({}, now, ttl), {});
});

test("purge guard: legacy plain-timestamp entries normalize to the deleted reason", async () => {
  const { normalizePurgedSpaceEntries } = await load();
  const shaped = { at: 123, reason: "revoked" };
  assert.deepEqual(normalizePurgedSpaceEntries({ legacy: 456, shaped }), {
    legacy: { at: 456, reason: "deleted" },
    shaped,
  });
});

// D14: a member removed then re-added must not stay locked out for the TTL.
// Only a still-live "deleted" entry keeps guarding (the delete race the guard
// was built for); a reappearing "revoked" space means re-added access.
test("purge guard: live-set sweep keeps only still-live deleted entries", async () => {
  const { keepPurgedSpaceEntry } = await load();
  assert.equal(keepPurgedSpaceEntry({ at: 1, reason: "deleted" }, true), true);
  assert.equal(keepPurgedSpaceEntry({ at: 1, reason: "revoked" }, true), false);
  assert.equal(keepPurgedSpaceEntry({ at: 1, reason: "deleted" }, false), false);
  assert.equal(keepPurgedSpaceEntry({ at: 1, reason: "revoked" }, false), false);
});

// --- resolvePulledNoteFolderId ---------------------------------------------

test("pull folder resolution accepts only mappings in the note's local space", async () => {
  const { resolvePulledNoteFolderId } = await load();
  const folders = new Map([
    ["same-space", { id: 10, space_id: 2 }],
    ["other-space", { id: 11, space_id: 3 }],
  ]);

  assert.equal(
    resolvePulledNoteFolderId({ space_id: "cloud-space", folder_id: "same-space" }, 2, folders, 99),
    10
  );
  assert.equal(
    resolvePulledNoteFolderId(
      { space_id: "cloud-space", folder_id: "other-space" },
      2,
      folders,
      99
    ),
    null,
    "a team note must fall back to its space root, never another space's folder"
  );
});

test("pull folder resolution uses the default folder only for personal notes", async () => {
  const { resolvePulledNoteFolderId } = await load();
  const folders = new Map();

  assert.equal(resolvePulledNoteFolderId({ space_id: null, folder_id: null }, 1, folders, 99), 99);
  assert.equal(
    resolvePulledNoteFolderId({ space_id: "cloud-space", folder_id: null }, 2, folders, 99),
    null
  );
});

// --- revokedNoteForkUpdate --------------------------------------------------

test("revoked fork: a push rejection moves, forks and clears the retraction", async () => {
  const { revokedNoteForkUpdate } = await load();
  const { update, relocated } = revokedNoteForkUpdate(
    { space_id: 7, cloud_id: "cloud-1" },
    1,
    "push"
  );
  assert.equal(relocated, true);
  assert.equal(update.space_id, 1);
  assert.equal(update.folder_id, null);
  assert.equal(update.cloud_id, null);
  assert.equal(update.cloud_updated_at, null);
  assert.equal(update.owner_user_id, null);
  assert.equal(update.updated_by_user_id, null);
  assert.equal(update.left_team, 0);
  assert.equal(typeof update.client_note_id, "string");
});

test("revoked fork: a never-synced push rejection keeps its client identity", async () => {
  const { revokedNoteForkUpdate } = await load();
  const { update } = revokedNoteForkUpdate({ space_id: 7, cloud_id: null }, 1, "push");
  assert.equal("client_note_id" in update, false);
  assert.equal(update.cloud_id, null);
});

test("revoked fork: the pull-side stub always forks and leaves left_team alone", async () => {
  const { revokedNoteForkUpdate } = await load();
  const { update } = revokedNoteForkUpdate({ space_id: 7, cloud_id: null }, 1, "pull");
  assert.equal(typeof update.client_note_id, "string");
  assert.equal("left_team" in update, false);
});

test("revoked fork: an already-private row forks in place without moving", async () => {
  const { revokedNoteForkUpdate } = await load();
  const { update, relocated } = revokedNoteForkUpdate(
    { space_id: 1, cloud_id: "cloud-1" },
    1,
    "pull"
  );
  assert.equal(relocated, false);
  assert.equal("space_id" in update, false);
  assert.equal("folder_id" in update, false);
  assert.equal(update.cloud_id, null);
});

// --- update-404 fork policy ------------------------------------------------
// The pull-first fallback shared by note and folder update pushes: a 404'd
// push defers to the same pass's pull to disambiguate, and only forks to
// Personal after the threshold of consecutive stub-less passes so a stub that
// never lands can't loop forever.

test("update 404: below threshold, each 404 defers and increments without mutating input", async () => {
  const { recordUpdate404 } = await load();
  const counts = { n1: 1 };
  const { fork, next } = recordUpdate404(counts, "n1", 3);
  assert.equal(fork, false);
  assert.deepEqual(next, { n1: 2 });
  assert.deepEqual(counts, { n1: 1 }, "the input map is never mutated");
});

test("update 404: a first-ever 404 starts the streak at one", async () => {
  const { recordUpdate404 } = await load();
  assert.deepEqual(recordUpdate404({}, "n1", 3), { fork: false, next: { n1: 1 } });
});

test("update 404: forks only after the threshold of consecutive stub-less passes", async () => {
  const { recordUpdate404, UPDATE_404_FORK_THRESHOLD } = await load();
  const threshold = UPDATE_404_FORK_THRESHOLD;
  let counts = {};
  // Each of the first `threshold` passes 404s and defers to the pull.
  for (let pass = 1; pass <= threshold; pass++) {
    const { fork, next } = recordUpdate404(counts, "n1", threshold);
    assert.equal(fork, false, `pass ${pass} must defer, not fork`);
    counts = next;
    assert.equal(counts.n1, pass);
  }
  // The next stub-less 404 forks and clears the entry.
  const { fork, next } = recordUpdate404(counts, "n1", threshold);
  assert.equal(fork, true);
  assert.equal("n1" in next, false);
});

test("update 404: streaks are tracked per row, note or folder alike", async () => {
  const { recordUpdate404 } = await load();
  // The reducer is entity-agnostic: note and folder client ids share nothing.
  const { next } = recordUpdate404({ note1: 2 }, "folder1", 3);
  assert.deepEqual(next, { note1: 2, folder1: 1 });
});

test("update 404: clearing drops the streak, and is a no-op when untracked", async () => {
  const { clearUpdate404 } = await load();
  assert.deepEqual(clearUpdate404({ n1: 2, n2: 1 }, "n1"), { n2: 1 });
  const untracked = { n2: 1 };
  assert.equal(clearUpdate404(untracked, "n1"), untracked, "same reference when untracked");
});

// --- terminal error-code classification -------------------------------------
// The API's sync endpoints still emit legacy team_* names; canonical space_*
// names take over once the compatibility bridge is removed. Both families
// must classify identically or one side of the rollout retries forever.

test("access codes: legacy team_* and canonical space_* classify identically", async () => {
  const { isSpaceAccessErrorCode } = await load();
  const pairs = [
    ["team_not_found", "space_not_found"],
    ["team_access_revoked", "space_access_revoked"],
    ["team_archived", "space_archived"],
  ];
  for (const [legacy, canonical] of pairs) {
    assert.equal(isSpaceAccessErrorCode(legacy), true, legacy);
    assert.equal(isSpaceAccessErrorCode(canonical), true, canonical);
    assert.equal(isSpaceAccessErrorCode(legacy), isSpaceAccessErrorCode(canonical));
  }
});

test("access codes: unrelated and missing codes are not terminal", async () => {
  const { isSpaceAccessErrorCode } = await load();
  for (const code of [
    undefined,
    "",
    "note_version_conflict",
    "folder_name_taken",
    "note_access_denied",
    "space_full",
  ]) {
    assert.equal(isSpaceAccessErrorCode(code), false, String(code));
  }
});

test("denial codes: all three permission denials are terminal", async () => {
  const { isPermissionDenialCode } = await load();
  for (const code of ["note_access_denied", "note_scope_change_denied", "folder_access_denied"]) {
    assert.equal(isPermissionDenialCode(code), true, code);
  }
});

test("denial codes: access errors and unknown codes are not denials", async () => {
  const { isPermissionDenialCode } = await load();
  for (const code of [undefined, "", "team_access_revoked", "space_not_found", "denied"]) {
    assert.equal(isPermissionDenialCode(code), false, String(code));
  }
});

// --- shouldSetOwnerFromCloud -------------------------------------------------
// Ownership must fill independently of the last-write-wins upsert: an
// unchanged note (identical updated_at) skips the content upsert but still
// needs its owner, or pre-owner_user_id rows fail closed in the UI forever.

test("owner fill: fills a local row whose owner is missing or stale", async () => {
  const { shouldSetOwnerFromCloud } = await load();
  assert.equal(shouldSetOwnerFromCloud({ user_id: "u1" }, { owner_user_id: null }), true);
  assert.equal(shouldSetOwnerFromCloud({ user_id: "u1" }, { owner_user_id: undefined }), true);
  assert.equal(shouldSetOwnerFromCloud({ user_id: "u2" }, { owner_user_id: "u1" }), true);
});

test("owner fill: skips when already correct, no local row, or no cloud owner", async () => {
  const { shouldSetOwnerFromCloud } = await load();
  assert.equal(shouldSetOwnerFromCloud({ user_id: "u1" }, { owner_user_id: "u1" }), false);
  assert.equal(shouldSetOwnerFromCloud({ user_id: "u1" }, null), false);
  assert.equal(shouldSetOwnerFromCloud({ user_id: null }, { owner_user_id: null }), false);
  assert.equal(shouldSetOwnerFromCloud({}, { owner_user_id: null }), false);
});

test("owner fill: never fires on stubs or tombstones", async () => {
  const { shouldSetOwnerFromCloud } = await load();
  assert.equal(
    shouldSetOwnerFromCloud({ user_id: "u1", access_removed: true }, { owner_user_id: null }),
    false
  );
  assert.equal(
    shouldSetOwnerFromCloud({ user_id: "u1", deleted_at: "2026-01-01" }, { owner_user_id: null }),
    false
  );
});
