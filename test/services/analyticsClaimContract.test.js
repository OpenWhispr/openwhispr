const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");

test("syncing analytics never adopts unattributed counters", () => {
  assert.equal(
    read("src/services/AnalyticsService.ts").includes("claimAnonymousAnalyticsEvents"),
    false,
    "the sync path must never assign one account's local counters to another"
  );
});

test("the explicit Insights prompt is the one path that claims local counters", () => {
  assert.ok(read("src/hooks/useInsightsSyncOptIn.tsx").includes("claimAnonymousAnalyticsEvents"));
});

test("the Insights view uses the shared predicate for the claim offer", () => {
  const view = read("src/components/InsightsView.tsx");
  assert.ok(view.includes("canOfferAnalyticsClaim({"));
  assert.equal(
    view.includes("!insightsSyncEnabled &&"),
    false,
    "sync left on across sign-out must not strand later unattributed counters"
  );
});

test("Insights Sync and leaderboard participation have separate owners", () => {
  const syncHook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const participationHook = read("src/hooks/useLeaderboardParticipation.ts");
  const settings = read("src/components/SettingsPage.tsx");
  const leaderboard = read("src/components/LeaderboardView.tsx");

  assert.ok(syncHook.includes("const enableInsightsSync"));
  assert.ok(syncHook.includes("const disableInsightsSync"));
  assert.equal(syncHook.includes("LeaderboardParticipation"), false);
  assert.equal(syncHook.includes("joinParticipation"), false);
  assert.equal(syncHook.includes("leaveParticipation"), false);

  assert.ok(participationHook.includes("store.join(context)"));
  assert.ok(participationHook.includes("store.leave(context)"));
  assert.equal(participationHook.includes("setInsightsSyncEnabled"), false);

  assert.ok(settings.includes("if (enabled) void enableInsightsSync()"));
  assert.ok(settings.includes("disableInsightsSync()"));
  assert.equal(settings.includes("useLeaderboardParticipation"), false);
  assert.ok(leaderboard.includes("useLeaderboardParticipation()"));
});

test("joining obtains explicit analytics consent first without rollback coupling", () => {
  const view = read("src/components/LeaderboardView.tsx");
  const joinStart = view.indexOf("const joinLeaderboard");
  const join = view.slice(joinStart, view.indexOf("return (", joinStart));
  assert.match(
    join,
    /!insightsSyncEnabled\s*&&\s*!\(await enableInsightsSync\(\{ confirmWhenEmpty: true \}\)\)/
  );
  assert.ok(
    join.indexOf("await enableInsightsSync({") < join.indexOf("joinParticipation()"),
    "analytics consent must land before the account is published"
  );
  assert.equal(
    join.includes("disableInsightsSync"),
    false,
    "a failed participation write must preserve accepted analytics consent"
  );
});

test("enabling sync with no queued rows needs no empty-data prompt", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const enable = hook.slice(
    hook.indexOf("const enableInsightsSync"),
    hook.indexOf("const claiming")
  );
  assert.ok(enable.includes("if (pending === 0 && !options.confirmWhenEmpty)"));
  assert.ok(enable.includes("prepareInsightsSync(false"));
  assert.ok(
    enable.indexOf("if (pending === 0 && !options.confirmWhenEmpty)") <
      enable.indexOf("requestInsightsConsent({"),
    "an empty sync must finish before the data-upload prompt is requested"
  );
});

test("joining cannot silently turn on future Insights uploads when the queue is empty", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const leaderboard = read("src/components/LeaderboardView.tsx");
  assert.ok(hook.includes("confirmWhenEmpty?: boolean"));
  assert.ok(hook.includes("pending === 0 && !options.confirmWhenEmpty"));
  assert.ok(leaderboard.includes("enableInsightsSync({ confirmWhenEmpty: true })"));
});

test("an account switch cancels pending Insights consent", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const accountEffect = hook.slice(
    hook.indexOf("if (promptAccountIdRef.current === userId) return"),
    hook.indexOf("const owner = consentOwnerRef.current")
  );
  assert.ok(accountEffect.includes("cancelInsightsConsent(consentOwnerRef.current)"));
  assert.ok(hook.includes("promptAccountIdRef.current !== requestedAccountId"));
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
  assert.ok(database.includes("accountId !== this.activeAccountId"));
});

test("leaving the leaderboard changes participation only", () => {
  const syncHook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const participationHook = read("src/hooks/useLeaderboardParticipation.ts");
  const section = read("src/components/LeaderboardSection.tsx");
  const view = read("src/components/LeaderboardView.tsx");

  assert.ok(participationHook.includes("return store.leave(context)"));
  assert.equal(participationHook.includes("setInsightsSyncEnabled"), false);
  assert.equal(syncHook.includes("leaveParticipation"), false);
  assert.ok(view.includes("onLeave={leaveParticipation}"));
  assert.ok(section.includes('t("insights.leaderboard.leave")'));
  assert.ok(section.includes("onLeave()"));
  assert.ok(view.includes("participating={isSignedIn && participationEnabled}"));
  assert.equal(
    view.slice(view.indexOf("<LeaderboardSection")).includes("participating={insightsSyncEnabled}"),
    false
  );
});

test("turning Insights Sync off never calls the account participation endpoint", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const disable = hook.slice(
    hook.indexOf("const disableInsightsSync"),
    hook.indexOf("const refreshCounts")
  );
  assert.ok(disable.includes("setInsightsSyncEnabled(false)"));
  assert.equal(disable.includes("Leaderboard"), false);
  assert.equal(disable.includes("leave"), false);
});

