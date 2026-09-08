const isValidSessionId = (sessionId) =>
  typeof sessionId === "string" && sessionId.trim().length > 0;

async function completeMeetingAutoEndSession(engine, sessionId, sender) {
  if (!isValidSessionId(sessionId)) {
    return { success: false, reason: "invalid-session" };
  }
  if ((await engine?.completeAutoEndSession(sessionId, sender)) !== true) {
    return { success: false, reason: "stale-session" };
  }
  return { success: true };
}

function respondToMeetingAutoEndNotification(engine, sessionId, action, sender) {
  if (!isValidSessionId(sessionId)) {
    return { success: false, reason: "invalid-session" };
  }
  if (action !== "restart" && action !== "dismiss") {
    return { success: false, reason: "invalid-action" };
  }
  if (engine?.respondToAutoEndNotification(sessionId, action, sender) !== true) {
    return { success: false, reason: "stale-session" };
  }
  return { success: true };
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function registerMeetingAutoEndLifecycleHandlers(ipcMain, getMeetingDetectionEngine) {
  ipcMain.handle("meeting-auto-end-completed", async (event, sessionId) => {
    try {
      return await completeMeetingAutoEndSession(
        getMeetingDetectionEngine(),
        sessionId,
        event.sender
      );
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle("meeting-auto-end-respond", async (event, sessionId, action) => {
    try {
      return respondToMeetingAutoEndNotification(
        getMeetingDetectionEngine(),
        sessionId,
        action,
        event.sender
      );
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
}

module.exports = {
  completeMeetingAutoEndSession,
  respondToMeetingAutoEndNotification,
  registerMeetingAutoEndLifecycleHandlers,
};
