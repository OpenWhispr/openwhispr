const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const EVENT = {
  event_id: "upload-after-delete",
  occurred_at: "2026-08-30T10:00:00.000Z",
  local_date: "2026-08-30",
  word_count: 4,
  spoken_duration_ms: 2_000,
  mode: "local",
  provider: "local-whisper",
  model: "small",
  counter_version: 1,
};

const VALID_SUMMARY = {
  totalWords: 12,
  totalDictations: 2,
  totalSpokenDurationMs: 6_000,
  averageWpm: 120,
  currentStreakDays: 1,
  longestStreakDays: 2,
  wpmCoveragePercent: 100,
  daily: [
    {
      date: "2026-08-30",
      words: 12,
      dictations: 2,
      spokenDurationMs: 6_000,
    },
  ],
};

test("analytics deletion tombstones reach the cloud before pending uploads", async (t) => {
  const requests = [];
  const localMutations = [];
  let deleteRead = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPendingAnalyticsClear: async () => null,
        getPendingAnalyticsDeletes: async () =>
          deleteRead++ === 0 ? [{ event_id: "deleted-event" }] : [],
        hardDeleteAnalyticsEvents: async (eventIds) => {
          localMutations.push(["delete", eventIds]);
          return { success: true, deleted: eventIds.length };
        },
        getPendingAnalyticsEvents: async () => [EVENT],
        markAnalyticsEventsSynced: async (eventIds) => {
          localMutations.push(["sync", eventIds]);
          return { success: true, updated: eventIds.length };
        },
        cloudApiRequest: async (request) => {
          requests.push(request);
          return {
            success: true,
            data: request.method === "POST" ? { accepted: [EVENT.event_id] } : {},
          };
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { syncPendingAnalytics } = await vite.ssrLoadModule("/services/AnalyticsService.ts");

  assert.equal(await syncPendingAnalytics(), 1);
  assert.deepEqual(
    requests.map(({ method, path }) => [method, path]),
    [
      ["DELETE", "/api/analytics/events/delete"],
      ["POST", "/api/analytics/events/batch"],
    ]
  );
  assert.deepEqual(localMutations, [
    ["delete", ["deleted-event"]],
    ["sync", [EVENT.event_id]],
  ]);
});

test("a failed cloud deletion preserves its tombstone without blocking uploads", async (t) => {
  // A tombstone the server refuses must survive locally, but it must not hold
  // the user's consented uploads hostage while it keeps failing.
  const requests = [];
  let hardDeletes = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPendingAnalyticsClear: async () => null,
        getPendingAnalyticsDeletes: async () => [{ event_id: "deleted-event" }],
        hardDeleteAnalyticsEvents: async () => {
          hardDeletes += 1;
          return { success: true, deleted: 1 };
        },
        getPendingAnalyticsEvents: async () => [EVENT],
        markAnalyticsEventsSynced: async () => ({ success: true, updated: 1 }),
        cloudApiRequest: async (request) => {
          requests.push(request);
          if (request.method === "DELETE") {
            return { success: false, status: 500, error: "delete failed" };
          }
          return { success: true, data: { accepted: [EVENT.event_id] } };
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { syncPendingAnalytics } = await vite.ssrLoadModule("/services/AnalyticsService.ts");

  assert.equal(await syncPendingAnalytics(), 1);
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["DELETE", "POST"]
  );
  assert.equal(hardDeletes, 0, "the tombstone survives a failed cloud delete");
});

test("a delete-only pass clears cloud tombstones without enabling uploads", async (t) => {
  const requests = [];
  let deleteRead = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPendingAnalyticsClear: async () => null,
        getPendingAnalyticsDeletes: async () =>
          deleteRead++ === 0 ? [{ event_id: "deleted-event" }] : [],
        hardDeleteAnalyticsEvents: async (eventIds) => ({
          success: true,
          deleted: eventIds.length,
        }),
        getPendingAnalyticsEvents: async () => {
          throw new Error("analytics uploads must stay disabled");
        },
        markAnalyticsEventsSynced: async () => ({ success: true, updated: 0 }),
        cloudApiRequest: async (request) => {
          requests.push(request);
          return { success: true, data: {} };
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { syncPendingAnalytics } = await vite.ssrLoadModule("/services/AnalyticsService.ts");

  assert.equal(await syncPendingAnalytics({ uploadAllowed: false }), 0);
  assert.deepEqual(
    requests.map(({ method, path }) => [method, path]),
    [["DELETE", "/api/analytics/events/delete"]]
  );
});

test("an account clear reaches the cloud before newer analytics upload", async (t) => {
  const clearedThrough = "2026-08-30T10:00:00.000Z";
  const requests = [];
  const localMutations = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPendingAnalyticsClear: async () => ({ cleared_through: clearedThrough }),
        completeAnalyticsClear: async (value) => {
          localMutations.push(["clear", value]);
          return { success: true, deleted: 1 };
        },
        getPendingAnalyticsDeletes: async () => [],
        getPendingAnalyticsEvents: async () => [EVENT],
        markAnalyticsEventsSynced: async (eventIds) => {
          localMutations.push(["sync", eventIds]);
          return { success: true, updated: eventIds.length };
        },
        cloudApiRequest: async (request) => {
          requests.push(request);
          return {
            success: true,
            data: request.method === "POST" ? { accepted: [EVENT.event_id] } : {},
          };
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { syncPendingAnalytics } = await vite.ssrLoadModule("/services/AnalyticsService.ts");

  assert.equal(await syncPendingAnalytics(), 1);
  assert.deepEqual(
    requests.map(({ method, body }) => [method, body]),
    [
      ["DELETE", { deleteAll: true, clearedThrough }],
      ["POST", { events: [EVENT] }],
    ]
  );
  assert.deepEqual(localMutations, [
    ["clear", clearedThrough],
    ["sync", [EVENT.event_id]],
  ]);
});

test("a failed account clear stays pending without stalling the rest of the pass", async (t) => {
  // The clear used to be the first and only thing that had to succeed: one
  // server error and neither the queued deletes nor the uploads ran, on this
  // pass or any later one, until it cleared. Each stage stands alone now.
  const requests = [];
  let completed = 0;
  let hardDeletes = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPendingAnalyticsClear: async () => ({
          cleared_through: "2026-08-30T10:00:00.000Z",
        }),
        completeAnalyticsClear: async () => {
          completed += 1;
          return { success: true, deleted: 0 };
        },
        getPendingAnalyticsDeletes: async () =>
          requests.length === 0 ? [] : [{ event_id: "deleted-event" }],
        hardDeleteAnalyticsEvents: async () => {
          hardDeletes += 1;
          return { success: true, deleted: 1 };
        },
        getPendingAnalyticsEvents: async () => (hardDeletes === 0 ? [] : [EVENT]),
        markAnalyticsEventsSynced: async () => ({ success: true, updated: 1 }),
        cloudApiRequest: async (request) => {
          requests.push(request);
          if (request.body?.deleteAll) {
            return { success: false, status: 500, error: "clear failed" };
          }
          return { success: true, data: { accepted: [EVENT.event_id] } };
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { syncPendingAnalytics } = await vite.ssrLoadModule("/services/AnalyticsService.ts");

  assert.equal(await syncPendingAnalytics(), 1, "the upload still happens");
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["DELETE", "DELETE", "POST"],
    "the failed clear is attempted, then deletes drain, then uploads go"
  );
  assert.equal(completed, 0, "an unacknowledged clear stays queued for the next pass");
  assert.equal(hardDeletes, 1);
});

test("account analytics accepts a complete cloud summary", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cloudApiRequest: async () => ({
          success: true,
          data: { ...VALID_SUMMARY, scope: "account", timeZone: "UTC" },
        }),
      },
    },
  });
  const vite = await createRendererServer(t);
  const { getAccountAnalyticsSummary } = await vite.ssrLoadModule("/services/AnalyticsService.ts");

  assert.deepEqual(await getAccountAnalyticsSummary("UTC"), {
    ...VALID_SUMMARY,
    scope: "account",
    timeZone: "UTC",
  });
});

