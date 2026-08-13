const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const notifierPath = require.resolve("../../src/helpers/linuxNotifier");
const originalLoad = Module._load;

function loadModule() {
  delete require.cache[notifierPath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./debugLogger") {
      return { info() {}, warn() {}, debug() {}, error() {}, log() {} };
    }
    if (request === "@homebridge/dbus-native") {
      return { sessionBus: () => null };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(notifierPath);
  } finally {
    Module._load = originalLoad;
  }
}

function createFakeDbus({
  capabilities = ["actions", "body"],
  notifyId = 42,
  interfaceError = null,
  failFirstInterface = false,
  hangNotify = false,
} = {}) {
  const iface = new EventEmitter();
  const notifyCalls = [];
  const closeCalls = [];
  const connections = [];
  let interfaceRequests = 0;

  iface.GetCapabilities = (cb) => process.nextTick(cb, null, capabilities);
  iface.Notify = (...args) => {
    const cb = args.pop();
    notifyCalls.push(args);
    if (!hangNotify) process.nextTick(cb, null, notifyId);
  };
  iface.CloseNotification = (id, cb) => {
    closeCalls.push(id);
    if (cb) process.nextTick(cb, null);
  };

  const module = {
    sessionBus: () => {
      const connection = new EventEmitter();
      connection.end = () => {};
      connections.push(connection);
      return {
        connection,
        getService: () => ({
          getInterface: (path, name, cb) => {
            interfaceRequests += 1;
            const failThis = interfaceError || (failFirstInterface && interfaceRequests === 1);
            process.nextTick(() =>
              failThis ? cb(interfaceError || new Error("first connect fails")) : cb(null, iface)
            );
          },
        }),
      };
    },
  };

  return { module, iface, notifyCalls, closeCalls, connections };
}

function baseShowArgs(overrides = {}) {
  return {
    title: "Meeting detected",
    body: "Want to take notes?",
    actionKey: "start",
    actionLabel: "Take notes",
    timeoutMs: 30000,
    onAction: () => {},
    onClose: () => {},
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("native delivery is gated to Linux", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus();

  for (const platform of ["darwin", "win32"]) {
    const notifier = new LinuxNotifier({ platform, dbusModule: fake.module });
    assert.equal(notifier.isSupported(), false);
    assert.equal(await notifier.show(baseShowArgs()), null);
  }
  assert.equal(fake.notifyCalls.length, 0);
});

test("a missing dbus module means unsupported instead of a crash", async () => {
  const { LinuxNotifier } = loadModule();
  const notifier = new LinuxNotifier({ platform: "linux", dbusModule: null });

  assert.equal(notifier.isSupported(), false);
  assert.equal(await notifier.show(baseShowArgs()), null);
});

test("a server without the actions capability backs off to the overlay", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus({ capabilities: ["body"] });
  const notifier = new LinuxNotifier({ platform: "linux", dbusModule: fake.module, now: () => 0 });

  assert.equal(await notifier.show(baseShowArgs()), null);
  assert.equal(fake.notifyCalls.length, 0);
  assert.equal(notifier.isSupported(), false);
});

test("a connection failure backs off to the overlay", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus({ interfaceError: new Error("no notification service") });
  const notifier = new LinuxNotifier({ platform: "linux", dbusModule: fake.module, now: () => 0 });

  assert.equal(await notifier.show(baseShowArgs()), null);
  assert.equal(notifier.isSupported(), false);
});

test("a daemon that never answers Notify times out into fallback", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus({ hangNotify: true });
  let clock = 0;
  const notifier = new LinuxNotifier({
    platform: "linux",
    dbusModule: fake.module,
    callTimeoutMs: 20,
    now: () => clock,
  });

  assert.equal(await notifier.show(baseShowArgs()), null);
  assert.equal(notifier.isSupported(), false);
});

test("native delivery retries with a fresh connection after the backoff window", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus({ failFirstInterface: true });
  let clock = 0;
  const notifier = new LinuxNotifier({
    platform: "linux",
    dbusModule: fake.module,
    now: () => clock,
  });

  assert.equal(await notifier.show(baseShowArgs()), null);
  assert.equal(notifier.isSupported(), false);

  clock = 31 * 1000;
  assert.equal(notifier.isSupported(), true);
  const handle = await notifier.show(baseShowArgs());
  assert.equal(handle.id, 42);
  assert.equal(fake.connections.length, 2);
});

test("a successful show resets the failure backoff", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus({ failFirstInterface: true });
  let clock = 0;
  const notifier = new LinuxNotifier({
    platform: "linux",
    dbusModule: fake.module,
    now: () => clock,
  });

  await notifier.show(baseShowArgs());
  clock = 31 * 1000;
  await notifier.show(baseShowArgs());
  assert.equal(notifier._failureCount, 0);
  assert.equal(notifier.isSupported(), true);
});

