const test = require("node:test");
const assert = require("node:assert/strict");

test("space roster invalidation evicts cached successful fetches", async (t) => {
  const {
    fetchCachedSpaceRoster,
    invalidateSpaceRoster,
    readSpaceRosterVersion,
    subscribeSpaceRoster,
  } = await import("../../src/lib/spaceRosterCache.ts");
  let calls = 0;
  const load = async () => {
    calls += 1;
    return [{ user_id: `user-${calls}` }];
  };
  t.after(() => invalidateSpaceRoster());

  const first = await fetchCachedSpaceRoster("space-1", load);
  const cached = await fetchCachedSpaceRoster("space-1", load);
  assert.equal(calls, 1);
  assert.deepEqual(cached, first);

  let notifications = 0;
  const version = readSpaceRosterVersion("space-1");
  const unsubscribe = subscribeSpaceRoster("space-1", () => {
    notifications += 1;
  });
  t.after(unsubscribe);
  invalidateSpaceRoster("space-1");
  assert.equal(notifications, 1, "mounted consumers are notified");
  assert.equal(readSpaceRosterVersion("space-1"), version + 1);

  const refreshed = await fetchCachedSpaceRoster("space-1", load);
  assert.equal(calls, 2);
  assert.notDeepEqual(refreshed, first);
});
