const test = require("node:test");
const assert = require("node:assert/strict");

const en = require("../../src/locales/en/translation.json");

test("Clear History discloses that synced Insights are removed from the account", () => {
  const privacyCopy = en.settingsPage.privacy.insightsSyncDescription;
  const confirmationCopy = en.controlPanel.history.clearAllDescription;
  const signedOutConfirmationCopy = en.controlPanel.history.clearAllDescriptionDevice;

  for (const copy of [privacyCopy, confirmationCopy]) {
    assert.match(copy, /Insights|counters/);
    assert.match(copy, /account/);
  }
  assert.doesNotMatch(privacyCopy, /won't remove/);
  assert.match(signedOutConfirmationCopy, /device/);
  assert.match(signedOutConfirmationCopy, /not affected/);
});