test("the whole native attempt shares one deadline instead of stacking per-call timeouts", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus({ hangNotify: true });
  const notifier = new LinuxNotifier({
    platform: "linux",
    dbusModule: fake.module,
    callTimeoutMs: 60,
  });

  const started = Date.now();
  assert.equal(await notifier.show(baseShowArgs()), null);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 150, `expected a single ~60ms deadline, took ${elapsed}ms`);
});

test("Notify carries paired actions, byte urgency and the desktop-entry hint", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus();
  const notifier = new LinuxNotifier({ platform: "linux", dbusModule: fake.module });

  const handle = await notifier.show(baseShowArgs({ actionKey: "join", actionLabel: "Join" }));
  assert.equal(handle.id, 42);

  const [appName, replacesId, appIcon, summary, body, actions, hints, expireTimeout] =
    fake.notifyCalls[0];
  assert.equal(appName, "OpenWhispr");
  assert.equal(replacesId, 0);
  assert.equal(appIcon, "open-whispr");
  assert.equal(summary, "Meeting detected");
  assert.equal(body, "Want to take notes?");
  assert.deepEqual(actions, ["default", "Join", "join", "Join"]);
  assert.deepEqual(hints, [
    ["urgency", ["y", 1]],
    ["desktop-entry", ["s", "open-whispr"]],
  ]);
  assert.equal(expireTimeout, 30000);
});

test("the app identifier is shared with linuxAutostart", async () => {
  loadModule();
  const { LINUX_APP_NAME } = require("../../src/helpers/linuxAutostart");
  assert.equal(LINUX_APP_NAME, "open-whispr");
});

test("replacing a prompt forwards the previous notification id", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus();
  const notifier = new LinuxNotifier({ platform: "linux", dbusModule: fake.module });

  await notifier.show(baseShowArgs({ replacesId: 42 }));
  assert.equal(fake.notifyCalls[0][1], 42);
});

test("the body is entity-escaped only when the server parses markup", async () => {
  const { LinuxNotifier } = loadModule();
  const body = "a <b> & c";

  const plain = createFakeDbus({ capabilities: ["actions", "body"] });
  const plainNotifier = new LinuxNotifier({ platform: "linux", dbusModule: plain.module });
  await plainNotifier.show(baseShowArgs({ body }));
  assert.equal(plain.notifyCalls[0][4], "a <b> & c");

  const markup = createFakeDbus({ capabilities: ["actions", "body", "body-markup"] });
  const markupNotifier = new LinuxNotifier({ platform: "linux", dbusModule: markup.module });
  await markupNotifier.show(baseShowArgs({ body }));
  assert.equal(markup.notifyCalls[0][4], "a &lt;b&gt; &amp; c");
});

test("clicking the notification body invokes the primary action", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus();
  const notifier = new LinuxNotifier({ platform: "linux", dbusModule: fake.module });

  const actions = [];
  await notifier.show(baseShowArgs({ onAction: (a) => actions.push(a) }));
  fake.iface.emit("ActionInvoked", 42, "default");
  await flush();
  assert.deepEqual(actions, ["start"]);
});

test("signals for other notification ids are ignored", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus();
  const notifier = new LinuxNotifier({ platform: "linux", dbusModule: fake.module });

  const actions = [];
  const closes = [];
  await notifier.show(
    baseShowArgs({ onAction: (a) => actions.push(a), onClose: (r) => closes.push(r) })
  );
  fake.iface.emit("ActionInvoked", 7, "start");
  fake.iface.emit("NotificationClosed", 7, 2);
  await flush();
  assert.deepEqual(actions, []);
  assert.deepEqual(closes, []);
});

test("user dismissal and expiry reach onClose, our own close does not", async () => {
  const { LinuxNotifier } = loadModule();

  for (const [reason, expected] of [
    [1, [1]],
    [2, [2]],
    [3, []],
  ]) {
    const fake = createFakeDbus();
    const notifier = new LinuxNotifier({ platform: "linux", dbusModule: fake.module });
    const closes = [];
    await notifier.show(baseShowArgs({ onClose: (r) => closes.push(r) }));
    fake.iface.emit("NotificationClosed", 42, reason);
    await flush();
    assert.deepEqual(closes, expected, `reason ${reason}`);
  }
});

test("close() removes the notification and mutes the trailing closed signal", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus();
  const notifier = new LinuxNotifier({ platform: "linux", dbusModule: fake.module });

  const closes = [];
  const handle = await notifier.show(baseShowArgs({ onClose: (r) => closes.push(r) }));
  handle.close();
  fake.iface.emit("NotificationClosed", 42, 3);
  await flush();
  assert.deepEqual(fake.closeCalls, [42]);
  assert.deepEqual(closes, []);
});

