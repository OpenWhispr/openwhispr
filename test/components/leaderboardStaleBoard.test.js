const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const read = (relativePath) => readFileSync(join(__dirname, "../..", relativePath), "utf8");

// A page turn, metric change or week change asks the same board a different
// question. Blanking the card while the answer is in flight takes the podium,
// the table, the period picker, Share and the pagination control the user just
// clicked with it, then snaps it all back a moment later.
test("a board in flight keeps the previous answer on screen instead of blanking", () => {
  const section = read("src/components/LeaderboardSection.tsx");

  assert.ok(
    section.includes("leaderboard.scope.key === selectedScope.key"),
    "the board on screen is kept while the same scope reloads"
  );
  assert.ok(
    section.includes("const leaderboardStale ="),
    "the kept board has to be marked stale so it can be dimmed"
  );
  assert.ok(
    section.includes("aria-busy={leaderboardStale}"),
    "a dimmed board still has to announce that it is refreshing"
  );

  // The dim has to sit on an element that can actually take an opacity:
  // `display: contents` produces no box, so opacity on it is inert.
  const wrapper = section.slice(
    section.indexOf("aria-busy={leaderboardStale}"),
    section.indexOf("aria-busy={leaderboardStale}") + 240
  );
  assert.equal(
    wrapper.includes('"contents'),
    false,
    "display:contents draws no box, so it cannot carry the stale opacity"
  );
});

// The generic failure path leaves the previous board in state, so a guard of
// "no board" would let a failed page turn quietly render stale rows.
test("a failure still takes the surface even with a previous board on screen", () => {
  const section = read("src/components/LeaderboardSection.tsx");

  assert.ok(section.includes("const noFreshLeaderboard ="));
  assert.ok(section.includes('visibleFailure === "policy" && noFreshLeaderboard'));
  assert.ok(section.includes("visibleFailure && noFreshLeaderboard"));
  assert.equal(
    section.includes("visibleFailure && !visibleLeaderboard"),
    false,
    "a stale board does not answer the request that just failed"
  );
});

// useAuth keeps presenting a session whose refetch failed, so a signed-in user
// can hold a null validated generation indefinitely. Waiting on it forever is a
// spinner with no message and no way out.
test("a settled session with no validated credential offers a way out", () => {
  const section = read("src/components/LeaderboardSection.tsx");
  const view = read("src/components/LeaderboardView.tsx");

  assert.ok(section.includes("authSettled: boolean;"), "the section is told when auth settled");
  assert.ok(
    section.includes("setAccessLoading(!authSettled)"),
    "an unvalidated credential only reads as loading while the session is unsettled"
  );
  assert.ok(
    section.includes('setAccessError(authSettled ? "auth" : null)'),
    "once settled it becomes the retry surface, which already offers Sign in"
  );
  assert.ok(
    section.includes("[accountId, authGeneration, authSettled]"),
    "the loader has to re-run when the session settles"
  );
  assert.ok(view.includes("isLoaded: authSettled"), "useAuth's isLoaded is what settled means");
  assert.ok(view.includes("authSettled={authSettled}"));
});
