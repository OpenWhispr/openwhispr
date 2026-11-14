const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CAPABILITIES, ProductEvents, createFileStore } = require("../../src/helpers/productEvents");

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
    events: [],
  });
});
