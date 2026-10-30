const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/stores/policyRules.ts");

const managed = (features, { minAppVersion = null, appVersion = "1.11.0" } = {}) => ({
  status: "managed",
  appVersion,
  policy: { minAppVersion, features },
});

test("a meeting refusal names the org's switch, an unresolved policy, or another restriction", async () => {
  const { meetingRecordingRefusal } = await load();
  for (const [state, expected] of [
    [{ status: "loading", policy: null, appVersion: "1.11.0" }, "unresolved"],
    [{ status: "error", policy: null, appVersion: "1.11.0" }, "unresolved"],
    [{ status: "managed", policy: null, appVersion: "1.11.0" }, "unresolved"],
    [managed({ meetingRecordingEnabled: false }), "disabled"],
    [managed({ meetingRecordingEnabled: false }, { minAppVersion: "2.0.0" }), "disabled"],
    [managed({ meetingRecordingEnabled: true }, { minAppVersion: "2.0.0" }), "restricted"],
    [managed({}), "restricted"],
  ]) {
    assert.equal(meetingRecordingRefusal(state), expected, JSON.stringify(state));
  }
});
