const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isCompleteNotificationSnapshot,
  deriveDetectorPreferences,
} = require("../../src/helpers/meetingDetectionPreferencePolicy.js");

const FULL_SNAPSHOT = {
  notificationsEnabled: true,
  notifyMeetingDetection: true,
  notifyCalendarReminders: true,
  meetingProcessDetection: true,
};

test("a snapshot is complete only when every detector-gating key is a boolean", () => {
  assert.equal(isCompleteNotificationSnapshot(FULL_SNAPSHOT), true);
  // notifyCalendarReminders does not gate a detector, so it is not required.
  const { notifyCalendarReminders: _omitted, ...withoutCalendar } = FULL_SNAPSHOT;
  assert.equal(isCompleteNotificationSnapshot(withoutCalendar), true);

  for (const key of ["notificationsEnabled", "notifyMeetingDetection", "meetingProcessDetection"]) {
    const { [key]: _dropped, ...partial } = FULL_SNAPSHOT;
    assert.equal(isCompleteNotificationSnapshot(partial), false, `missing ${key}`);
    assert.equal(
      isCompleteNotificationSnapshot({ ...FULL_SNAPSHOT, [key]: "true" }),
      false,
      `non-boolean ${key}`
    );
  }
  assert.equal(isCompleteNotificationSnapshot(null), false);
  assert.equal(isCompleteNotificationSnapshot(undefined), false);
});

// Full truth table: audio = initialized && notifications && meeting prompts;
// process detection additionally needs its own toggle.
test("detector preferences derive from the notification toggles", () => {
  for (const initialized of [false, true]) {
    for (const notificationsEnabled of [false, true]) {
      for (const notifyMeetingDetection of [false, true]) {
        for (const meetingProcessDetection of [false, true]) {
          const audioDetection = initialized && notificationsEnabled && notifyMeetingDetection;
          assert.deepEqual(
            deriveDetectorPreferences({
              initialized,
              notificationsEnabled,
              notifyMeetingDetection,
              meetingProcessDetection,
            }),
            { audioDetection, processDetection: audioDetection && meetingProcessDetection },
            JSON.stringify({
              initialized,
              notificationsEnabled,
              notifyMeetingDetection,
              meetingProcessDetection,
            })
          );
        }
      }
    }
  }
});

test("nothing starts before the saved snapshot has been applied", () => {
  assert.deepEqual(
    deriveDetectorPreferences({
      initialized: false,
      notificationsEnabled: true,
      notifyMeetingDetection: true,
      meetingProcessDetection: true,
    }),
    { audioDetection: false, processDetection: false }
  );
});

test("the derived values are plain booleans even for missing inputs", () => {
  assert.deepEqual(deriveDetectorPreferences({ initialized: true }), {
    audioDetection: false,
    processDetection: false,
  });
});
