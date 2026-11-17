const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CAPABILITIES, ProductEvents, createFileStore } = require("../../src/helpers/productEvents");
const { createCloudApiRequestHandler } = require("../../src/helpers/cloudApiRequest");

const BINDING = "0d6b9a52-7a3c-4c8e-9f1d-2b4a6c8e0f13";
const SECOND_BINDING = "5e2c1b4a-9d8f-4e7a-8b6c-1a3f5d7e9b20";
const AUTHENTICATED_AT = "2026-11-04T08:00:00.000Z";

function memoryStore(initial = null) {
  let saved = initial;
  return {
    load: () => structuredClone(saved) ?? { version: 1, events: [], onboardingCompletions: 0 },
    save: (state) => {
      saved = structuredClone(state);
    },
    saved: () => saved,
  };
}

// Answers the way the API does: binding per (generation, installation),
// accepted ids, and whatever status a test sets.
function rig({ store = memoryStore(), scope = { accountId: "a", authGeneration: 1 } } = {}) {
  const calls = [];
  const timers = [];
  let now = Date.parse("2026-11-04T08:00:05.000Z");
  const server = {
    batchStatus: 200,
    batchCode: null,
    bindStatus: 200,
    bindingId: BINDING,
    defer: new Set(),
    omit: new Set(),
    reject: new Map(),
    duplicates: new Set(),
    throwBind: false,
  };
  const state = { scope };
  const request = async ({ path: route, body, expectedAuthGeneration }) => {
    calls.push({ route, body: structuredClone(body), expectedAuthGeneration });
    if (route.endsWith("/app-session")) {
      if (server.throwBind) throw new Error("offline");
      if (server.bindStatus !== 200) return { success: false, status: server.bindStatus };
      return {
        success: true,
        data: { binding_id: server.bindingId, authenticated_at: AUTHENTICATED_AT },
      };
    }
    if (server.batchStatus !== 200) {
      return { success: false, status: server.batchStatus, code: server.batchCode };
    }
    const ids = body.events.map((event) => event.event_id);
    return {
      success: true,
      data: {
        accepted: ids.filter((id) => !server.defer.has(id) && !server.omit.has(id)),
        stored: ids.filter(
          (id) =>
            !server.defer.has(id) &&
            !server.omit.has(id) &&
            !server.reject.has(id) &&
            !server.duplicates.has(id)
        ),
        duplicates: ids.filter((id) => server.duplicates.has(id)),
        conflicts: [],
        rejected: ids
          .filter((id) => server.reject.has(id))
          .map((id) => ({ event_id: id, reason: server.reject.get(id) })),
        deferred: ids
          .filter((id) => server.defer.has(id))
          .map((id) => ({ event_id: id, reason: "unsupported_event" })),
      },
    };
  };
  const events = new ProductEvents({
    store,
    getScope: () => state.scope,
    request,
    platform: "darwin",
    getAppVersion: () => "1.12.0",
    now: () => now,
    setTimer: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimer: () => {},
  });
  return {
    events,
    calls,
    timers,
    server,
    store,
    setScope: (next) => {
      state.scope = next;
    },
    getScope: () => state.scope,
    advance: (ms) => {
      now += ms;
    },
    batches: () => calls.filter((call) => call.route.endsWith("/batch")),
    queued: () => events.state.events,
  };
}

test("an app sign-in binds the session and queues one event timed by the server", async () => {
  const r = rig();
  await r.events.recordAppSession({ accountId: "a", authGeneration: 1 });

  const [bind, upload] = r.calls;
  assert.equal(bind.route, "/api/product-events/app-session");
  assert.deepEqual(bind.body, {
    surface: "desktop",
    os: "macos",
    installation_id: r.events.installationId(),
    app_version: "1.12.0",
  });
  assert.equal(bind.expectedAuthGeneration, 1);
  assert.equal(upload.route, "/api/product-events/batch");
  assert.equal(upload.expectedAuthGeneration, 1);
  assert.deepEqual(upload.body.collector.capabilities, CAPABILITIES);
  assert.match(upload.body.collector.sent_at, /Z$/);
  assert.deepEqual(upload.body.events, [
    {
      event_id: BINDING,
      event_name: "app_session_authenticated",
      schema_version: 1,
      occurred_at: AUTHENTICATED_AT,
      app_version: "1.12.0",
      flow_version: null,
      identity_generation: 1,
      properties: { binding_id: BINDING },
    },
  ]);
  assert.deepEqual(r.queued(), []);
});

