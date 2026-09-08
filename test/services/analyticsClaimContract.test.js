const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");

// Adopting unattributed counters is a consent decision, not a sync step. The
// device-local rows carry no account precisely because nobody was signed in
// when they were spoken, and insightsSyncEnabled is device-scoped and survives
// sign-out while sign-out clears only isSignedIn. A claim inside the sync path
// therefore reads as: user A signs out, dictates, user B signs in, and B's
// first pass uploads A's counters into B's account -- unrevocably, since this
// client never calls the cloud's analytics delete route. The claim must stay
// where the user is actually asked (useInsightsSyncOptIn's dialog).
test("syncing analytics never adopts unattributed counters", () => {
  assert.equal(
    read("src/services/AnalyticsService.ts").includes("claimAnonymousAnalyticsEvents"),
    false,
    "the sync path must never claim rows: it would move one account's counters into another"
  );
});

test("the opt-in dialog is still the one path that claims them", () => {
  assert.ok(
    read("src/hooks/useInsightsSyncOptIn.tsx").includes("claimAnonymousAnalyticsEvents"),
    "the explicit claim prompt still owns adoption"
  );
});

// Source-contract pin: the banner has no unit-testable seam of its own (this
// suite has no React harness), so this pins that the view asks the predicate
// instead of re-deriving the gate from the sync toggle -- which is what left
// counters recorded while signed out unclaimable.
test("the Insights view asks the predicate whether to offer the claim", () => {
  const view = read("src/components/InsightsView.tsx");
  assert.ok(
    view.includes("canOfferAnalyticsClaim({"),
    "the banner gate must come from canOfferAnalyticsClaim"
  );
  assert.equal(
    view.includes("!insightsSyncEnabled &&"),
    false,
    "gating the offer on the toggle alone strands counters recorded while signed out"
  );
});

// The product exposes one opt-in for analytics sync and leaderboard
// participation. It still has to sequence the upload consent before publishing
// the account, and the Settings toggle must use that same combined path.
test("one explicit opt-in enables analytics and leaderboard participation", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const settings = read("src/components/SettingsPage.tsx");
  assert.ok(hook.includes("const joinLeaderboard"));
  assert.ok(store.includes("LeaderboardService.setParticipation(true)"));
  assert.ok(store.includes("LeaderboardService.setParticipation(false)"));
  assert.ok(settings.includes("if (enabled) void joinLeaderboard()"));
  assert.ok(settings.includes("disableInsightsSync()"));
  assert.equal(
    settings.includes("enableInsightsSync"),
    false,
    "Settings must not expose an analytics-only enable path"
  );
});

// Consent comes first, then participation, then local uploads. This order keeps
// either failure from leaving only one half of the combined preference on.
test("a join enables sync only after leaderboard participation succeeds", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const join = hook.slice(
    hook.indexOf("const joinLeaderboard"),
    hook.indexOf("const answerClaimPrompt")
  );
  assert.ok(
    join.indexOf("await confirmInsightsSync()") < join.indexOf(".join(requestedAccountId)"),
    "the account must not be published before the user accepts the upload"
  );
  assert.ok(
    join.includes("!(await confirmInsightsSync())) return"),
    "a declined opt-in must abandon the join instead of publishing anyway"
  );
  assert.equal(
    join.includes("!insightsSyncEnabled &&"),
    false,
    "an already-enabled device must still offer newly backfilled anonymous history"
  );
  assert.ok(
    join.indexOf(".join(requestedAccountId)") < join.indexOf("setInsightsSyncEnabled(true)"),
    "local uploads must stay off until leaderboard participation succeeds"
  );
  const failedJoin = join.slice(join.indexOf("if (!joined) {"), join.indexOf("const claiming"));
  assert.ok(
    failedJoin.includes("promptAccountIdRef.current === requestedAccountId") &&
      failedJoin.includes("getValidatedAuthGeneration() === requestedAuthGeneration"),
    "only the account that requested the join may change this device's preference"
  );
  assert.ok(
    failedJoin.indexOf("setInsightsSyncEnabled(false)") >
      failedJoin.indexOf("promptAccountIdRef.current === requestedAccountId"),
    "a current account's failed join must restore the combined preference to off"
  );
});

test("a zero-history join still asks before publishing the account profile", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const confirm = hook.slice(
    hook.indexOf("const confirmInsightsSync"),
    hook.indexOf("const joinLeaderboard")
  );
  assert.equal(
    confirm.includes("if (pending === 0)"),
    false,
    "no queued counters does not remove the name-and-email disclosure"
  );
  assert.ok(confirm.includes("requestInsightsConsent({"));
  assert.ok(confirm.includes("prepareInsightsSync(pending > 0"));
});

