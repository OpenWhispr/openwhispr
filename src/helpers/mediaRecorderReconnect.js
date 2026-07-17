// Decide when an active MediaRecorder session must swap microphones (#1059).
// devicechange alone is not enough: plugging in a new device should not interrupt
// a healthy recording. Reconnect only when the capture track is gone.

export const captureTrackNeedsReconnect = (track) => {
  if (!track) return true;
  return track.readyState === "ended";
};

export const shouldAttemptRecordingReconnect = ({
  isRecording,
  mediaRecorderState,
  track,
  reconnectInFlight = false,
}) => {
  if (reconnectInFlight) return false;
  if (!isRecording) return false;
  if (mediaRecorderState !== "recording") return false;
  return captureTrackNeedsReconnect(track);
};