test("a failed participation read cannot leave the board looking joined", () => {
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const refresh = store.slice(store.indexOf("refresh: async"), store.indexOf("join: async"));
  assert.ok(refresh.slice(refresh.indexOf("} catch")).includes("enabled: false"));
  assert.equal(refresh.includes("setParticipation("), false);
  assert.ok(refresh.includes("LeaderboardService.flushPendingLeave(context)"));
});

test("an unknown participation answer offers retry instead of Join", () => {
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const section = read("src/components/LeaderboardSection.tsx");
  const refresh = store.slice(store.indexOf("refresh: async"), store.indexOf("join: async"));
  assert.ok(refresh.includes('error: "read"'));
  const retrySurface = section.slice(
    section.indexOf('if (surface === "participation_error")'),
    section.indexOf('if (surface === "participation_loading")')
  );
  const joinSurface = section.slice(
    section.indexOf('if (surface === "join")'),
    section.indexOf("const number =")
  );
  assert.ok(retrySurface.includes("onRetry={onRefreshParticipation}"));
  assert.equal(retrySurface.includes("onJoin"), false);
  assert.ok(joinSurface.includes("onJoin={onJoin}"));
});

test("an undelivered leave is durable and retried without gating analytics", () => {
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const service = read("src/services/LeaderboardService.ts");
  const sync = read("src/services/SyncService.ts");
  const leave = store.slice(store.indexOf("leave: async"));
  const serviceLeave = service.slice(
    service.indexOf("async function leaveParticipation"),
    service.indexOf("async function flushPendingLeave")
  );
  assert.ok(service.includes("writePendingLeaderboardLeave(userId)"));
  assert.ok(
    serviceLeave.indexOf("writePendingLeaderboardLeave(userId)") <
      serviceLeave.indexOf("serializeParticipationOperation(context")
  );
  assert.ok(leave.includes("publishAnswer(false, true, generation)"));
  const flush = service.slice(
    service.indexOf("async function flushPendingLeave"),
    service.indexOf("async function getAccess")
  );
  assert.ok(flush.includes("setParticipation(false, authGeneration)"));
  assert.equal(flush.includes("setParticipation(true,"), false);
  assert.ok(sync.includes("LeaderboardService.flushPendingLeave("));
  assert.ok(sync.includes("pendingLeaderboardLeave"));
  assert.equal(sync.includes("LeaderboardService.getParticipation("), false);
});

test("an ambiguous join is compensated without racing a newer account choice", () => {
  const hook = read("src/hooks/useLeaderboardParticipation.ts");
  const service = read("src/services/LeaderboardService.ts");
  const serviceJoin = service.slice(
    service.indexOf("async function joinParticipation"),
    service.indexOf("async function leaveParticipation")
  );
  assert.ok(serviceJoin.includes("serializeParticipationOperation(context"));
  assert.ok(serviceJoin.includes("writePendingLeaderboardLeave(userId)"));
  assert.ok(
    serviceJoin.indexOf("writePendingLeaderboardLeave(userId)") < serviceJoin.indexOf("throw error")
  );
  const hookJoin = hook.slice(hook.indexOf("const join"), hook.indexOf("const leave"));
  assert.ok(
    hookJoin.indexOf("writePendingLeaderboardLeave(userId)") > hookJoin.indexOf("const joined =")
  );
});

test("a completed participation write outranks reads already in flight", () => {
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const publish = store.slice(
    store.indexOf("publishAnswer: (enabled, configured, generation)"),
    store.indexOf("refresh: async")
  );
  assert.ok(publish.indexOf("readId += 1") < publish.indexOf("set({ enabled"));
  assert.ok(publish.includes("ready: true"));
  for (const [name, end] of [
    ["join: async", "leave: async"],
    ["leave: async", ""],
  ]) {
    assert.ok(
      store
        .slice(store.indexOf(name), end ? store.indexOf(end) : undefined)
        .includes("publishAnswer(")
    );
  }
});

test("every leaderboard surface reads one shared participation source", () => {
  const hook = read("src/hooks/useLeaderboardParticipation.ts");
  const syncHook = read("src/hooks/useInsightsSyncOptIn.tsx");
  for (const field of ["enabled", "ready", "error", "updating"]) {
    assert.ok(hook.includes(`(state) => state.${field}`));
  }
  assert.equal(/useState[^\n]*[Pp]articipation/.test(hook), false);
  assert.equal(syncHook.includes("useLeaderboardParticipationStore"), false);
  assert.equal(hook.includes("participationReadIdRef"), false);
});

test("a participation read defers to a write already in flight", () => {
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const refresh = store.slice(store.indexOf("refresh: async"), store.indexOf("join: async"));
  assert.ok(refresh.indexOf("if (get().updating) return;") < refresh.indexOf("++readId"));
});

test("an account scope purge drops only the cached participation answer", () => {
  const auth = read("src/hooks/useAuth.ts");
  const store = read("src/stores/leaderboardParticipationStore.ts");
  const purge = auth.slice(
    auth.indexOf("if (accountScopeRequiresPurge(resolvedUserId)) {"),
    auth.indexOf("if (accountScopeRequiresReconciliation(resolvedUserId)) {")
  );
  assert.ok(purge.includes("useLeaderboardParticipationStore.getState().reset()"));
  const reset = store.slice(
    store.indexOf("reset: () => {"),
    store.indexOf("publishAnswer: (enabled, configured, generation)")
  );
  assert.ok(reset.includes("readId += 1"));
  assert.equal(/PendingLeaderboardLeave/.test(reset), false);
});
