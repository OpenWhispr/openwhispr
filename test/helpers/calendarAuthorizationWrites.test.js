const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const originalLoad = Module._load;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
const idToken = (email) =>
  `header.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.signature`;

test("calendar OAuth cancellation fences token writes after a callback has started", async () => {
  for (const provider of ["google", "microsoft"]) {
    const file = require.resolve(`../../src/helpers/${provider}CalendarOAuth`);
    let flow;
    Module._load = function (request, parent, isMain) {
      if (request === "electron") return { net: {} };
      if (parent?.filename === file && request === "./oauthLoopbackFlow")
        return {
          runOAuthLoopbackFlow: (options) => {
            flow = options;
            return options;
          },
          OAuthFlowError: Error,
        };
      return originalLoad.call(this, request, parent, isMain);
    };
    let OAuth;
    try {
      delete require.cache[file];
      OAuth = require(file);
    } finally {
      Module._load = originalLoad;
    }
    const saved = [];
    const oauth = new OAuth({
      saveGoogleTokens: (value) => saved.push(value),
      saveMicrosoftTokens: (value) => saved.push(value),
    });
    oauth.getClientId = () => "fixture";
    const gate = deferred(),
      controller = new AbortController();
    oauth.exchangeCodeForTokens = () => gate.promise;
    oauth.startOAuthFlow({ signal: controller.signal });
    const callback = flow.handleCallback("code", "http://localhost", "verifier");
    controller.abort();
    gate.resolve({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      id_token: idToken("calendar@test"),
    });
    const result = await callback.then(
      () => "connected",
      () => "cancelled"
    );
    assert.deepEqual(saved, [], provider);
    assert.equal(result, "cancelled", provider);
  }
});

test("calendar managers do not add an account after authorization was cancelled", async () => {
  for (const provider of ["google", "microsoft"]) {
    const file = require.resolve(`../../src/helpers/${provider}CalendarManager`);
    Module._load = function (request, parent, isMain) {
      if (request === "electron") return { net: {}, BrowserWindow: { getAllWindows: () => [] } };
      return originalLoad.call(this, request, parent, isMain);
    };
    let Manager;
    try {
      delete require.cache[file];
      Manager = require(file);
    } finally {
      Module._load = originalLoad;
    }
    const manager = provider === "google" ? new Manager({}, {}, {}) : new Manager({}, {});
    let added = 0;
    const controller = new AbortController();
    manager.oauth.startOAuthFlow = async () => {
      controller.abort();
      return { success: true, email: "late@test" };
    };
    manager.addAccount = () => added++;
    manager.fetchCalendars = async () => {};
    manager.syncEvents = async () => {};
    manager.reminderScheduler.scheduleNextMeeting = () => {};
    manager.syncRunner.start = () => {};
    await manager.startOAuth({ signal: controller.signal }).catch(() => {});
    assert.equal(added, 0, provider);
  }
});

test("Apple cancellation stops the authorization helper and ignores its late snapshot", async (t) => {
  const file = require.resolve("../../src/helpers/appleCalendarManager");
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", { value: platform }));
  const children = [];
  Module._load = function (request, parent, isMain) {
    if (request === "electron")
      return { app: { isPackaged: true }, BrowserWindow: { getAllWindows: () => [] } };
    if (parent?.filename === file && request === "./binaryResolver")
      return { resolveBundledBinary: () => "/fixture/helper" };
    if (parent?.filename === file && request === "child_process")
      return {
        spawn: () => {
          const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill() {
              this.killed = true;
            },
          });
          children.push(child);
          return child;
        },
      };
    return originalLoad.call(this, request, parent, isMain);
  };
  let Manager;
  try {
    delete require.cache[file];
    Manager = require(file);
  } finally {
    Module._load = originalLoad;
  }
  let writes = 0;
  const manager = new Manager(
    {
      getAppleCalendars: () => [],
      saveAppleCalendars: () => writes++,
      replaceAppleCalendarEvents() {},
      syncCalendarContacts() {},
    },
    { scheduleNextMeeting() {} }
  );
  t.after(() => manager.stop());
  const first = new AbortController();
  const pending = manager.connect({ signal: first.signal });
  first.abort();
  children[0].stdout.emit("data", Buffer.from('{"type":"snapshot","calendars":[],"events":[]}\n'));
  assert.equal(writes, 0);
  assert.equal(children[0].killed, true);
  assert.equal((await pending).reason, "cancelled");
  const second = new AbortController();
  const next = manager.connect({ signal: second.signal });
  first.abort();
  assert.equal(children[1].killed, undefined);
  children[1].stdout.emit(
    "data",
    Buffer.from(
      '{"type":"permission","status":"granted"}\n{"type":"snapshot","calendars":[],"events":[]}\n'
    )
  );
  assert.equal((await next).success, true);
});
