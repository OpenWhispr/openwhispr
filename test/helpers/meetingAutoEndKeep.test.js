const test = require("node:test");
const assert = require("node:assert/strict");

const {
  keepMeetingRecordingSession,
  registerMeetingAutoEndKeepHandler,
} = require("../../src/helpers/meetingAutoEndKeep");

test("keep-recording IPC validation rejects invalid and stale sessions", () => {
  const requestedSessions = [];
  const engine = {
    keepRecordingSession: (sessionId) => {
      requestedSessions.push(sessionId);
      return sessionId === "meeting-2";
    },
  };

  assert.deepEqual(keepMeetingRecordingSession(engine, ""), {
    success: false,
    reason: "invalid-session",
  });
  assert.deepEqual(keepMeetingRecordingSession(engine, "meeting-1"), {
    success: false,
    reason: "stale-session",
  });
  assert.deepEqual(keepMeetingRecordingSession(engine, "meeting-2"), { success: true });
  assert.deepEqual(requestedSessions, ["meeting-1", "meeting-2"]);
});

test("main IPC registers Keep and resolves the current engine at invocation time", async () => {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
  };
  let engine = { keepRecordingSession: () => false };
  registerMeetingAutoEndKeepHandler(ipcMain, () => engine);
  const handler = handlers.get("meeting-auto-end-keep");

  assert.deepEqual(await handler({}, "meeting-1"), {
    success: false,
    reason: "stale-session",
  });

  engine = { keepRecordingSession: (sessionId) => sessionId === "meeting-2" };
  assert.deepEqual(await handler({}, "meeting-2"), { success: true });
});