// The prompt can outlive the account that opened it. Accepting it after an
// account switch must not claim counters or publish the replacement account.
test("an account switch cancels a pending Insights consent and leaderboard join", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const accountEffect = hook.slice(
    hook.indexOf("if (promptAccountIdRef.current === userId) return"),
    hook.indexOf("// Resolves once the opt-in has settled")
  );
  assert.ok(accountEffect.includes("cancelInsightsConsent(consentOwnerRef.current)"));
  assert.ok(hook.includes("promptAccountIdRef.current !== requestedAccountId"));
  const join = hook.slice(hook.indexOf("const joinLeaderboard"), hook.indexOf("const claiming"));
  assert.ok(join.includes("promptAccountIdRef.current !== requestedAccountId"));
  assert.ok(
    join.indexOf("promptAccountIdRef.current !== requestedAccountId") <
      join.indexOf(".join(requestedAccountId)"),
    "the captured account must still be current before the participation write starts"
  );
});

test("claiming anonymous Insights is bound to the consenting auth context", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const preload = read("preload.js");
  const handlers = read("src/helpers/ipcHandlers.js");
  const database = read("src/helpers/database.js");
  assert.match(
    hook,
    /\.claimAnonymousAnalyticsEvents\(\s*expectedAccountId,\s*expectedAuthGeneration\s*\)/
  );
  assert.ok(hook.includes("getValidatedAuthGeneration() !== expectedAuthGeneration"));
  assert.ok(preload.includes('"analytics-claim-anonymous", accountId, expectedAuthGeneration'));
  assert.ok(handlers.includes("state.generation !== expectedAuthGeneration"));
  assert.ok(
    database.includes("accountId !== this.activeAccountId"),
    "the database mutation must reject a claim aimed at a departed account"
  );
});

// The opt-out remains available on the leaderboard, but it is the same combined
// transition as the Settings switch: stop local uploads, then leave the account.
test("leaving from the leaderboard disables sync and participation together", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const section = read("src/components/LeaderboardSection.tsx");
  const view = read("src/components/LeaderboardView.tsx");
  const disable = hook.slice(
    hook.indexOf("const disableInsightsSync"),
    hook.indexOf("const refreshCounts")
  );
  assert.ok(store.slice(store.indexOf("leave: async")).includes("setParticipation(false)"));
  assert.ok(
    disable.indexOf("setInsightsSyncEnabled(false)") < disable.indexOf("leaveLeaderboard()"),
    "the device must stop uploading before the account leave is attempted"
  );
  assert.ok(view.includes("onLeave={disableInsightsSync}"));
  assert.ok(section.includes('t("insights.leaderboard.leave")'));
  assert.ok(section.includes("onLeave()"));
  // Device settings and managed policy can be off while the account row still
  // says joined. Neither may hide Leave from an account that is still ranked.
  assert.ok(view.includes("participating={isSignedIn && participationEnabled}"));
  assert.ok(view.includes("cloudAccessAllowed={syncAllowedByPolicy}"));
  assert.ok(
    section.indexOf('surface === "board" && !cloudAccessAllowed ?') <
      section.indexOf("!visibleLeaderboard ?"),
    "a managed policy change must hide cached roster data without hiding Leave"
  );
  // The account answer still controls whether the roster and its opt-out are
  // visible, including while an offline leave is waiting to reach the API.
  assert.equal(
    view.slice(view.indexOf("<LeaderboardSection")).includes("insightsSyncEnabled"),
    false,
    "the leaderboard must follow the account's participation, not this device's sync toggle"
  );
  assert.ok(
    hook.includes("participationEnabled ||") && hook.includes("setInsightsSyncEnabled(false)"),
    "a confirmed server-side leave must reconcile local sync to off"
  );
});

// An opt-out that waits on the network is one the user loses when it is down.
test("turning Insights sync off stops the device before it calls the account", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const disable = hook.slice(
    hook.indexOf("const disableInsightsSync"),
    hook.indexOf("const refreshCounts")
  );
  assert.ok(
    disable.indexOf("setInsightsSyncEnabled(false)") < disable.indexOf("leaveLeaderboard()"),
    "the local switch must go off before the account call, not after it succeeds"
  );
});

