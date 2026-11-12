function createManagedMeetingPolicy({ getSnapshot }) {
  return {
    isMeetingRecordingDisabled() {
      const snapshot = getSnapshot();
      return (
        snapshot.status === "loading" ||
        snapshot.status === "invalid" ||
        snapshot.policy?.features.meetingRecordingEnabled === false
      );
    },
  };
}

module.exports = { createManagedMeetingPolicy };
