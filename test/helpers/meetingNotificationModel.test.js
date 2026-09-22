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