// The leaderboard's 403 recovery re-reads participation. A failed read that kept
// the last answer would leave the board looking joined, re-issue the same load,
// take the same 403 and re-read again — an unbounded loop against two endpoints.
test("a participation read that fails cannot leave the board looking joined", () => {
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const refresh = store.slice(store.indexOf("refresh: async"), store.indexOf("join: async"));
  assert.ok(
    refresh.slice(refresh.indexOf("} catch")).includes("enabled: false"),
    "an unknown answer must fail closed rather than keep the stale one"
  );
  assert.equal(
    refresh.includes("setParticipation("),
    false,
    "reading participation must never write it back to the account"
  );
  // The one write the read may make is the leave the user already asked for,
  // and flushPendingLeave can only send `false` (see leaderboardService.test).
  assert.ok(
    refresh.includes("LeaderboardService.flushPendingLeave(userId)"),
    "an undelivered opt-out must land before the read reports the account joined"
  );
});

// A failed read leaves participation unknown, and offering Join there asks an
// account that may already be on this leaderboard to publish itself again.
test("an unknown participation answer offers a retry instead of a join", () => {
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const section = read("src/components/LeaderboardSection.tsx");
  const refresh = store.slice(store.indexOf("refresh: async"), store.indexOf("join: async"));
  assert.ok(refresh.includes('error: "read"'));
  const retrySurface = section.slice(
    section.indexOf('if (surface === "participation_error")'),
    section.indexOf('if (surface === "participation_loading")')
  );
  const syncSurface = section.slice(
    section.indexOf('if (surface === "sync")'),
    section.indexOf("const number =")
  );
  assert.ok(section.includes("resolveLeaderboardSurface"));
  assert.ok(retrySurface.includes("onRetry={onRefreshParticipation}"));
  assert.ok(
    section.indexOf('if (surface === "participation_error")') <
      section.indexOf('if (surface === "sync")'),
    "the retry surface has to return before the sync action is reached"
  );
  assert.equal(retrySurface.includes("onJoin"), false);
  assert.equal(syncSurface.includes("onEnable"), false);
});

// An opt-out the network refused is still an opt-out. It holds on the device
// and is retried against the account until it lands -- only ever leaving, since
// an automatic join would let one device's preference publish the account.
test("a leave the account never took is kept and retried until it does", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const service = read("src/services/LeaderboardService.ts");
  const leave = store.slice(store.indexOf("leave: async"));
  assert.ok(leave.includes("writePendingLeaderboardLeave(userId)"));
  assert.ok(
    leave.includes("publishAnswer(false, true, generation)"),
    "a pending leave must stop showing the user as participating"
  );
  const hookJoin = hook.slice(
    hook.indexOf("const joinLeaderboard"),
    hook.indexOf("const answerClaimPrompt")
  );
  assert.ok(
    hookJoin.indexOf(".join(requestedAccountId)") > hookJoin.indexOf("await confirmInsightsSync()"),
    "a declined opt-in never joins, so the leave it stopped short of must survive"
  );
  const join = store.slice(store.indexOf("join: async"), store.indexOf("leave: async"));
  assert.ok(
    join.indexOf("clearPendingLeaderboardLeave(userId)") < join.indexOf("setParticipation(true)"),
    "an explicit join is the account's newest answer, and retiring the leave only after the join lands lets the read the sync toggle fires flush it into a PATCH racing that join"
  );
  const flush = service.slice(
    service.indexOf("async function flushPendingLeave"),
    service.indexOf("async function getAccess")
  );
  assert.ok(flush.includes("setParticipation(false)"));
  assert.equal(flush.includes("setParticipation(true)"), false, "the retry may only leave");
  assert.ok(
    read("src/services/SyncService.ts").includes("LeaderboardService.flushPendingLeave("),
    "every sync pass has to retry it, so the opt-out outlives the window that made it"
  );
  assert.ok(
    read("src/services/SyncService.ts").includes("pendingLeaderboardLeave"),
    "a queued opt-out must bypass ambient backoff on the next sync trigger"
  );
});

test("an ambiguous join is compensated without racing a newer account choice", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const join = store.slice(store.indexOf("join: async"), store.indexOf("leave: async"));
  assert.ok(join.includes("serializeAccountWrite(userId"));
  assert.ok(join.includes("writePendingLeaderboardLeave(userId)"));
  assert.ok(
    join.indexOf("writePendingLeaderboardLeave(userId)") < join.indexOf("throw error"),
    "the rollback marker must be written before the next same-account write starts"
  );
  const hookJoin = hook.slice(
    hook.indexOf("const joinLeaderboard"),
    hook.indexOf("const claiming")
  );
  assert.ok(
    hookJoin.indexOf("writePendingLeaderboardLeave(requestedAccountId)") >
      hookJoin.indexOf("const joined ="),
    "only a join that may have landed needs post-auth-change compensation"
  );
});

