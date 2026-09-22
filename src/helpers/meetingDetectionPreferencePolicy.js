// Meeting detector gating, kept free of Electron so it can be unit-tested.
//
// The detectors exist only to serve meeting prompts, so they follow the saved
// notification toggles: nothing runs until the renderer has synced its saved
// snapshot, both detectors stop when meeting prompts are off, and process
// detection additionally honours its own toggle.

const DETECTOR_GATING_KEYS = [
  "notificationsEnabled",
  "notifyMeetingDetection",
  "meetingProcessDetection",
];

// True once a sync carries every key that gates a detector. Every current
// renderer caller sends the full snapshot; this latch is defence in depth so a
// partial update can never start detectors before the saved state is known.
function isCompleteNotificationSnapshot(prefs) {
  return prefs != null && DETECTOR_GATING_KEYS.every((key) => typeof prefs[key] === "boolean");
}

function deriveDetectorPreferences({
  initialized,
  notificationsEnabled,
  notifyMeetingDetection,
  meetingProcessDetection,
}) {
  const audioDetection =
    initialized === true && notificationsEnabled === true && notifyMeetingDetection === true;
  return {
    audioDetection,
    processDetection: audioDetection && meetingProcessDetection === true,
  };
}

module.exports = { isCompleteNotificationSnapshot, deriveDetectorPreferences };
