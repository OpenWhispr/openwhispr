function keepMeetingRecordingSession(engine, sessionId) {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return { success: false, reason: "invalid-session" };
  }
  if (engine?.keepRecordingSession(sessionId) !== true) {
    return { success: false, reason: "stale-session" };
  }
  return { success: true };
}

function registerMeetingAutoEndKeepHandler(ipcMain, getMeetingDetectionEngine) {
  ipcMain.handle("meeting-auto-end-keep", async (_event, sessionId) => {
    try {
      return keepMeetingRecordingSession(getMeetingDetectionEngine(), sessionId);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { keepMeetingRecordingSession, registerMeetingAutoEndKeepHandler };
