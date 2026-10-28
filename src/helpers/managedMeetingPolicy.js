// Admin-managed switch for meeting recording, kept free of Electron so it can be unit-tested.
//
// IT departments deploy a configuration profile (Jamf, Kandji, Intune for Mac)
// for the `com.gizmolabs.openwhispr` domain with `DisableMeetingRecording` set
// to true. macOS layers managed preferences over the user's own defaults, so the
// key reads back through NSUserDefaults and a user cannot override it.
//
// The value is read on every check rather than cached: a profile can be pushed
// or removed while the app is running.

const DISABLE_MEETING_RECORDING_KEY = "DisableMeetingRecording";

function createManagedMeetingPolicy({ platform, getUserDefault }) {
  return {
    isMeetingRecordingDisabled() {
      if (platform !== "darwin") return false;
      return getUserDefault(DISABLE_MEETING_RECORDING_KEY, "boolean") === true;
    },
  };
}

module.exports = { createManagedMeetingPolicy, DISABLE_MEETING_RECORDING_KEY };
