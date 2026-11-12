const test = require("node:test");
const assert = require("node:assert/strict");
const { createManagedMeetingPolicy } = require("../../src/helpers/managedMeetingPolicy");
const { normalizeDeviceValues } = require("../../src/helpers/managedDevicePolicy");

test("meeting denial uses the trusted device snapshot on every platform", () => {
  let snapshot = normalizeDeviceValues({});
  const policy = createManagedMeetingPolicy({ getSnapshot: () => snapshot });
  assert.equal(policy.isMeetingRecordingDisabled(), false);
  snapshot = normalizeDeviceValues({ DisableMeetingRecording: true });
  assert.equal(policy.isMeetingRecordingDisabled(), true);
  snapshot = normalizeDeviceValues({ DisableMeetingRecording: false });
  assert.equal(policy.isMeetingRecordingDisabled(), false);
});

test("unresolved and malformed trusted policy deny capture", () => {
  for (const status of ["loading", "invalid"]) {
    const policy = createManagedMeetingPolicy({ getSnapshot: () => ({ status }) });
    assert.equal(policy.isMeetingRecordingDisabled(), true);
  }
});

test("unforced personal defaults cannot activate device management", () => {
  const policy = createManagedMeetingPolicy({
    platform: "darwin",
    getUserDefault: () => true,
    getSnapshot: () => ({ status: "absent", managed: false, policy: null }),
  });
  assert.equal(policy.isMeetingRecordingDisabled(), false);
});