// The sync toggle re-reads participation, and joining flips that toggle — so a
// join fires a read of its own right after the write goes out. The write is the
// newer answer whatever order the two land in, so it has to retire that read.
test("a completed participation write outranks every read still in flight", () => {
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const publish = store.slice(
    store.indexOf("publishAnswer: (enabled, configured, generation)"),
    store.indexOf("refresh: async")
  );
  assert.ok(
    publish.indexOf("readId += 1") < publish.indexOf("set({ enabled"),
    "a read started before the write must be retired before the answer is published"
  );
  assert.ok(
    publish.includes("ready: true"),
    "the retired read never reports itself finished, so the write has to"
  );
  for (const [name, end] of [
    ["join: async", "leave: async"],
    ["leave: async", ""],
  ]) {
    assert.ok(
      store
        .slice(store.indexOf(name), end ? store.indexOf(end) : undefined)
        .includes("publishAnswer("),
      `${name} must publish through the path that retires in-flight reads`
    );
  }
});

// Settings and Insights can each mount this hook, so participation cannot live
// in it: an opt-out taken behind the Settings modal has to reach the page
// rendered under it, including when the leave fails and is only queued.
test("every surface reads one participation source, not a copy per hook instance", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  for (const field of ["Configured", "Enabled", "Ready", "Error", "Updating"]) {
    assert.ok(
      hook.includes(`const participation${field} = useLeaderboardParticipationStore(`),
      `participation${field} must come from the shared store`
    );
  }
  assert.equal(
    /useState[^\n]*[Pp]articipation/.test(hook),
    false,
    "a per-instance copy is what left one surface showing a roster the other had left"
  );
  assert.ok(
    hook.includes("!participationConfigured ||"),
    "an unconfigured account must keep its pre-leaderboard Insights preference"
  );
  assert.equal(
    hook.includes("participationReadIdRef"),
    false,
    "the read-id guard has to be shared too, or a write only retires its own instance's reads"
  );
});

// Turning the sync switch off flips insightsSyncEnabled synchronously, which
// fires the leaderboard's re-read while the leave PATCH is still in flight. The
// read has to defer to the write rather than report the row it is changing.
test("a participation read defers to a write already in flight", () => {
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const refresh = store.slice(store.indexOf("refresh: async"), store.indexOf("join: async"));
  assert.ok(
    refresh.indexOf("if (get().updating) return;") < refresh.indexOf("++readId"),
    "the write in flight is the newer answer, so the read must not even take an id"
  );
});

// Signed out there is no account row to clear, and the PATCH could only fail
// for want of a credential.
test("opting out while signed out stops at the device", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const disable = hook.slice(
    hook.indexOf("const disableInsightsSync"),
    hook.indexOf("const refreshCounts")
  );
  assert.ok(
    disable.indexOf("if (!isSignedIn) return true;") < disable.indexOf("leaveLeaderboard()"),
    "a signed-out opt-out must not call the account endpoint"
  );
});

// The store is module-level, so an account leaving the app has to take its
// answer with it. Clearing it only from the leaderboard's own read would leave
// the previous account's answer standing whenever that view was never opened.
test("an account scope purge drops the participation answer with the rest of the account", () => {
  const auth = read("src/hooks/useAuth.ts");
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const purge = auth.slice(
    auth.indexOf("if (accountScopeRequiresPurge(resolvedUserId)) {"),
    auth.indexOf("if (accountScopeRequiresReconciliation(resolvedUserId)) {")
  );
  assert.ok(
    purge.includes("useLeaderboardParticipationStore.getState().reset()"),
    "sign-out and account switch must drop the departing account's participation"
  );
  const reset = store.slice(
    store.indexOf("reset: () => {"),
    store.indexOf("publishAnswer: (enabled, configured, generation)")
  );
  assert.ok(
    reset.includes("readId += 1"),
    "a read still in flight for the previous account must not land on the next one"
  );
  assert.equal(
    /PendingLeaderboardLeave/.test(reset),
    false,
    "the opt-out queued against that account survives the purge so it can still be delivered"
  );
});