test("an invoked action settles the prompt before the daemon's close signal", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus();
  const notifier = new LinuxNotifier({ platform: "linux", dbusModule: fake.module });

  const actions = [];
  const closes = [];
  await notifier.show(
    baseShowArgs({ onAction: (a) => actions.push(a), onClose: (r) => closes.push(r) })
  );
  fake.iface.emit("ActionInvoked", 42, "start");
  fake.iface.emit("NotificationClosed", 42, 2);
  await flush();
  assert.deepEqual(actions, ["start"]);
  assert.deepEqual(closes, []);
});

test("a dead connection expires live prompts so their owners can recover", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus();
  const notifier = new LinuxNotifier({ platform: "linux", dbusModule: fake.module, now: () => 0 });

  const closes = [];
  await notifier.show(baseShowArgs({ onClose: (r) => closes.push(r) }));
  fake.connections[0].emit("error", new Error("daemon went away"));
  assert.deepEqual(closes, [1]);
  assert.equal(notifier._active.size, 0);
  assert.equal(notifier.isSupported(), false);
});

test("stop() closes notifications still on screen", async () => {
  const { LinuxNotifier } = loadModule();
  const fake = createFakeDbus();
  const notifier = new LinuxNotifier({ platform: "linux", dbusModule: fake.module });

  await notifier.show(baseShowArgs());
  notifier.stop();
  assert.deepEqual(fake.closeCalls, [42]);
});

test("meeting prompt content mirrors the overlay copy", async () => {
  const { buildMeetingPromptContent } = loadModule();
  const { i18nMain } = require("../../src/helpers/i18nMain");
  const t = (key, opts) => i18nMain.t(key, opts);

  const detected = buildMeetingPromptContent(
    { variant: "detected", event: { summary: "Weekly sync" }, joinUrl: null },
    t
  );
  assert.equal(detected.title, "Meeting detected");
  assert.equal(detected.body, "It sounds like you're in a meeting. Want to take notes?");
  assert.equal(detected.actionKey, "start");
  assert.equal(detected.actionLabel, "Take notes");

  const starting = buildMeetingPromptContent(
    { variant: "starting", event: { summary: "Weekly sync" }, joinUrl: "https://meet.example" },
    t
  );
  assert.equal(starting.title, "Weekly sync");
  assert.equal(starting.body, "Your meeting is starting. Want to take notes?");
  assert.equal(starting.actionKey, "join");
  assert.equal(starting.actionLabel, "Join & transcribe");

  const underway = buildMeetingPromptContent({ variant: "underway", event: {} }, t);
  assert.equal(underway.title, "Meeting detected");
  assert.equal(underway.body, "It sounds like your meeting is underway. Want to take notes?");
});

test("an unknown prompt variant falls back to the detected copy", async () => {
  const { buildMeetingPromptContent } = loadModule();
  const { i18nMain } = require("../../src/helpers/i18nMain");

  const content = buildMeetingPromptContent(
    { variant: "surprise", event: { summary: "Weekly sync" } },
    (key, opts) => i18nMain.t(key, opts)
  );
  assert.equal(content.title, "Meeting detected");
  assert.equal(content.body, "It sounds like you're in a meeting. Want to take notes?");
});

test("update prompt content interpolates the version", async () => {
  const { buildUpdatePromptContent } = loadModule();
  const { i18nMain } = require("../../src/helpers/i18nMain");

  const content = buildUpdatePromptContent({ version: "1.9.0" }, (key, opts) =>
    i18nMain.t(key, opts)
  );
  assert.equal(content.title, "OpenWhispr Update Available");
  assert.equal(content.body, "Version 1.9.0 is ready to download");
  assert.equal(content.actionKey, "update");
  assert.equal(content.actionLabel, "Update Now");
});

test("oversized calendar summaries are truncated before hitting the daemon", async () => {
  const { buildMeetingPromptContent } = loadModule();

  const content = buildMeetingPromptContent(
    { variant: "starting", event: { summary: "x".repeat(2000) } },
    (key) => key
  );
  assert.equal(content.title.length, 512);
});

test("truncation never leaves a dangling surrogate at the cut point", async () => {
  const { buildMeetingPromptContent } = loadModule();

  const content = buildMeetingPromptContent(
    { variant: "starting", event: { summary: "x".repeat(511) + "\u{1F600}".repeat(10) } },
    (key) => key
  );
  assert.equal(content.title.length, 511);
  assert.equal(content.title.at(-1), "x");
});