test("reconciling, refetching or another window re-validating the same scope binds once", async () => {
  const r = rig();
  await r.events.recordAppSession({ accountId: "a", authGeneration: 1 });
  await r.events.recordAppSession({ accountId: "a", authGeneration: 1 });
  await Promise.all([
    r.events.recordAppSession({ accountId: "a", authGeneration: 1 }),
    r.events.recordAppSession({ accountId: "a", authGeneration: 1 }),
  ]);

  assert.equal(r.calls.filter((call) => call.route.endsWith("/app-session")).length, 1);
});

test("a validation for a scope main no longer holds binds nothing", async () => {
  const r = rig();
  await r.events.recordAppSession({ accountId: "b", authGeneration: 1 });
  await r.events.recordAppSession({ accountId: "a", authGeneration: 2 });
  r.setScope(null);
  await r.events.recordAppSession({ accountId: "a", authGeneration: 1 });

  assert.deepEqual(r.calls, []);
});

test("a binding refused or unanswered takes no client time; an outage binds on the next validation", async () => {
  const r = rig();
  r.server.bindStatus = 403;
  await r.events.recordAppSession({ accountId: "a", authGeneration: 1 });
  await r.events.recordAppSession({ accountId: "a", authGeneration: 1 });
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.queued(), []);

  const offline = rig();
  offline.server.throwBind = true;
  await offline.events.recordAppSession({ accountId: "a", authGeneration: 1 });
  assert.deepEqual(offline.queued(), []);
  offline.server.throwBind = false;
  await offline.events.recordAppSession({ accountId: "a", authGeneration: 1 });
  assert.deepEqual(
    offline
      .batches()
      .at(-1)
      .body.events.map((event) => event.event_id),
    [BINDING]
  );
});

test("an account switch while binding drops the answer instead of queuing it for B", async () => {
  const r = rig();
  const original = r.events.request;
  r.events.request = async (opts) => {
    const result = await original(opts);
    r.setScope({ accountId: "b", authGeneration: 2 });
    return result;
  };
  await r.events.recordAppSession({ accountId: "a", authGeneration: 1 });

  assert.deepEqual(r.queued(), []);
  assert.equal(r.batches().length, 0);
});

test("onboarding completion keeps its capture time and account through a delayed upload", async () => {
  const r = rig();
  r.server.batchStatus = 503;
  r.events.recordOnboardingCompleted({ setupMode: "local", flowVersion: "desktop-onboarding-2" });
  await r.events.flush();

  const [queued] = r.queued();
  assert.equal(queued.event_name, "onboarding_completed");
  assert.equal(queued.account_id, "a");
  assert.equal(queued.occurred_at, "2026-11-04T08:00:05.000Z");
  assert.deepEqual(queued.properties, { replay: false, setup_mode: "local" });
  assert.equal(queued.flow_version, "desktop-onboarding-2");
  // A 503 (including PRODUCT_EVENTS_RETRY) is retried later.
  assert.equal(r.timers.length, 1);

  r.advance(60 * 60_000);
  r.server.batchStatus = 200;
  await r.timers[0].fn();
  await r.events.running;
  const sent = r.batches().at(-1).body.events[0];
  assert.equal(sent.occurred_at, "2026-11-04T08:00:05.000Z");
  assert.equal(sent.event_id, queued.event_id);
  assert.deepEqual(r.queued(), []);
});

test("a second completion on this installation is a replay, and an unknown mode is left out", async () => {
  const r = rig();
  r.events.recordOnboardingCompleted({ setupMode: "cloud", flowVersion: "desktop-onboarding-2" });
  await r.events.flush();
  r.events.recordOnboardingCompleted({ setupMode: "future", flowVersion: "desktop-onboarding-2" });
  await r.events.flush();

  const sent = r.batches().flatMap((call) => call.body.events.map((event) => event.properties));
  assert.deepEqual(sent, [{ replay: false, setup_mode: "cloud" }, { replay: true }]);
});

test("a guest completion has no identity to report and is not recorded", async () => {
  const r = rig({ scope: null });
  r.events.recordOnboardingCompleted({ setupMode: "cloud", flowVersion: "desktop-onboarding-2" });
  await r.events.flush();

  assert.deepEqual(r.queued(), []);
  assert.deepEqual(r.calls, []);
});

function queuedEvent(eventId, accountId = "a") {
  return {
    event_id: eventId,
    event_name: "onboarding_completed",
    occurred_at: "2026-11-04T07:00:00.000Z",
    account_id: accountId,
    identity_generation: 1,
    app_version: "1.12.0",
    flow_version: "desktop-onboarding-2",
    properties: { replay: false },
    captured_at: "2026-11-04T07:00:00.000Z",
  };
}

