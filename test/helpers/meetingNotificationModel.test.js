const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/meetingNotificationModel.ts");

test("auto-end presentation has countdown copy, Restart action, and dismissal", async () => {
  const { getMeetingNotificationPresentation } = await load();

  assert.deepEqual(
    getMeetingNotificationPresentation(
      { kind: "auto-end", sessionId: "meeting-2", expiresAt: 40_001, reason: "mic-released" },
      30
    ),
    {
      titleKey: "meetingNotification.autoEnd.title",
      bodyKey: "meetingNotification.autoEnd.body.micReleased",
      bodyValues: { seconds: 30 },
      actionKey: "meetingNotification.autoEnd.restart",
      action: "restart",
      dismissible: true,
      allowTitleWrap: true,
    }
  );
});

test("auto-end presentation picks body copy by reason and defaults to mic-released", async () => {
  const { getMeetingNotificationPresentation } = await load();
  const bodyFor = (reason) =>
    getMeetingNotificationPresentation(
      { kind: "auto-end", sessionId: "meeting-2", expiresAt: 40_001, reason },
      5
    ).bodyKey;

  assert.equal(bodyFor("silence"), "meetingNotification.autoEnd.body.silence");
  assert.equal(bodyFor("process-exit"), "meetingNotification.autoEnd.body.processExit");
  assert.equal(bodyFor(undefined), "meetingNotification.autoEnd.body.micReleased");
  assert.equal(bodyFor("unknown-reason"), "meetingNotification.autoEnd.body.micReleased");
});

test("detection presentation preserves event title, join action, and dismissal", async () => {
  const { getMeetingNotificationPresentation } = await load();

  assert.deepEqual(
    getMeetingNotificationPresentation(
      {
        kind: "detection",
        detectionId: "calendar:event-1",
        source: "calendar",
        key: "event-1",
        event: { summary: "Weekly planning" },
        variant: "starting",
        joinUrl: "https://meet.example/event-1",
      },
      0
    ),
    {
      title: "Weekly planning",
      bodyKey: "meetingNotification.body.starting",
      actionKey: "meetingNotification.join",
      action: "join",
      dismissible: true,
      allowTitleWrap: false,
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

test("countdown rounds up and emits updated seconds until expiration", async () => {
  const { subscribeMeetingAutoEndCountdown } = await load();
  let now = 10_000;
  let tick;
  let clearedTimer;
  const seconds = [];

  const unsubscribe = subscribeMeetingAutoEndCountdown(
    12_001,
    (nextSeconds) => {
      seconds.push(nextSeconds);
    },
    {
      now: () => now,
      setInterval: (callback, delay) => {
        assert.equal(delay, 250);
        tick = callback;
        return 7;
      },
      clearInterval: (timer) => {
        clearedTimer = timer;
      },
    }
  );

  now = 10_002;
  tick();
  now = 11_002;
  tick();
  now = 12_001;
  tick();
  unsubscribe();

  assert.deepEqual(seconds, [3, 2, 1, 0]);
  assert.equal(clearedTimer, 7);
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

  subscribed({ kind: "auto-end", sessionId: "meeting-1", expiresAt: 70_000 });
  cleanup();
  reveal();
  resolvePendingData({ kind: "auto-end", sessionId: "meeting-2", expiresAt: 80_000 });
  await pendingData;
  await Promise.resolve();

  assert.deepEqual(received, [{ kind: "auto-end", sessionId: "meeting-1", expiresAt: 70_000 }]);
  assert.equal(canceledTimer, 11);
  assert.equal(visibleCount, 0);
  assert.equal(readyCount, 0);
  assert.equal(unsubscribeCount, 1);
});

// The overlay hides its card optimistically and relies on main closing the
// window. Anything short of an explicit success leaves the window open, so the
// card has to come back or the user is left with an invisible, unclickable
// always-on-top window over their screen.
test("only an explicit success keeps the auto-end card hidden", async () => {
  const { shouldRestoreAutoEndCard } = await load();

  assert.equal(shouldRestoreAutoEndCard({ success: true }), false);
  assert.equal(shouldRestoreAutoEndCard({ success: false, reason: "stale-session" }), true);
  // The IPC method is optional on the preload surface: an older or partially
  // wired bridge resolves undefined, which is not a success.
  assert.equal(shouldRestoreAutoEndCard(undefined), true);
  assert.equal(shouldRestoreAutoEndCard(null), true);
});
