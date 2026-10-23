const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createManagedMeetingPolicy,
  DISABLE_MEETING_RECORDING_KEY,
} = require("../../src/helpers/managedMeetingPolicy.js");

function policyWith(platform, value) {
  const reads = [];
  const policy = createManagedMeetingPolicy({
    platform,
    getUserDefault: (key, type) => {
      reads.push([key, type]);
      return value;
    },
  });
  return { policy, reads };
}

test("a managed true disables meeting recording on macOS", () => {
  const { policy, reads } = policyWith("darwin", true);
  assert.equal(policy.isMeetingRecordingDisabled(), true);
  assert.deepEqual(reads, [[DISABLE_MEETING_RECORDING_KEY, "boolean"]]);
});

test("an unset or false key leaves meeting recording available", () => {
  // getUserDefault returns false for a missing boolean key.
  assert.equal(policyWith("darwin", false).policy.isMeetingRecordingDisabled(), false);
});

test("other platforms never read user defaults", () => {
  for (const platform of ["win32", "linux"]) {
    const { policy, reads } = policyWith(platform, true);
    assert.equal(policy.isMeetingRecordingDisabled(), false, platform);
    assert.deepEqual(reads, [], platform);
  }
});

test("the key is read again on every check", () => {
  let value = false;
  const policy = createManagedMeetingPolicy({
    platform: "darwin",
    getUserDefault: () => value,
  });
  assert.equal(policy.isMeetingRecordingDisabled(), false);
  value = true;
  assert.equal(policy.isMeetingRecordingDisabled(), true);
});