test("only accepted ids leave the queue; deferred and unlisted ones stay and go again", async () => {
  const r = rig();
  r.events.enqueue(queuedEvent("accepted-1"));
  r.events.enqueue(queuedEvent("deferred-1"));
  r.events.enqueue(queuedEvent("omitted-1"));
  r.server.defer.add("deferred-1");
  r.server.omit.add("omitted-1");
  await r.events.flush();

  assert.deepEqual(
    r.queued().map((event) => event.event_id),
    ["deferred-1", "omitted-1"]
  );
  // An API that learned the event takes it with the next upload.
  r.server.defer.clear();
  r.server.omit.clear();
  r.events.recordOnboardingCompleted({ setupMode: "cloud", flowVersion: "desktop-onboarding-2" });
  await r.events.flush();
  assert.equal(r.batches().at(-1).body.events.length, 3);
  assert.deepEqual(r.queued(), []);
});

test("events never upload under another account, and wait for their own", async () => {
  const r = rig();
  r.server.batchStatus = 503;
  r.events.recordOnboardingCompleted({ setupMode: "cloud", flowVersion: "desktop-onboarding-2" });
  await r.events.flush();
  const [aEvent] = r.queued();

  r.setScope({ accountId: "b", authGeneration: 2 });
  r.server.batchStatus = 200;
  await r.events.flush();
  const asB = r.batches().at(-1);
  assert.equal(asB.expectedAuthGeneration, 2);
  assert.deepEqual(asB.body.events, []);
  assert.deepEqual(
    r.queued().map((event) => event.event_id),
    [aEvent.event_id]
  );

  // A signs back in with a new credential.
  r.setScope({ accountId: "a", authGeneration: 3 });
  await r.events.flush();
  const asA = r.batches().at(-1);
  assert.equal(asA.expectedAuthGeneration, 3);
  assert.deepEqual(
    asA.body.events.map((event) => event.event_id),
    [aEvent.event_id]
  );
  assert.deepEqual(r.queued(), []);
});

test("an answer arriving after the account switched does not settle the queue", async () => {
  const r = rig();
  r.server.batchStatus = 503;
  r.events.recordOnboardingCompleted({ setupMode: "cloud", flowVersion: "desktop-onboarding-2" });
  await r.events.flush();
  r.server.batchStatus = 200;
  const original = r.events.request;
  r.events.request = async (opts) => {
    const result = await original(opts);
    r.setScope({ accountId: "b", authGeneration: 2 });
    return result;
  };
  await r.events.flush();

  assert.equal(r.queued().length, 1);
});

test("a policy block leaves the account unobserved and stops posting for that scope", async () => {
  const r = rig();
  r.server.batchStatus = 403;
  r.server.batchCode = "POLICY_CLOUD_BACKUP_BLOCKED";
  r.events.recordOnboardingCompleted({ setupMode: "cloud", flowVersion: "desktop-onboarding-2" });
  await r.events.flush();
  r.events.recordOnboardingCompleted({ setupMode: "cloud", flowVersion: "desktop-onboarding-2" });
  await r.events.flush();

  assert.equal(r.batches().length, 1);
  assert.equal(r.timers.length, 0);
  assert.equal(r.queued().length, 1);
});

test("an expired session waits for the next credential instead of retrying", async () => {
  const r = rig();
  r.server.batchStatus = 401;
  r.events.recordOnboardingCompleted({ setupMode: "cloud", flowVersion: "desktop-onboarding-2" });
  await r.events.flush();

  assert.equal(r.timers.length, 0);
  assert.equal(r.queued().length, 1);
});

test("coverage is reported once per scope even with nothing queued", async () => {
  const r = rig();
  await r.events.flush();
  await r.events.flush();
  r.setScope({ accountId: "a", authGeneration: 2 });
  await r.events.flush();

  assert.deepEqual(
    r.batches().map((call) => [call.expectedAuthGeneration, call.body.events.length]),
    [
      [1, 0],
      [2, 0],
    ]
  );
});

test("a queue survives a restart, and an event too old to matter is dropped", async () => {
  const store = memoryStore();
  const first = rig({ store });
  first.server.batchStatus = 503;
  first.events.recordOnboardingCompleted({
    setupMode: "cloud",
    flowVersion: "desktop-onboarding-2",
  });
  await first.events.flush();
  const installation = first.events.installationId();

  const restarted = rig({ store });
  assert.equal(restarted.events.installationId(), installation);
  assert.equal(restarted.queued().length, 1);
  assert.equal(restarted.events.state.onboardingCompletions, 1);

  restarted.advance(31 * 24 * 60 * 60_000);
  await restarted.events.flush();
  assert.deepEqual(restarted.queued(), []);
  assert.deepEqual(restarted.batches().at(-1).body.events, []);
});

