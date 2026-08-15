const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/updateCheckPolicy.js");

test("the App updates toggle gates automatic checks, not just the popup", async () => {
  const { shouldAutoCheckForUpdates } = await load();

  // Regression guard for #1605: with the toggle off, the app kept hitting the
  // update feed at startup and every 4 hours, and offline machines surfaced
  // the resulting connection errors as dialogs when Settings opened.
  assert.equal(shouldAutoCheckForUpdates({ notifyUpdates: false }), false);
  assert.equal(
    shouldAutoCheckForUpdates({ notificationsEnabled: true, notifyUpdates: false }),
    false
  );
});

test("the master notifications switch also disables automatic checks", async () => {
  const { shouldAutoCheckForUpdates } = await load();

  assert.equal(
    shouldAutoCheckForUpdates({ notificationsEnabled: false, notifyUpdates: true }),
    false
  );
});

test("checks stay enabled by default before renderer prefs arrive", async () => {
  const { shouldAutoCheckForUpdates } = await load();

  // Same tri-state convention as the notification gate in updater.js: only an
  // explicit false disables; missing prefs keep check-by-default behavior.
  assert.equal(shouldAutoCheckForUpdates(undefined), true);
  assert.equal(shouldAutoCheckForUpdates({}), true);
  assert.equal(
    shouldAutoCheckForUpdates({ notificationsEnabled: true, notifyUpdates: true }),
    true
  );
});