for (const [name, daily] of [
  ["a null bucket", [null]],
  ["an impossible date", [{ ...VALID_SUMMARY.daily[0], date: "2026-02-30" }]],
  ["non-numeric words", [{ ...VALID_SUMMARY.daily[0], words: "12" }]],
  ["negative dictations", [{ ...VALID_SUMMARY.daily[0], dictations: -1 }]],
  ["a non-numeric duration", [{ ...VALID_SUMMARY.daily[0], spokenDurationMs: null }]],
]) {
  test(`account analytics rejects a cloud summary with ${name}`, async (t) => {
    installBrowserGlobals(t, {
      window: {
        electronAPI: {
          cloudApiRequest: async () => ({
            success: true,
            data: { ...VALID_SUMMARY, daily },
          }),
        },
      },
    });
    const vite = await createRendererServer(t);
    const { getAccountAnalyticsSummary } = await vite.ssrLoadModule(
      "/services/AnalyticsService.ts"
    );

    await assert.rejects(
      getAccountAnalyticsSummary("UTC"),
      /Malformed analytics summary from cloud/
    );
  });
}

test("analytics refreshes locally on change and remotely only while cloud Insights are active", async (t) => {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const clearedIntervals = [];
  const clearedTimeouts = [];
  let nextIntervalId = 1;
  let nextTimeoutId = 100;
  let localChangeListener;
  let localListenerDisposed = false;
  const fakeDocument = {
    visibilityState: "visible",
    addEventListener: (name, listener) => documentListeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (documentListeners.get(name) === listener) documentListeners.delete(name);
    },
  };
  installBrowserGlobals(t, {
    window: {
      document: fakeDocument,
      addEventListener: (name, listener) => windowListeners.set(name, listener),
      removeEventListener: (name, listener) => {
        if (windowListeners.get(name) === listener) windowListeners.delete(name);
      },
      setInterval: (callback, delay) => {
        const id = nextIntervalId++;
        intervals.set(id, { callback, delay });
        return id;
      },
      clearInterval: (id) => {
        clearedIntervals.push(id);
        intervals.delete(id);
      },
      setTimeout: (callback, delay) => {
        const id = nextTimeoutId++;
        timeouts.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id) => {
        clearedTimeouts.push(id);
        timeouts.delete(id);
      },
      electronAPI: {
        onAnalyticsChanged: (listener) => {
          localChangeListener = listener;
          return () => {
            localListenerDisposed = true;
          };
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const {
    ANALYTICS_REMOTE_REFRESH_DEBOUNCE_MS,
    ANALYTICS_SUMMARY_REFRESH_INTERVAL_MS,
    subscribeToAnalyticsRefresh,
  } = await vite.ssrLoadModule("/services/AnalyticsService.ts");
  let refreshes = 0;
  const dispose = subscribeToAnalyticsRefresh(() => {
    refreshes += 1;
  }, true);

  assert.equal(refreshes, 1, "the mounted view loads immediately");
  await Promise.resolve();
  localChangeListener();
  assert.equal(refreshes, 2, "local database changes refresh immediately");
  await Promise.resolve();

  documentListeners.get("visibilitychange")();
  await Promise.resolve();
  windowListeners.get("focus")();
  assert.equal(refreshes, 2, "separate-task visibility and focus events are debounced");
  assert.deepEqual(clearedTimeouts, [100], "focus replaces the visibility debounce");
  const [focusTimeoutId, focusTimeout] = [...timeouts.entries()][0];
  assert.equal(focusTimeout.delay, ANALYTICS_REMOTE_REFRESH_DEBOUNCE_MS);
  timeouts.delete(focusTimeoutId);
  focusTimeout.callback();
  assert.equal(refreshes, 3);
  await Promise.resolve();

  const [{ callback: poll, delay }] = intervals.values();
  assert.equal(delay, ANALYTICS_SUMMARY_REFRESH_INTERVAL_MS);
  poll();
  const [pollTimeoutId, pollTimeout] = [...timeouts.entries()][0];
  timeouts.delete(pollTimeoutId);
  pollTimeout.callback();
  assert.equal(refreshes, 4, "a visible mounted view eventually sees remote-device changes");
  await Promise.resolve();

  windowListeners.get("focus")();
  fakeDocument.visibilityState = "hidden";
  documentListeners.get("visibilitychange")();
  assert.equal(timeouts.size, 0, "hiding cancels a focus refresh that has not started");
  poll();
  await Promise.resolve();
  assert.equal(refreshes, 4, "background polling does not issue cloud work");
  assert.equal(timeouts.size, 0);

  dispose();
  assert.equal(localListenerDisposed, true);
  assert.equal(windowListeners.size, 0);
  assert.equal(documentListeners.size, 0);
  assert.deepEqual(clearedIntervals, [1]);
});

test("analytics refresh does not install cloud triggers while account sync is inactive", async (t) => {
  const windowListeners = new Map();
  const documentListeners = new Map();
  let intervalCount = 0;
  let localChangeListener;
  installBrowserGlobals(t, {
    window: {
      document: {
        visibilityState: "visible",
        addEventListener: (name, listener) => documentListeners.set(name, listener),
        removeEventListener() {},
      },
      addEventListener: (name, listener) => windowListeners.set(name, listener),
      removeEventListener() {},
      setInterval: () => {
        intervalCount += 1;
        return 1;
      },
      electronAPI: {
        onAnalyticsChanged: (listener) => {
          localChangeListener = listener;
          return () => {};
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { subscribeToAnalyticsRefresh } = await vite.ssrLoadModule("/services/AnalyticsService.ts");
  let refreshes = 0;
  const dispose = subscribeToAnalyticsRefresh(() => {
    refreshes += 1;
  }, false);

  assert.equal(windowListeners.size, 0);
  assert.equal(documentListeners.size, 0);
  assert.equal(intervalCount, 0);
  assert.equal(refreshes, 1, "device-local summaries load immediately");
  await Promise.resolve();
  localChangeListener();
  assert.equal(refreshes, 2, "device-local summaries remain live");
  dispose();
});

test("analytics refresh serializes triggers and runs one trailing refresh", async (t) => {
  let localChangeListener;
  let releaseFirstRefresh;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onAnalyticsChanged: (listener) => {
          localChangeListener = listener;
          return () => {};
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { subscribeToAnalyticsRefresh } = await vite.ssrLoadModule("/services/AnalyticsService.ts");
  let activeRefreshes = 0;
  let refreshes = 0;
  let maximumConcurrentRefreshes = 0;
  const dispose = subscribeToAnalyticsRefresh(async () => {
    refreshes += 1;
    activeRefreshes += 1;
    maximumConcurrentRefreshes = Math.max(maximumConcurrentRefreshes, activeRefreshes);
    if (refreshes === 1) {
      await new Promise((resolve) => {
        releaseFirstRefresh = resolve;
      });
    }
    activeRefreshes -= 1;
  }, false);

  assert.equal(refreshes, 1);
  localChangeListener();
  localChangeListener();
  assert.equal(refreshes, 1, "new triggers wait for the active refresh");

  releaseFirstRefresh();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshes, 2, "multiple waiting triggers collapse into one trailing refresh");
  assert.equal(maximumConcurrentRefreshes, 1);
  dispose();
});

test("analytics drops remote-only trailing work when the view becomes hidden", async (t) => {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const timeouts = new Map();
  let nextTimeoutId = 1;
  let releaseInitialRefresh;
  const fakeDocument = {
    visibilityState: "visible",
    addEventListener: (name, listener) => documentListeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (documentListeners.get(name) === listener) documentListeners.delete(name);
    },
  };
  installBrowserGlobals(t, {
    window: {
      document: fakeDocument,
      addEventListener: (name, listener) => windowListeners.set(name, listener),
      removeEventListener: (name, listener) => {
        if (windowListeners.get(name) === listener) windowListeners.delete(name);
      },
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: (callback) => {
        const id = nextTimeoutId++;
        timeouts.set(id, callback);
        return id;
      },
      clearTimeout: (id) => timeouts.delete(id),
      electronAPI: {
        onAnalyticsChanged: () => () => {},
      },
    },
  });
  const vite = await createRendererServer(t);
  const { subscribeToAnalyticsRefresh } = await vite.ssrLoadModule("/services/AnalyticsService.ts");
  let refreshes = 0;
  const dispose = subscribeToAnalyticsRefresh(async () => {
    refreshes += 1;
    if (refreshes === 1) {
      await new Promise((resolve) => {
        releaseInitialRefresh = resolve;
      });
    }
  }, true);

  windowListeners.get("focus")();
  const [timeoutId, remoteRefresh] = [...timeouts.entries()][0];
  timeouts.delete(timeoutId);
  remoteRefresh();
  assert.equal(refreshes, 1, "the remote refresh waits behind the initial load");

  fakeDocument.visibilityState = "hidden";
  documentListeners.get("visibilitychange")();
  releaseInitialRefresh();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshes, 1, "hidden views discard queued remote-only refreshes");
  dispose();
});

test("overlapping passes are serialized rather than posting the same batch twice", async (t) => {
  // InsightsView flushes on focus, on every analytics-changed broadcast and on
  // a timer, while SyncService runs passes under its own lock. The two share
  // no lock, so without serializing here both read the same pending rows.
  const requests = [];
  let synced = false;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPendingAnalyticsClear: async () => null,
        getPendingAnalyticsDeletes: async () => [],
        getPendingAnalyticsEvents: async () => (synced ? [] : [EVENT]),
        markAnalyticsEventsSynced: async () => {
          synced = true;
          return { success: true, updated: 1 };
        },
        cloudApiRequest: async (request) => {
          requests.push(request);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { success: true, data: { accepted: [EVENT.event_id] } };
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { syncPendingAnalytics } = await vite.ssrLoadModule("/services/AnalyticsService.ts");

  const [first, second] = await Promise.all([syncPendingAnalytics(), syncPendingAnalytics()]);

  assert.equal(requests.length, 1, "the second pass waits and then finds nothing left to send");
  assert.equal(first, 1);
  assert.equal(second, 0);
});

test("a withheld row is offered once per pass, not once per batch behind it", async (t) => {
  // The server withholds rows it could not store, which correctly keeps them
  // pending. They sit at the head of an oldest-first queue, so re-reading from
  // the head each iteration made every later batch carry them again.
  const posted = [];
  const pending = Array.from({ length: 3 }, (_, index) => ({
    ...EVENT,
    event_id: `event-${index}`,
  }));
  const retired = new Set();
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPendingAnalyticsClear: async () => null,
        getPendingAnalyticsDeletes: async () => [],
        getPendingAnalyticsEvents: async () =>
          pending.filter((event) => !retired.has(event.event_id)),
        markAnalyticsEventsSynced: async (ids) => {
          ids.forEach((id) => retired.add(id));
          return { success: true, updated: ids.length };
        },
        cloudApiRequest: async (request) => {
          posted.push(request.body.events.map((event) => event.event_id));
          // event-0 is withheld: in neither accepted nor rejected.
          return {
            success: true,
            data: {
              accepted: request.body.events.map((e) => e.event_id).filter((id) => id !== "event-0"),
            },
          };
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { syncPendingAnalytics } = await vite.ssrLoadModule("/services/AnalyticsService.ts");

  await syncPendingAnalytics();

  assert.deepEqual(posted, [["event-0", "event-1", "event-2"]]);
  assert.equal(retired.has("event-0"), false, "the withheld row stays pending for a later pass");
});
