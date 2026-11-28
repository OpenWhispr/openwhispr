const test = require("node:test");
const assert = require("node:assert/strict");

let canSkipUpdate;
let isUpdateSkipped;

test.before(async () => {
  ({ canSkipUpdate, isUpdateSkipped } = await import("../../src/utils/skippedUpdate.ts"));
});

const available = (version, overrides = {}) => ({
  updateAvailable: true,
  updateDownloaded: false,
  isDownloading: false,
  isInstalling: false,
  version,
  ...overrides,
});

test("the skipped release stays hidden, and a newer one shows again", () => {
  assert.equal(isUpdateSkipped(available("1.12.3"), "1.12.3"), true);
  assert.equal(isUpdateSkipped(available("1.12.4"), "1.12.3"), false);
  assert.equal(isUpdateSkipped(available("1.12.3"), null), false);
});

test("a release with no version yet can't be skipped or hidden", () => {
  assert.equal(canSkipUpdate(available(undefined)), false);
  assert.equal(canSkipUpdate(available(null)), false);
  assert.equal(isUpdateSkipped(available(undefined), undefined), false);
});

// Settings can still download a skipped release; from then on the sidebar shows
// the download and the install like any other.
test("a skipped release that is downloading or downloaded keeps its button", () => {
  for (const state of [
    available("1.12.3", { isDownloading: true }),
    available("1.12.3", { updateDownloaded: true }),
    available("1.12.3", { updateDownloaded: true, isInstalling: true }),
  ]) {
    assert.equal(canSkipUpdate(state), false);
    assert.equal(isUpdateSkipped(state, "1.12.3"), false);
  }
});

test("skip is offered only for a release that is available and not started", () => {
  assert.equal(canSkipUpdate(available("1.12.3")), true);
  assert.equal(canSkipUpdate(available("1.12.3", { updateAvailable: false })), false);
});
