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

// Joining a leaderboard publishes a name and an email to teammates, so it is a
// consent of its own: syncing counters must never imply it, and the sync switch
// must take it back down when it goes off.
test("only an explicit join opts the account into a leaderboard", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const settings = read("src/components/SettingsPage.tsx");
  const activate = hook.slice(
    hook.indexOf("const activate"),
    hook.indexOf("const leaveLeaderboard")
  );
  assert.equal(
    activate.includes("setParticipation"),
    false,
    "turning Insights sync on must not join a leaderboard"
  );
  assert.ok(hook.includes("const joinLeaderboard"));
  assert.ok(hook.includes("LeaderboardService.setParticipation(true)"));
  assert.ok(hook.includes("LeaderboardService.setParticipation(false)"));
  assert.ok(settings.includes("disableInsightsSync()"));
  assert.equal(
    settings.includes("enabled ? enableInsightsSync() : setInsightsSyncEnabled(false)"),
    false,
    "Settings must not bypass the account-level opt-out"
  );
});

// The claim prompt can still decline the whole opt-in, and a declined opt-in is
// a join the user never agreed to — so the PATCH has to wait for the answer.
test("a join publishes the account only after the sync opt-in has landed", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const join = hook.slice(
    hook.indexOf("const joinLeaderboard"),
    hook.indexOf("const answerClaimPrompt")
  );
  assert.ok(
    join.indexOf("await enableInsightsSync()") < join.indexOf("setParticipation(true)"),
    "the account must not be published before the opt-in the join depends on"
  );
  assert.ok(
    join.includes("!(await enableInsightsSync())) return"),
    "a declined opt-in must abandon the join instead of publishing anyway"
  );
});

// Publishing a name and an email to colleagues has to be undoable where it is
// published, not only through a switch labelled Insights sync.
test("the leaderboard surface can leave without touching the sync switch", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const section = read("src/components/LeaderboardSection.tsx");
  const view = read("src/components/LeaderboardView.tsx");
  const leave = hook.slice(
    hook.indexOf("const leaveLeaderboard"),
    hook.indexOf("const disableInsightsSync")
  );
  assert.ok(leave.includes("LeaderboardService.setParticipation(false)"));
  assert.equal(
    leave.includes("setInsightsSyncEnabled"),
    false,
    "leaving a leaderboard must not be entangled with the device sync switch"
  );
  assert.ok(section.includes('t("insights.leaderboard.leave")'));
  assert.ok(section.includes("onLeave()"));
  // The device toggle is per device and can be off while the account row still
  // says joined — gating on it would hide Leave from an account that is ranked.
  assert.ok(
    view.includes("participating={isSignedIn && syncAllowedByPolicy && participationEnabled}")
  );
  // The toggle may still be read as a re-read trigger, but it must never reach
  // the section: that is what would hide Leave from an account that is ranked.
  assert.equal(
    view.slice(view.indexOf("<LeaderboardSection")).includes("insightsSyncEnabled"),
    false,
    "the leaderboard must follow the account's participation, not this device's sync toggle"
  );
  // Settings owns its own copy of the hook, so its opt-out cannot reach this
  // view's participation state on its own — the shared toggle is the signal.
  assert.ok(
    view.includes("[insightsSyncEnabled, refreshParticipation]"),
    "flipping the device toggle off must re-read the account instead of leaving a roster up"
  );
});

// An opt-out that waits on the network is one the user loses when it is down.
test("turning Insights sync off stops the device before it calls the account", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const disable = hook.slice(
    hook.indexOf("const disableInsightsSync"),
    hook.indexOf("const refreshUnclaimedCount")
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
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const refresh = hook.slice(
    hook.indexOf("const refreshParticipation"),
    hook.indexOf("const activate")
  );
  assert.ok(
    refresh.slice(refresh.indexOf("} catch")).includes("setParticipationEnabled(false)"),
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
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const section = read("src/components/LeaderboardSection.tsx");
  const refresh = hook.slice(
    hook.indexOf("const refreshParticipation"),
    hook.indexOf("const publishParticipationAnswer")
  );
  assert.ok(refresh.includes('setParticipationError("read")'));
  const card = section.slice(
    section.indexOf("if (!participating || !participationReady)"),
    section.indexOf('t("insights.leaderboard.join")')
  );
  assert.ok(card.includes('participationError === "read"'));
  assert.ok(card.includes("onRetry={onRefreshParticipation}"));
  assert.ok(
    card.indexOf("LeaderboardRetryCard") < card.indexOf("onJoin"),
    "the retry has to return before the Join button is ever reached"
  );
});

// An opt-out the network refused is still an opt-out. It holds on the device
// and is retried against the account until it lands -- only ever leaving, since
// an automatic join would let one device's preference publish the account.
test("a leave the account never took is kept and retried until it does", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const service = read("src/services/LeaderboardService.ts");
  const leave = hook.slice(
    hook.indexOf("const leaveLeaderboard"),
    hook.indexOf("const disableInsightsSync")
  );
  assert.ok(leave.includes("writePendingLeaderboardLeave(userId)"));
  assert.ok(
    leave.includes("publishParticipationAnswer(false)"),
    "a pending leave must stop showing the user as participating"
  );
  const join = hook.slice(
    hook.indexOf("const joinLeaderboard"),
    hook.indexOf("const answerClaimPrompt")
  );
  assert.ok(
    join.indexOf("clearPendingLeaderboardLeave(userId)") >
      join.indexOf("await enableInsightsSync()"),
    "a declined opt-in never joins, so the leave it stopped short of must survive"
  );
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
});

// The sync toggle re-reads participation, and joining flips that toggle — so a
// join fires a read of its own right after the write goes out. The write is the
// newer answer whatever order the two land in, so it has to retire that read.
test("a completed participation write outranks every read still in flight", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const publish = hook.slice(
    hook.indexOf("const publishParticipationAnswer"),
    hook.indexOf("const activate")
  );
  assert.ok(
    publish.indexOf("participationReadIdRef.current += 1") <
      publish.indexOf("setParticipationEnabled("),
    "a read started before the write must be retired before the answer is published"
  );
  assert.ok(
    publish.includes("setParticipationReady(true)"),
    "the retired read never reports itself finished, so the write has to"
  );
  for (const [name, end] of [
    ["const joinLeaderboard", "const answerClaimPrompt"],
    ["const leaveLeaderboard", "const disableInsightsSync"],
  ]) {
    assert.ok(
      hook.slice(hook.indexOf(name), hook.indexOf(end)).includes("publishParticipationAnswer("),
      `${name} must publish through the path that retires in-flight reads`
    );
  }
});

// Signed out there is no account row to clear, and the PATCH could only fail
// for want of a credential.
test("opting out while signed out stops at the device", () => {
  const hook = read("src/hooks/useInsightsSyncOptIn.tsx");
  const disable = hook.slice(
    hook.indexOf("const disableInsightsSync"),
    hook.indexOf("const refreshUnclaimedCount")
  );
  assert.ok(
    disable.indexOf("if (!isSignedIn) return true;") < disable.indexOf("leaveLeaderboard()"),
    "a signed-out opt-out must not call the account endpoint"
  );
});
