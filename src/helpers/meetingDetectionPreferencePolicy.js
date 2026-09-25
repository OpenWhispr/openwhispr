// Meeting detector gating, kept free of Electron so it can be unit-tested.
//
// The detectors exist only to serve meeting prompts, so they follow the saved
// notification toggles: both detectors stop when meeting prompts are off, and
// process detection additionally honours its own toggle.

function deriveDetectorPreferences({
  notificationsEnabled,
  notifyMeetingDetection,
  meetingProcessDetection,
}) {
  const audioDetection = notificationsEnabled === true && notifyMeetingDetection === true;
  return {
    audioDetection,
    processDetection: audioDetection && meetingProcessDetection === true,
  };
}

module.exports = { deriveDetectorPreferences };
