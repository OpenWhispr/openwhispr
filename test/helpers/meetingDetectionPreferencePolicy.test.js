const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveDetectorPreferences,
} = require("../../src/helpers/meetingDetectionPreferencePolicy.js");

// Full truth table: audio = notifications && meeting prompts; process detection
// additionally needs its own toggle.
test("detector preferences derive from the notification toggles", () => {
  for (const notificationsEnabled of [false, true]) {
    for (const notifyMeetingDetection of [false, true]) {
      for (const meetingProcessDetection of [false, true]) {
        const audioDetection = notificationsEnabled && notifyMeetingDetection;
        assert.deepEqual(
          deriveDetectorPreferences({
            notificationsEnabled,
            notifyMeetingDetection,
            meetingProcessDetection,
          }),
          { audioDetection, processDetection: audioDetection && meetingProcessDetection },
          JSON.stringify({ notificationsEnabled, notifyMeetingDetection, meetingProcessDetection })
        );
      }
    }
  }
});

test("the derived values are plain booleans even for missing inputs", () => {
  assert.deepEqual(deriveDetectorPreferences({}), {
    audioDetection: false,
    processDetection: false,
  });
});
