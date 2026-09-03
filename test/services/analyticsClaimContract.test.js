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
    hook.indexOf("const disableInsightsSync")
  );
  assert.equal(
    activate.includes("setParticipation"),
    false,
    "turning Insights sync on must not join a leaderboard"
  );
  assert.ok(hook.includes("const joinLeaderboard"));
  assert.ok(hook.includes("LeaderboardService.setParticipation(true)"));
  assert.ok(hook.includes("LeaderboardService.setParticipation(false)"));
  assert.ok(settings.includes("void disableInsightsSync()"));
  assert.equal(
    settings.includes("enabled ? enableInsightsSync() : setInsightsSyncEnabled(false)"),
    false,
    "Settings must not bypass the account-level opt-out"
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
    disable.indexOf("setInsightsSyncEnabled(false)") < disable.indexOf("setParticipation(false)"),
    "the local switch must go off before the account call, not after it succeeds"
  );
});