test("a sign-in resent after a relaunch is the same event id", async () => {
  const store = memoryStore();
  const first = rig({ store });
  first.server.batchStatus = 503;
  await first.events.recordAppSession({ accountId: "a", authGeneration: 1 });

  const restarted = rig({ store });
  await restarted.events.recordAppSession({ accountId: "a", authGeneration: 1 });
  assert.deepEqual(
    restarted
      .batches()
      .at(-1)
      .body.events.map((event) => event.event_id),
    [BINDING]
  );

  restarted.server.bindingId = SECOND_BINDING;
  restarted.setScope({ accountId: "a", authGeneration: 2 });
  await restarted.events.recordAppSession({ accountId: "a", authGeneration: 2 });
  assert.deepEqual(
    restarted
      .batches()
      .at(-1)
      .body.events.map((event) => event.event_id),
    [SECOND_BINDING]
  );

  // Once the server has taken a sign-in, relaunching into the same session
  // binds it again but sends nothing more for it (the credential generation
  // starts over on every launch).
  const again = rig({ store, scope: { accountId: "a", authGeneration: 0 } });
  again.server.bindingId = BINDING;
  await again.events.recordAppSession({ accountId: "a", authGeneration: 0 });
  assert.equal(again.calls.filter((call) => call.route.endsWith("/app-session")).length, 1);
  assert.deepEqual(
    again.batches().flatMap((call) => call.body.events),
    []
  );
});

