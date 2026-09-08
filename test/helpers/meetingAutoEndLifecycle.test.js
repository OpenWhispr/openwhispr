const test = require("node:test");
const assert = require("node:assert/strict");

const {
  completeMeetingAutoEndSession,
  respondToMeetingAutoEndNotification,
  registerMeetingAutoEndLifecycleHandlers,
} = require("../../src/helpers/meetingAutoEndLifecycle");

test("stop-completion validation rejects invalid, stale, and non-owning sessions", async () => {
  const owner = { id: "owner" };
  const calls = [];
  const engine = {
    completeAutoEndSession: async (sessionId, sender) => {
      calls.push({ sessionId, sender });
      return sessionId === "meeting-2" && sender === owner;
    },
  };

  assert.deepEqual(await completeMeetingAutoEndSession(engine, "", owner), {
    success: false,
    reason: "invalid-session",
  });
  assert.deepEqual(await completeMeetingAutoEndSession(engine, "meeting-1", owner), {
    success: false,
    reason: "stale-session",
  });
  assert.deepEqual(await completeMeetingAutoEndSession(engine, "meeting-2", {}), {
    success: false,
    reason: "stale-session",
  });
  assert.deepEqual(await completeMeetingAutoEndSession(engine, "meeting-2", owner), {
    success: true,
  });
  assert.deepEqual(calls, [
    { sessionId: "meeting-1", sender: owner },
    { sessionId: "meeting-2", sender: {} },
    { sessionId: "meeting-2", sender: owner },
  ]);
});

test("overlay response validation accepts only restart or dismiss for a live offer", () => {
  const overlay = { id: "overlay" };
  const calls = [];
  const engine = {
    respondToAutoEndNotification: (sessionId, action, sender) => {
      calls.push({ sessionId, action, sender });
      return sessionId === "meeting-2" && action === "restart" && sender === overlay;
    },
  };

  assert.deepEqual(respondToMeetingAutoEndNotification(engine, "", "restart", overlay), {
    success: false,
    reason: "invalid-session",
  });
  assert.deepEqual(respondToMeetingAutoEndNotification(engine, "meeting-2", "keep", overlay), {
    success: false,
    reason: "invalid-action",
  });
  assert.deepEqual(respondToMeetingAutoEndNotification(engine, "meeting-1", "dismiss", overlay), {
    success: false,
    reason: "stale-session",
  });
  assert.deepEqual(respondToMeetingAutoEndNotification(engine, "meeting-2", "restart", overlay), {
    success: true,
  });
  assert.deepEqual(calls, [
    { sessionId: "meeting-1", action: "dismiss", sender: overlay },
    { sessionId: "meeting-2", action: "restart", sender: overlay },
  ]);
});

test("main IPC resolves the current engine and scopes both actions to event.sender", async () => {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
  };
  const sender = { id: "renderer" };
  const calls = [];
  let engine = {
    completeAutoEndSession: async () => false,
    respondToAutoEndNotification: () => false,
  };
  registerMeetingAutoEndLifecycleHandlers(ipcMain, () => engine);

  assert.deepEqual(
    await handlers.get("meeting-auto-end-completed")({ sender }, "meeting-1"),
    { success: false, reason: "stale-session" }
  );

  engine = {
    completeAutoEndSession: async (sessionId, eventSender) => {
      calls.push(["completed", sessionId, eventSender]);
      return true;
    },
    respondToAutoEndNotification: (sessionId, action, eventSender) => {
      calls.push(["respond", sessionId, action, eventSender]);
      return true;
    },
  };
  assert.deepEqual(
    await handlers.get("meeting-auto-end-completed")({ sender }, "meeting-2"),
    { success: true }
  );
  assert.deepEqual(
    await handlers.get("meeting-auto-end-respond")({ sender }, "meeting-2", "dismiss"),
    { success: true }
  );
  assert.deepEqual(calls, [
    ["completed", "meeting-2", sender],
    ["respond", "meeting-2", "dismiss", sender],
  ]);
});
