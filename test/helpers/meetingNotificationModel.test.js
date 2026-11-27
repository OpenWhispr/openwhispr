const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/meetingNotificationModel.ts");

test("detection presentation preserves event title, join action, and dismissal", async () => {
  const { getMeetingNotificationPresentation } = await load();

  assert.deepEqual(
    getMeetingNotificationPresentation({
      detectionId: "calendar:event-1",
      source: "calendar",
      key: "event-1",
      event: { summary: "Weekly planning" },
      variant: "starting",
      joinUrl: "https://meet.example/event-1",
    }),
    {
      title: "Weekly planning",
      bodyKey: "meetingNotification.body.starting",
      actionKey: "meetingNotification.join",
      action: "join",
      dismissible: true,
    }
  );
});

test("a reminder the org refuses to record can only join, and says why", async () => {
  const { getMeetingNotificationPresentation } = await load();

  assert.deepEqual(
    getMeetingNotificationPresentation({
      detectionId: "calendar:event-1",
      source: "calendar",
      key: "event-1",
      event: { summary: "Weekly planning" },
      variant: "underway",
      joinUrl: "https://meet.example/event-1",
      recordingRefusal: "POLICY_MEETING_RECORDING_DISABLED",
    }),
    {
      title: "Weekly planning",
      bodyKey: "meetingNotification.folders.errors.POLICY_MEETING_RECORDING_DISABLED",
      actionKey: "meetingNotification.joinOnly",
      action: "open",
      dismissible: true,
    }
  );
});

test("a dismissible meeting notification closes after an 80px horizontal swipe", async () => {
  const { shouldDismissMeetingNotificationSwipe } = await load();

  assert.equal(shouldDismissMeetingNotificationSwipe(true, 80), true);
  assert.equal(shouldDismissMeetingNotificationSwipe(true, -80), true);
  assert.equal(shouldDismissMeetingNotificationSwipe(true, 79), false);
});

// The card on screen when the pointer is released decides, not the one the
// swipe started on: a newer prompt can replace it mid-drag.
test("non-dismissible meeting notifications ignore horizontal swipes", async () => {
  const { shouldDismissMeetingNotificationSwipe } = await load();

  assert.equal(shouldDismissMeetingNotificationSwipe(false, 200), false);
});

test("overlay initialization cleanup cancels reveal and invalidates a pending pull", async () => {
  const { initializeMeetingNotificationOverlay } = await load();
  let subscribed;
  let reveal;
  let canceledTimer;
  let resolvePendingData;
  const pendingData = new Promise((resolve) => {
    resolvePendingData = resolve;
  });
  const received = [];
  let readyCount = 0;
  let visibleCount = 0;
  let unsubscribeCount = 0;

  const cleanup = initializeMeetingNotificationOverlay({
    subscribe: (callback) => {
      subscribed = callback;
      return () => {
        unsubscribeCount += 1;
      };
    },
    getPendingData: () => pendingData,
    onData: (data) => received.push(data),
    onVisible: () => {
      visibleCount += 1;
    },
    onReady: () => {
      readyCount += 1;
    },
    setTimeout: (callback, delay) => {
      assert.equal(delay, 50);
      reveal = callback;
      return 11;
    },
    clearTimeout: (timer) => {
      canceledTimer = timer;
    },
  });

  subscribed({ detectionId: "calendar:first" });
  cleanup();
  reveal();
  resolvePendingData({ detectionId: "calendar:second" });
  await pendingData;
  await Promise.resolve();

  assert.deepEqual(received, [{ detectionId: "calendar:first" }]);
  assert.equal(canceledTimer, 11);
  assert.equal(visibleCount, 0);
  assert.equal(readyCount, 0);
  assert.equal(unsubscribeCount, 1);
});

test("outside and unreadable guests show their localized explanation and only Join", async () => {
  const { getMeetingNotificationPresentation } = await load();
  for (const [recordingRefusal, key] of [
    ["POLICY_EXTERNAL_ATTENDEES", "externalAttendeesBlocked"],
    ["POLICY_ATTENDEES_UNVERIFIABLE", "externalAttendeesUnverifiable"],
  ]) {
    const card = getMeetingNotificationPresentation({
      recordingRefusal,
      joinUrl: "https://meet.example/join",
    });
    assert.equal(card.bodyKey, "notes.meeting." + key);
    assert.equal(card.action, "open");
  }
});

test("an audio prompt raised by one app offers to stop asking about it", async () => {
  const { getMeetingNotificationPresentation } = await load();
  const detection = {
    detectionId: "audio:sustained-audio",
    source: "audio",
    key: "sustained-audio",
    event: null,
    variant: "detected",
    joinUrl: null,
  };
  const orca = { id: "orca.exe", name: "Orca" };
  const teams = { id: "ms-teams.exe", name: "ms-teams" };

  assert.deepEqual(
    getMeetingNotificationPresentation({ ...detection, apps: [orca] }).ignoreApp,
    orca
  );
  // Two apps hold the mic: ignoring one is not what the user would expect.
  assert.equal(
    getMeetingNotificationPresentation({ ...detection, apps: [orca, teams] }).ignoreApp,
    undefined
  );
  assert.equal(getMeetingNotificationPresentation(detection).ignoreApp, undefined);
});