test("an event queued while an upload is in flight goes in a follow-up pass", async () => {
  const r = rig();
  const original = r.events.request;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  r.events.request = async (opts) => {
    if (opts.path.endsWith("/batch") && opts.body.events.length === 0) await held;
    return original(opts);
  };
  // The scope's coverage call is in flight when the sign-in is bound.
  const coverage = r.events.flush();
  const signIn = r.events.recordAppSession({ accountId: "a", authGeneration: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([coverage, signIn]);
  while (r.events.running) await r.events.running;

  assert.deepEqual(
    r.batches().map((call) => call.body.events.map((event) => event.event_name)),
    [[], ["app_session_authenticated"]]
  );
  assert.deepEqual(r.queued(), []);
});

test("erasing an account purges only its queued events", async () => {
  const r = rig();
  r.server.batchStatus = 503;
  r.events.recordOnboardingCompleted({ setupMode: "cloud", flowVersion: "desktop-onboarding-2" });
  r.setScope({ accountId: "b", authGeneration: 2 });
  r.events.recordOnboardingCompleted({ setupMode: "cloud", flowVersion: "desktop-onboarding-2" });
  await r.events.flush();

  r.events.purge("a");
  assert.deepEqual(
    r.queued().map((event) => event.account_id),
    ["b"]
  );
});

// F4 — dictation

function captureId(n) {
  return `7c9e6679-7425-40de-944b-${String(n).padStart(12, "0")}`;
}

function queuedPracticeEvent(index) {
  return {
    ...queuedEvent(captureId(1000 + index), "b"),
    event_name: "dictation_completed",
    properties: {
      word_count: 1,
      counter_version: 2,
      mode: "local",
      source: "dictation",
      is_practice: true,
      is_retranscribe: false,
    },
  };
}

function dictate(r, n, words, overrides = {}) {
  r.events.recordDictationCompleted(
    {
      captureId: captureId(n),
      words,
      mode: "local",
      practice: false,
      ...overrides,
    },
    r.getScope()
  );
}

function queuedDictation(r) {
  return r
    .queued()
    .filter((event) => event.event_name === "dictation_completed")
    .map((event) => [event.event_id, event.properties.word_count, event.properties.is_practice]);
}

test("a finished dictation goes up as its word count under the account, never its text", async () => {
  const r = rig();
  dictate(r, 1, 12);
  await r.events.flush();

  const [upload] = r.batches();
  assert.ok(CAPABILITIES.includes("dictation_completed"));
  assert.deepEqual(upload.body.collector.capabilities, CAPABILITIES);
  assert.equal(upload.expectedAuthGeneration, 1);
  assert.deepEqual(upload.body.events, [
    {
      event_id: captureId(1),
      event_name: "dictation_completed",
      schema_version: 1,
      occurred_at: "2026-11-04T08:00:05.000Z",
      app_version: "1.12.0",
      flow_version: null,
      identity_generation: 1,
      properties: {
        word_count: 12,
        counter_version: 2,
        mode: "local",
        source: "dictation",
        is_practice: false,
        is_retranscribe: false,
      },
    },
  ]);
  assert.deepEqual(r.queued(), []);
});

test("199 and then 1 word are both recorded, and nothing after this device's first 200", async () => {
  const r = rig();
  r.server.batchStatus = 503;
  dictate(r, 1, 199);
  dictate(r, 2, 1);
  dictate(r, 3, 40);

  assert.deepEqual(queuedDictation(r), [
    [captureId(1), 199, false],
    [captureId(2), 1, false],
  ]);
});

test("150 and then 75 words are both recorded, the later ones not", async () => {
  const r = rig();
  r.server.batchStatus = 503;
  dictate(r, 1, 150);
  dictate(r, 2, 75);
  dictate(r, 3, 10);

  assert.deepEqual(queuedDictation(r), [
    [captureId(1), 150, false],
    [captureId(2), 75, false],
  ]);
});

test("onboarding practice is recorded as practice and never brings the 200 closer", async () => {
  const r = rig();
  r.server.batchStatus = 503;
  dictate(r, 1, 180, { practice: true });
  dictate(r, 2, 150);
  dictate(r, 3, 49);
  dictate(r, 4, 1);
  dictate(r, 5, 1);

  assert.deepEqual(queuedDictation(r), [
    [captureId(1), 180, true],
    [captureId(2), 150, false],
    [captureId(3), 49, false],
    [captureId(4), 1, false],
  ]);
});

test("one capture reported twice is one event and counts once", async () => {
  const r = rig();
  r.server.batchStatus = 503;
  dictate(r, 1, 150);
  dictate(r, 1, 150);
  dictate(r, 2, 49);

  assert.deepEqual(queuedDictation(r), [
    [captureId(1), 150, false],
    [captureId(2), 49, false],
  ]);
  assert.deepEqual(r.events.state.dictationWords, { a: 199 });
});

test("a dictation without a capture id or words records nothing, and an odd mode reads unknown", async () => {
  const r = rig();
  r.server.batchStatus = 503;
  dictate(r, 1, 0);
  dictate(r, 2, 1.5);
  dictate(r, 3, Number.NaN);
  r.events.recordDictationCompleted({ captureId: "recording-1", words: 5, practice: false });
  r.events.recordDictationCompleted({ captureId: null, words: 5, practice: false });
  dictate(r, 4, 5, { mode: "telepathy" });

  assert.deepEqual(
    r.queued().map((event) => [event.event_id, event.properties.mode]),
    [[captureId(4), "unknown"]]
  );
});

test("a guest's dictation has no identity to report and is not recorded", async () => {
  const r = rig({ scope: null });
  dictate(r, 1, 50);
  await r.events.flush();

  assert.deepEqual(r.queued(), []);
  assert.deepEqual(r.events.state.dictationWords, {});
  assert.equal(r.calls.length, 0);
});

test("dictation keeps its account through a switch, and each account counts its own 200", async () => {
  const r = rig();
  r.server.batchStatus = 503;
  dictate(r, 1, 150);
  r.setScope({ accountId: "b", authGeneration: 2 });
  dictate(r, 2, 199);
  dictate(r, 3, 5);
  dictate(r, 4, 1);
  r.server.batchStatus = 200;
  await r.events.flush();

  // B's session sends only B's dictation; A's waits for A.
  assert.deepEqual(
    r
      .batches()
      .at(-1)
      .body.events.map((event) => event.event_id),
    [captureId(2), captureId(3)]
  );
  assert.deepEqual(
    r.queued().map((event) => [event.account_id, event.event_id]),
    [["a", captureId(1)]]
  );
  assert.deepEqual(r.events.state.dictationWords, { a: 150, b: 204 });
});

test("a dictation recorded offline goes up later with its own completion time", async () => {
  const r = rig();
  r.server.batchStatus = 503;
  dictate(r, 1, 30);
  await r.events.flush();
  assert.equal(r.timers.length, 1);

  r.advance(2 * 60 * 60_000);
  r.server.batchStatus = 200;
  await r.timers[0].fn();
  await r.events.running;

  const upload = r.batches().at(-1);
  assert.equal(upload.body.events[0].occurred_at, "2026-11-04T08:00:05.000Z");
  assert.equal(upload.body.collector.sent_at, "2026-11-04T10:00:05.000Z");
  assert.deepEqual(r.queued(), []);
});

test("a policy block drops queued dictation and queues none while it lasts", async () => {
  const r = rig();
  r.server.batchStatus = 403;
  r.server.batchCode = "POLICY_CLOUD_BACKUP_BLOCKED";
  dictate(r, 1, 30);
  await r.events.flush();
  assert.deepEqual(r.queued(), []);

  dictate(r, 2, 60);
  assert.deepEqual(r.queued(), []);
  assert.deepEqual(r.events.state.dictationWords, { a: 0 });
});

test("an accepted privacy rejection releases the ceiling for dictations after opt-in", async () => {
  const client = rig();
  client.server.reject.set(captureId(1), "before_opt_in");
  dictate(client, 1, 200);
  await client.events.flush();

  assert.deepEqual(client.queued(), []);
  assert.deepEqual(client.events.state.dictationWords, { a: 0 });
  client.events.dispose();

  const restarted = rig({ store: client.store });
  dictate(restarted, 2, 200);
  await restarted.events.flush();
  assert.deepEqual(
    restarted.batches().flatMap((batch) => batch.body.events.map((event) => event.event_id)),
    [captureId(2)]
  );
  assert.deepEqual(restarted.events.state.dictationWords, { a: 200 });
});

test("a mixed acknowledgement releases only rejected dictation progress", async () => {
  const client = rig();
  dictate(client, 1, 40);
  await client.events.flush();
  client.server.batchStatus = 503;
  await client.events.recordAppSession(client.getScope());
  client.events.recordOnboardingCompleted();
  dictate(client, 2, 80);
  dictate(client, 3, 30);
  dictate(client, 4, 20);
  dictate(client, 5, 500, { practice: true });
  dictate(client, 6, 30);
  await client.events.flush();

  client.server.reject.set(captureId(2), "before_opt_in");
  client.server.reject.set(captureId(5), "before_opt_in");
  client.server.reject.set(BINDING, "before_opt_in");
  client.server.duplicates.add(captureId(4));
  client.server.defer.add(captureId(6));
  client.server.batchStatus = 200;
  await client.events.flush();

  assert.deepEqual(queuedDictation(client), [[captureId(6), 30, false]]);
  assert.deepEqual(client.events.state.dictationWords, { a: 120 });
  assert.deepEqual(client.events.state.acknowledgedBindings, [BINDING]);

  client.server.defer.clear();
  dictate(client, 7, 80);
  await client.events.flush();
  assert.deepEqual(client.queued(), []);
  assert.deepEqual(client.events.state.dictationWords, { a: 200 });
  assert.ok(
    client
      .batches()
      .some((batch) => batch.body.events.some((event) => event.event_id === captureId(7)))
  );
});

test("policy recovery releases discarded words but preserves acknowledged progress across restarts", async () => {
  const client = rig();
  dictate(client, 1, 75);
  await client.events.flush();
  client.setScope({ accountId: "b", authGeneration: 2 });
  dictate(client, 2, 190);
  await client.events.flush();
  client.setScope({ accountId: "a", authGeneration: 3 });
  client.server.batchStatus = 503;
  dictate(client, 3, 500, { practice: true });
  dictate(client, 4, 150);
  await client.events.flush();
  client.server.batchStatus = 403;
  client.server.batchCode = "POLICY_CLOUD_BACKUP_BLOCKED";
  await client.events.flush();
  assert.deepEqual(client.queued(), []);
  assert.deepEqual(client.events.state.dictationWords, { a: 75, b: 190 });
  client.events.dispose();

  const restarted = rig({ store: client.store });
  dictate(restarted, 5, 125);
  await restarted.events.flush();
  dictate(restarted, 6, 1);
  await restarted.events.flush();
  assert.deepEqual(
    restarted.batches().flatMap((batch) => batch.body.events.map((event) => event.event_id)),
    [captureId(5)]
  );
  assert.deepEqual(restarted.events.state.dictationWords, { a: 200, b: 190 });
});

test("expired dictations release the ceiling before the next capture, keeping fresh and acknowledged words", async () => {
  const client = rig();
  dictate(client, 1, 75);
  await client.events.flush();
  client.server.batchStatus = 503;
  dictate(client, 2, 500, { practice: true });
  dictate(client, 3, 125);
  await client.events.flush();
  client.advance(29 * 24 * 60 * 60_000);
  client.setScope({ accountId: "b", authGeneration: 2 });
  dictate(client, 4, 40);
  await client.events.flush();
  client.advance(2 * 24 * 60 * 60_000);
  client.setScope({ accountId: "a", authGeneration: 3 });
  client.server.batchStatus = 200;

  dictate(client, 5, 125);
  await client.events.flush();
  assert.deepEqual(
    client
      .batches()
      .at(-1)
      .body.events.map((event) => event.event_id),
    [captureId(5)]
  );
  assert.deepEqual(queuedDictation(client), [[captureId(4), 40, false]]);
  assert.deepEqual(client.events.state.dictationWords, { a: 200, b: 40 });
  dictate(client, 6, 1);
  assert.deepEqual(queuedDictation(client), [[captureId(4), 40, false]]);
});

test("bounded queue eviction releases only unacknowledged dictation words", async () => {
  const client = rig();
  dictate(client, 1, 50);
  await client.events.flush();
  client.server.batchStatus = 503;
  dictate(client, 2, 150);
  await client.events.flush();
  for (let index = 0; index < 300; index += 1) {
    client.events.enqueue(queuedPracticeEvent(index));
  }
  assert.equal(client.queued().length, 200);
  assert.deepEqual(client.events.state.dictationWords, { a: 50 });
  client.server.batchStatus = 200;
  dictate(client, 3, 150);
  await client.events.flush();
  while (client.events.running) await client.events.running;
  assert.ok(
    client
      .batches()
      .some((batch) => batch.body.events.some((event) => event.event_id === captureId(3)))
  );
  assert.deepEqual(client.events.state.dictationWords, { a: 200 });
});

for (const lifecycle of ["same account", "account switch", "account erasure"]) {
  test(`in-flight dictation survives queue pressure and expiry after ${lifecycle}`, async () => {
    const client = rig();
    const request = client.events.request;
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    client.events.request = async (options) => {
      await held;
      return request(options);
    };
    dictate(client, 1, 250);
    const upload = client.events.running;
    for (let index = 0; index < 300; index += 1) {
      client.events.enqueue(queuedPracticeEvent(index));
    }
    client.advance(31 * 24 * 60 * 60_000);
    client.events.dropExpired();
    assert.deepEqual(queuedDictation(client), [[captureId(1), 250, false]]);
    assert.deepEqual(client.events.state.dictationWords, { a: 250 });
    if (lifecycle === "account switch") client.setScope({ accountId: "b", authGeneration: 2 });
    if (lifecycle === "account erasure") client.events.purge("a");
    release();
    await upload;
    assert.deepEqual(
      client.events.state.dictationWords,
      lifecycle === "account erasure" ? {} : { a: 250 }
    );
  });
}

for (const rejected of [false, true]) {
  test(`the real auth fence keeps a ${rejected ? "rejected" : "stored"} dictation retryable after an account switch`, async () => {
    const client = rig();
    let auth = { token: "test-token-a", generation: 1 };
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const received = [];
    client.events.request = createCloudApiRequestHandler({
      getApiUrl: () => "https://api.example.test",
      getAppVersion: () => "1.12.0",
      tokenStore: { getState: () => auth },
      proxyFetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        received.push(body.events);
        await held;
        return new Response(
          JSON.stringify({
            accepted: body.events.map((event) => event.event_id),
            stored: body.events
              .filter((event) => !rejected || event.event_id !== captureId(1))
              .map((event) => event.event_id),
            duplicates: [],
            conflicts: [],
            rejected: body.events
              .filter((event) => rejected && event.event_id === captureId(1))
              .map((event) => ({ event_id: event.event_id, reason: "before_opt_in" })),
            deferred: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });
    dictate(client, 1, 250);
    const upload = client.events.running;
    for (let index = 0; index < 300; index += 1) {
      client.events.enqueue(queuedPracticeEvent(index));
    }
    assert.equal(client.queued().length, 200);
    client.setScope({ accountId: "b", authGeneration: 2 });
    auth = { token: "test-token-b", generation: 2 };
    release();
    await upload;
    assert.ok(client.queued().some((event) => event.event_id === captureId(1)));
    assert.deepEqual(client.events.state.dictationWords, { a: 250 });

    client.setScope({ accountId: "a", authGeneration: 3 });
    auth = { token: "test-token-a-new", generation: 3 };
    dictate(client, 2, 250);
    await client.events.flush();
    assert.deepEqual(
      received.flat().map((event) => event.event_id),
      [captureId(1), captureId(1)]
    );
    assert.equal(
      client.queued().some((event) => event.event_id === captureId(1)),
      false
    );
    assert.deepEqual(client.events.state.dictationWords, { a: rejected ? 0 : 250 });
    if (rejected) {
      dictate(client, 3, 200);
      await client.events.flush();
      assert.deepEqual(
        received.flat().map((event) => event.event_id),
        [captureId(1), captureId(1), captureId(3)]
      );
      assert.deepEqual(client.events.state.dictationWords, { a: 200 });
    }
  });
}

test("a rejection arriving after erasure cannot decrement the replacement account", async () => {
  const client = rig();
  client.server.reject.set(captureId(1), "before_opt_in");
  const request = client.events.request;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  client.events.request = async (options) => {
    const result = await request(options);
    await held;
    return result;
  };
  dictate(client, 1, 200);
  const upload = client.events.running;
  client.events.purge("a");
  client.setScope({ accountId: "b", authGeneration: 2 });
  dictate(client, 2, 100);
  release();
  await upload;
  while (client.events.running) await client.events.running;

  assert.deepEqual(client.events.state.dictationWords, { b: 100 });
  assert.deepEqual(client.queued(), []);
});

test("erasing an account purges its dictation and its word count, and only its own", async () => {
  const r = rig();
  r.server.batchStatus = 503;
  dictate(r, 1, 150);
  r.setScope({ accountId: "b", authGeneration: 2 });
  dictate(r, 2, 120);

  r.events.purge("a");
  assert.deepEqual(
    r.queued().map((event) => event.account_id),
    ["b"]
  );
  assert.deepEqual(r.events.state.dictationWords, { b: 120 });
});

test("a late dictation cannot restore an erased account's queue or word count", async () => {
  const client = rig();
  client.server.batchStatus = 503;
  dictate(client, 1, 150);
  await client.events.flush();

  client.events.purge("a");
  const requestsBefore = client.calls.length;
  dictate(client, 2, 50);
  await client.events.flush();

  assert.deepEqual(client.queued(), []);
  assert.deepEqual(client.events.state.dictationWords, {});
  assert.equal(client.calls.length, requestsBefore);
});

test("a dictation completing after disposal leaves the persisted queue untouched", async () => {
  const client = rig();
  client.server.batchStatus = 503;
  dictate(client, 1, 150);
  await client.events.flush();
  const savedBefore = structuredClone(client.store.saved());
  const requestsBefore = client.calls.length;

  client.events.dispose();
  dictate(client, 2, 50);
  await client.events.flush();

  assert.deepEqual(client.store.saved(), savedBefore);
  assert.equal(client.calls.length, requestsBefore);
});

test("the file store writes atomically and starts fresh from an unreadable file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "product-events-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nested", "product-events.json");
  const store = createFileStore(file);

  assert.deepEqual(store.load().events, []);
  store.save({ version: 1, installationId: "i", onboardingCompletions: 2, events: [{ x: 1 }] });
  assert.deepEqual(createFileStore(file).load().events, [{ x: 1 }]);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")),
    []
  );

  fs.writeFileSync(file, "{not json");
  assert.deepEqual(createFileStore(file).load(), {
    version: 1,
    installationId: null,
    onboardingCompletions: 0,
    acknowledgedBindings: [],
    dictationWords: {},
    events: [],
  });
});

test("the first 200 offline one-word dictations retain sign-in and onboarding milestones", async () => {
  const client = rig();
  client.server.batchStatus = 503;
  await client.events.recordAppSession({ accountId: "a", authGeneration: 1 });
  client.events.recordOnboardingCompleted({ setupMode: "local", flowVersion: "v1" });
  await client.events.flush();
  for (let index = 1; index <= 200; index += 1) {
    dictate(client, index, 1);
    await client.events.flush();
  }

  assert.equal(client.queued().length, 202);
  assert.equal(queuedDictation(client).length, 200);
  assert.ok(client.queued().some((event) => event.event_name === "app_session_authenticated"));
  assert.ok(client.queued().some((event) => event.event_name === "onboarding_completed"));
  client.server.batchStatus = 200;
  await client.events.flush();
  while (client.events.running) await client.events.running;
  assert.deepEqual(client.queued(), []);
  assert.deepEqual(client.events.state.dictationWords, { a: 200 });
});

test("dictations and milestones have independent bounded queue capacity", async () => {
  const client = rig();
  client.server.batchStatus = 503;
  for (let index = 0; index < 250; index += 1) {
    client.events.enqueue(queuedEvent(`onboarding-${index}`));
  }
  for (let index = 1; index <= 300; index += 1) {
    dictate(client, index, 1, { practice: true });
    await client.events.flush();
  }

  assert.equal(
    client.queued().filter((event) => event.event_name !== "dictation_completed").length,
    200
  );
  assert.equal(queuedDictation(client).length, 200);
  assert.equal(client.queued().length, 400);
  assert.deepEqual(client.events.state.dictationWords, {});
});

test("a policy refusal discards all of its account's pending dictations across batches", async () => {
  const client = rig();
  client.server.batchStatus = 503;
  for (let index = 1; index <= 100; index += 1) {
    dictate(client, index, 2);
    await client.events.flush();
  }
  client.setScope({ accountId: "b", authGeneration: 2 });
  dictate(client, 101, 30);
  await client.events.flush();
  client.setScope({ accountId: "a", authGeneration: 3 });
  client.server.batchStatus = 403;
  client.server.batchCode = "POLICY_CLOUD_BACKUP_BLOCKED";
  await client.events.flush();

  assert.deepEqual(client.events.state.dictationWords, { a: 0, b: 30 });
  assert.deepEqual(queuedDictation(client), [[captureId(101), 30, false]]);
  client.setScope({ accountId: "a", authGeneration: 4 });
  client.server.batchStatus = 200;
  dictate(client, 102, 200);
  await client.events.flush();
  assert.equal(client.batches().at(-1).body.events[0].event_id, captureId(102));
  assert.deepEqual(client.events.state.dictationWords, { a: 200, b: 30 });
});

test("a dictation fact without an explicit capture scope never adopts the active account", async () => {
  const client = rig();
  client.events.recordDictationCompleted({
    captureId: captureId(1),
    words: 25,
    mode: "local",
    practice: false,
  });
  await client.events.flush();

  assert.deepEqual(client.events.state.dictationWords, {});
  assert.equal(client.batches().flatMap((batch) => batch.body.events).length, 0);
});
