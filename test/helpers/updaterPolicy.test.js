const test = require("node:test");
const { afterEach, beforeEach } = test;
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const originalLoad = Module._load;
const originalPlatform = process.platform;
const originalEnvironment = process.env.NODE_ENV;
const originalAppImage = process.env.APPIMAGE;
const modulePath = require.resolve("../../src/updater.js");
const managers = [];
const flush = () => new Promise(setImmediate);
const managed = (mode) => ({ success: true, managed: true, policy: { updates: { mode } } });

beforeEach((t) => {
  process.env.NODE_ENV = "test";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup();
  Module._load = originalLoad;
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
  if (originalAppImage === undefined) delete process.env.APPIMAGE;
  else process.env.APPIMAGE = originalAppImage;
});

function setup({ snapshot = managed("user_choice"), getPolicy, download, check, onAbort } = {}) {
  let current = snapshot;
  const events = [];
  const autoUpdater = new EventEmitter();
  const nativeUpdater = new EventEmitter();
  const app = new EventEmitter();
  const httpExecutor = {
    aborts: 0,
    resumeRequests() {},
    abortRequests() {
      this.aborts++;
      onAbort?.();
    },
  };
  // Each check issues its own token, as electron-updater does.
  const tokens = [];
  const newToken = () => ({
    cancelled: false,
    cancel() {
      this.cancelled = true;
    },
  });
  Object.assign(autoUpdater, {
    checks: 0,
    downloads: 0,
    installs: 0,
    setFeedURL() {},
    async checkForUpdates() {
      this.checks++;
      if (check) await check();
      this.emit("update-available", { version: "99.0.0" });
      const cancellationToken = newToken();
      tokens.push(cancellationToken);
      return {
        isUpdateAvailable: true,
        updateInfo: { version: "99.0.0" },
        cancellationToken,
      };
    },
    downloadUpdate(cancellationToken = newToken()) {
      this.downloads++;
      if (cancellationToken.cancelled) return Promise.reject(new Error("cancelled"));
      return download ? download(cancellationToken) : Promise.resolve([]);
    },
    quitAndInstall() {
      this.installs++;
    },
  });
  delete require.cache[modulePath];
  Module._load = function (request, parent, isMain) {
    if (request === "electron-updater") return { autoUpdater };
    if (request === "./helpers/updateHttpExecutor") {
      return class {
        constructor() {
          return httpExecutor;
        }
      };
    }
    if (request === "electron") return { autoUpdater: nativeUpdater, app };
    if (request === "child_process") return { execSync: () => "0" };
    return originalLoad.call(this, request, parent, isMain);
  };
  const UpdateManager = require(modulePath);
  const manager = new UpdateManager({ getPolicy: getPolicy ?? (async () => current) });
  managers.push(manager);
  manager.setWindowManager({
    controlPanelWindow: {
      isDestroyed: () => false,
      webContents: { send: (channel) => events.push(channel) },
    },
  });
  return {
    manager,
    autoUpdater,
    nativeUpdater,
    app,
    httpExecutor,
    events,
    tokens,
    setPolicy(value) {
      current = value;
      manager.updatePolicy(value);
    },
  };
}

test("IT policy blocks startup, periodic and direct updater entry points", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { manager, autoUpdater, events } = setup({ snapshot: managed("it_managed") });
  manager.setAutoUpdatesEnabled(true);
  manager.checkForUpdatesOnStartup();
  t.mock.timers.tick(3000);
  await flush();
  t.mock.timers.tick(4 * 60 * 60 * 1000);
  await flush();
  for (const result of [
    await manager.checkForUpdates(),
    await manager.downloadUpdate(),
    await manager.installUpdate(),
  ]) {
    assert.equal(result.code, "UPDATES_MANAGED_BY_ORG");
    assert.equal(result.success, false);
  }
  autoUpdater.emit("update-available", { version: "99.0.0" });
  autoUpdater.emit("update-downloaded", { version: "99.0.0" });
  assert.equal(autoUpdater.checks, 0);
  assert.equal(autoUpdater.downloads, 0);
  assert.equal(autoUpdater.installs, 0);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(events.includes("update-available"), false);
  assert.equal(events.includes("update-downloaded"), false);
  assert.equal((await manager.getUpdateStatus()).updateDownloaded, false);
});

test("always-on overrides false without erasing the member preference", async () => {
  const { manager, autoUpdater, setPolicy } = setup({ snapshot: managed("always_on") });
  manager.setAutoUpdatesEnabled(false);
  await manager.checkForUpdates();
  await flush();
  assert.equal(autoUpdater.downloads, 1);
  assert.equal(manager.autoUpdatesEnabled, false);
  assert.equal((await manager.getUpdateStatus()).effectiveAutoUpdatesEnabled, true);
  setPolicy({ success: true, managed: false });
  assert.equal((await manager.getUpdateStatus()).effectiveAutoUpdatesEnabled, false);
  assert.equal(manager.autoUpdatesEnabled, false);
});

test("absent and future modes preserve the manual member-controlled flow", async () => {
  for (const mode of [undefined, "user_choice", "future_mode"]) {
    const { manager, autoUpdater } = setup({ snapshot: managed(mode) });
    manager.setAutoUpdatesEnabled(false);
    assert.equal((await manager.checkForUpdates()).updateAvailable, true);
    assert.equal(autoUpdater.downloads, 0);
    assert.equal((await manager.getUpdateStatus()).updateMode, "user_choice");
    await manager.downloadUpdate();
    assert.equal(autoUpdater.downloads, 1);
    autoUpdater.emit("update-downloaded", { version: "99.0.0" });
    assert.equal((await manager.installUpdate()).success, true);
    assert.equal(autoUpdater.installs, 1);
  }
});

test("unresolved policy never authorizes an update or install-on-quit", async () => {
  const { manager, autoUpdater } = setup({ snapshot: { success: false } });
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  manager.setAutoUpdatesEnabled(true);
  assert.equal((await manager.checkForUpdates()).code, "UPDATE_POLICY_UNAVAILABLE");
  assert.equal((await manager.downloadUpdate()).code, "UPDATE_POLICY_UNAVAILABLE");
  assert.equal((await manager.installUpdate()).code, "UPDATE_POLICY_UNAVAILABLE");
  assert.equal(autoUpdater.checks, 0);
  assert.equal(autoUpdater.downloads, 0);
});

test("a policy arriving after startup is scheduled still prevents the feed request", async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const { manager, autoUpdater } = setup({ getPolicy: () => pending });
  const request = manager.checkForUpdates();
  assert.equal(autoUpdater.checks, 0);
  resolve(managed("it_managed"));
  assert.equal((await request).code, "UPDATES_MANAGED_BY_ORG");
  assert.equal(autoUpdater.checks, 0);
});

test("policy changes cancel the active download and reject late completion events", async () => {
  let finish;
  const pending = new Promise((done) => {
    finish = done;
  });
  const { manager, autoUpdater, httpExecutor, tokens, events, setPolicy } = setup({
    download: () => pending,
  });
  manager.setAutoUpdatesEnabled(false);
  await manager.checkForUpdates();
  const downloading = manager.downloadUpdate();
  await flush();
  assert.equal(autoUpdater.downloads, 1);
  // A duplicate request must not clear the active download's ownership.
  await manager.downloadUpdate();
  assert.equal(manager.isDownloading, true);
  setPolicy(managed("it_managed"));
  assert.equal(tokens[0].cancelled, true);
  await flush();
  assert.equal(httpExecutor.aborts, 1);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  autoUpdater.emit("update-downloaded", { version: "99.0.0" });
  finish([]);
  assert.equal((await downloading).code, "UPDATES_MANAGED_BY_ORG");
  assert.equal(events.includes("update-downloaded"), false);
  assert.equal((await manager.installUpdate()).success, false);
});

for (const mode of ["user_choice", "always_on"]) {
  test(`${mode} waits for cancelled download cleanup before discovering the next update`, async () => {
    let finishDownload;
    let downloads = 0;
    const { manager, autoUpdater, setPolicy } = setup({
      download: () =>
        downloads++ === 0
          ? new Promise((resolve) => (finishDownload = resolve))
          : Promise.resolve([]),
    });
    manager.setAutoUpdatesEnabled(false);
    await manager.checkForUpdates();
    const downloading = manager.downloadUpdate();
    await flush();
    setPolicy(managed("it_managed"));
    await flush();
    setPolicy(managed(mode));
    const checking = manager.checkForUpdates();
    await flush();
    assert.equal(autoUpdater.checks, 1);
    finishDownload([]);
    assert.equal((await downloading).code, "UPDATE_POLICY_CHANGED");
    assert.equal((await checking).updateAvailable, true);
    await flush();
    assert.equal((await manager.getUpdateStatus()).updateAvailable, true);
    assert.equal(autoUpdater.downloads, mode === "always_on" ? 2 : 1);
  });
}

test("idle policy changes do not abort unrelated requests", async () => {
  const { manager, httpExecutor, setPolicy } = setup();
  await manager.refreshPolicy();
  setPolicy(managed("it_managed"));
  assert.equal(httpExecutor.aborts, 0);
});

test("a downloaded event does not release an operation still preparing its native handoff", async () => {
  let finish;
  const { manager, autoUpdater, httpExecutor, setPolicy } = setup({
    download: () => new Promise((resolve) => (finish = resolve)),
  });
  manager.setAutoUpdatesEnabled(false);
  await manager.checkForUpdates();
  const downloading = manager.downloadUpdate();
  await flush();
  autoUpdater.emit("update-downloaded", { version: "99.0.0" });
  assert.equal(manager.isDownloading, false);
  setPolicy(managed("it_managed"));
  await flush();
  assert.equal(httpExecutor.aborts, 1);
  setPolicy(managed("user_choice"));
  const checking = manager.checkForUpdates();
  await flush();
  assert.equal(autoUpdater.checks, 1);
  finish([]);
  await downloading;
  await checking;
  assert.equal((await manager.getUpdateStatus()).updateAvailable, true);
});

test("an aborted manual feed check returns the new policy denial", async () => {
  let rejectCheck;
  const { manager, httpExecutor, setPolicy } = setup({
    check: () => new Promise((_resolve, reject) => (rejectCheck = reject)),
    onAbort: () => rejectCheck(new Error("net::ERR_CONNECTION_CLOSED")),
  });
  const checking = manager.checkForUpdates();
  await flush();
  setPolicy(managed("it_managed"));
  await flush();
  assert.equal(httpExecutor.aborts, 1);
  assert.equal((await checking).code, "UPDATES_MANAGED_BY_ORG");
});

for (const mode of ["user_choice", "always_on"]) {
  test(`an aborted check and its joined caller explain restored ${mode} policy`, async () => {
    let rejectCheck;
    const { manager, setPolicy } = setup({
      check: () => new Promise((_resolve, reject) => (rejectCheck = reject)),
      onAbort: () => rejectCheck(new Error("cancelled")),
    });
    const checking = manager.checkForUpdates();
    await flush();
    const joined = manager.checkForUpdates();
    await flush();
    setPolicy(managed("it_managed"));
    setPolicy(managed(mode));
    for (const result of await Promise.all([checking, joined])) {
      assert.equal(result.code, "UPDATE_POLICY_CHANGED");
      assert.equal(result.updateAvailable, false);
    }
  });

  test(`an aborted download explains restored ${mode} policy`, async () => {
    let rejectDownload;
    const { manager, setPolicy } = setup({
      download: () => new Promise((_resolve, reject) => (rejectDownload = reject)),
      onAbort: () => rejectDownload(new Error("cancelled")),
    });
    manager.setAutoUpdatesEnabled(false);
    await manager.checkForUpdates();
    const downloading = manager.downloadUpdate();
    await flush();
    setPolicy(managed("it_managed"));
    setPolicy(managed(mode));
    assert.equal((await downloading).code, "UPDATE_POLICY_CHANGED");
  });
}

test("an old credential's late policy lookup cannot replace the new scope", async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const { manager, autoUpdater } = setup({ getPolicy: () => pending });
  const lookup = manager.refreshPolicy();
  manager.invalidatePolicy();
  manager.updatePolicy(managed("it_managed"));
  resolve(managed("always_on"));
  await lookup;
  assert.equal((await manager.getUpdateStatus()).updateMode, "it_managed");
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
});

test("a failed lookup leaves a held verdict and its download alone; an unresolvable one revokes", async () => {
  let finish;
  const { manager, httpExecutor, tokens } = setup({
    download: () => new Promise((resolve) => (finish = resolve)),
  });
  manager.setAutoUpdatesEnabled(false);
  await manager.checkForUpdates();
  const downloading = manager.downloadUpdate();
  await flush();
  for (const code of ["POLICY_UNAVAILABLE", "POLICY_RETRY_THROTTLED"]) {
    manager.updatePolicy({ success: false, code });
  }
  assert.equal(httpExecutor.aborts, 0);
  assert.equal(tokens[0].cancelled, false);
  assert.equal((await manager.getUpdateStatus()).policyReady, true);
  finish([]);
  assert.equal((await downloading).success, true);

  manager.updatePolicy({ success: false, code: "POLICY_UNRESOLVABLE" });
  const status = await manager.getUpdateStatus();
  assert.equal(status.policyReady, false);
  assert.equal(status.policyUnavailable, true);
  assert.equal(status.updateMode, null);
  assert.equal(status.updateAvailable, false);
});

test("a credential change lets a consumer download finish under the verdict it started with", async () => {
  let finish;
  const { manager, httpExecutor, tokens, events } = setup({
    download: () => new Promise((resolve) => (finish = resolve)),
  });
  manager.setAutoUpdatesEnabled(false);
  await manager.checkForUpdates();
  const downloading = manager.downloadUpdate();
  await flush();
  manager.invalidatePolicy();
  let status = await manager.getUpdateStatus();
  assert.equal(status.policyReady, false);
  assert.equal(status.updateAvailable, true);
  manager.updatePolicy(managed("user_choice"));
  await flush();
  assert.equal(httpExecutor.aborts, 0);
  assert.equal(tokens[0].cancelled, false);
  finish([]);
  assert.equal((await downloading).success, true);
  status = await manager.getUpdateStatus();
  assert.equal(status.policyReady, true);
  assert.equal(status.updateAvailable, true);
  assert.equal(events.includes("update-error"), false);
});

test("a download finishing while a verdict is pending keeps install-on-quit", async () => {
  let finish;
  let installOnQuitAtCompletion;
  const { manager, autoUpdater } = setup({
    download: () =>
      new Promise((resolve) => {
        finish = () => {
          // electron-updater reads the flag once, when the download completes.
          installOnQuitAtCompletion = autoUpdater.autoInstallOnAppQuit;
          resolve([]);
        };
      }),
  });
  manager.setAutoUpdatesEnabled(false);
  await manager.checkForUpdates();
  const downloading = manager.downloadUpdate();
  await flush();
  manager.invalidatePolicy();
  finish();
  assert.equal((await downloading).success, true);
  assert.equal(installOnQuitAtCompletion, true);
});

test("a check during a download leaves IT policy the download's token to cancel", async () => {
  const { manager, tokens, setPolicy } = setup({ download: () => new Promise(() => {}) });
  manager.setAutoUpdatesEnabled(false);
  await manager.checkForUpdates();
  void manager.downloadUpdate();
  await flush();
  await manager.checkForUpdates();
  assert.equal(tokens.length, 2);
  setPolicy(managed("it_managed"));
  assert.equal(tokens[0].cancelled, true);
});

for (const platform of ["win32", "linux"]) {
  test(`${platform} installs a finished download on quit only under a current verdict`, async () => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    if (platform === "linux") process.env.APPIMAGE = "/tmp/OpenWhispr.AppImage";
    const { manager, autoUpdater, app } = setup();
    manager.setAutoUpdatesEnabled(false);
    await manager.checkForUpdates();
    await manager.downloadUpdate();
    manager.invalidatePolicy();
    manager.updatePolicy({ success: false, code: "POLICY_UNAVAILABLE" });
    app.emit("before-quit");
    assert.equal(autoUpdater.autoInstallOnAppQuit, false);
    manager.cleanup();
    assert.equal(app.listenerCount("before-quit"), 0);
  });
}

test("a download after IT policy lifts starts on a fresh token", async () => {
  const { manager, autoUpdater, setPolicy } = setup();
  manager.setAutoUpdatesEnabled(false);
  await manager.checkForUpdates();
  setPolicy(managed("it_managed"));
  setPolicy(managed("user_choice"));
  assert.equal((await manager.downloadUpdate()).success, true);
  assert.equal(autoUpdater.downloads, 1);
});

test("a failed lookup with nothing held reports the policy unavailable until a retry resolves it", async () => {
  let current = { success: false, code: "POLICY_UNAVAILABLE" };
  const { manager, autoUpdater } = setup({ getPolicy: async () => current });
  await manager.refreshPolicy();
  let status = await manager.getUpdateStatus();
  assert.equal(status.policyReady, false);
  assert.equal(status.policyUnavailable, true);
  current = managed("user_choice");
  assert.equal((await manager.checkForUpdates()).updateAvailable, true);
  status = await manager.getUpdateStatus();
  assert.equal(status.policyReady, true);
  assert.equal(status.policyUnavailable, false);
  assert.equal(autoUpdater.checks, 1);
});

test("a held verdict answers without waiting for the network lookup", async () => {
  const { manager, autoUpdater } = setup({
    getPolicy: ({ held = false } = {}) => (held ? managed("user_choice") : new Promise(() => {})),
  });
  const answer = await Promise.race([manager.checkForUpdates(), flush().then(() => null)]);
  assert.equal(answer?.updateAvailable, true);
  assert.equal(autoUpdater.checks, 1);
});

test("a startup check refused for want of a verdict runs once the verdict lands", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { manager, autoUpdater, setPolicy } = setup({ snapshot: { success: false } });
  manager.checkForUpdatesOnStartup();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(autoUpdater.checks, 0);
  setPolicy(managed("user_choice"));
  await flush();
  assert.equal(autoUpdater.checks, 1);
  setPolicy(managed("always_on"));
  await flush();
  assert.equal(autoUpdater.checks, 1);
});

test("lifting IT policy checks again for the update it cleared", async () => {
  const { manager, autoUpdater, setPolicy } = setup();
  manager.setAutoUpdatesEnabled(false);
  await manager.checkForUpdates();
  setPolicy(managed("it_managed"));
  assert.equal((await manager.getUpdateStatus()).updateAvailable, false);
  setPolicy(managed("user_choice"));
  await flush();
  assert.equal(autoUpdater.checks, 2);
  assert.equal((await manager.getUpdateStatus()).updateAvailable, true);
});

test("lifting IT policy runs the check it refused", async () => {
  const { manager, autoUpdater, setPolicy } = setup({ snapshot: managed("it_managed") });
  assert.equal((await manager.checkForUpdates()).code, "UPDATES_MANAGED_BY_ORG");
  setPolicy(managed("always_on"));
  await flush();
  assert.equal(autoUpdater.checks, 1);
});

test("old policy revisions cannot lift a restriction", async () => {
  const { manager } = setup();
  manager.updatePolicy({ ...managed("it_managed"), revision: 10 });
  manager.updatePolicy({ ...managed("always_on"), revision: 9 });
  assert.equal((await manager.getUpdateStatus()).updateMode, "it_managed");
});

test("a check finishing after policy changes cannot authorize a download", async () => {
  let finish;
  const pending = new Promise((done) => {
    finish = done;
  });
  const { manager, autoUpdater, tokens, setPolicy } = setup({ check: () => pending });
  manager.setAutoUpdatesEnabled(true);
  const checking = manager.checkForUpdates();
  await flush();
  setPolicy(managed("it_managed"));
  finish();
  assert.equal((await checking).code, "UPDATES_MANAGED_BY_ORG");
  assert.equal(tokens[0].cancelled, true);
  assert.equal(autoUpdater.downloads, 0);
  assert.equal((await manager.getUpdateStatus()).updateAvailable, false);
});

test("managed mode reports an earlier macOS staged update without offering installation", async () => {
  const { manager, autoUpdater } = setup({ snapshot: managed("it_managed") });
  autoUpdater.squirrelDownloadedUpdate = true;
  manager.updateDownloaded = true;
  await manager.refreshPolicy();
  const status = await manager.getUpdateStatus();
  assert.equal(status.stagedUpdate, true);
  assert.equal(status.updateDownloaded, false);
  assert.equal((await manager.installUpdate()).code, "UPDATES_MANAGED_BY_ORG");
  assert.equal(autoUpdater.installs, 0);
});

test("a restart into a staged update goes through Squirrel under any policy, without a lookup", async () => {
  for (const snapshot of [managed("it_managed"), { success: false }]) {
    let lookups = 0;
    const { manager, autoUpdater } = setup({
      getPolicy: async () => {
        lookups++;
        return snapshot;
      },
    });
    await manager.refreshPolicy();
    assert.equal((await manager.restartIntoStagedUpdate()).success, false);
    assert.equal(autoUpdater.installs, 0);
    autoUpdater.squirrelDownloadedUpdate = true;
    lookups = 0;
    assert.equal((await manager.restartIntoStagedUpdate()).success, true);
    assert.equal(autoUpdater.installs, 1);
    assert.equal(lookups, 0);
  }
});

test("late native staging broadcasts status even while IT policy blocks update events", async () => {
  const { manager, autoUpdater, nativeUpdater, events } = setup({
    snapshot: managed("it_managed"),
  });
  await manager.refreshPolicy();
  await flush();
  events.length = 0;
  autoUpdater.squirrelDownloadedUpdate = true;
  nativeUpdater.emit("update-downloaded");
  await flush();
  assert.deepEqual(events, ["update-status-changed"]);
  assert.equal((await manager.getUpdateStatus()).stagedUpdate, true);
  manager.cleanup();
  assert.equal(nativeUpdater.listenerCount("update-downloaded"), 0);
});

for (const platform of ["win32", "linux"]) {
  test(`${platform} supported installer obeys IT and always-on policy`, async () => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    if (platform === "linux") process.env.APPIMAGE = "/tmp/OpenWhispr.AppImage";
    const { manager, autoUpdater, setPolicy } = setup({ snapshot: managed("it_managed") });
    manager.setAutoUpdatesEnabled(false);
    assert.equal((await manager.checkForUpdates()).code, "UPDATES_MANAGED_BY_ORG");
    assert.equal(autoUpdater.autoInstallOnAppQuit, false);
    setPolicy(managed("always_on"));
    await manager.checkForUpdates();
    await flush();
    assert.equal(autoUpdater.downloads, 1);
    assert.equal(autoUpdater.autoInstallOnAppQuit, true);
    assert.equal(manager.autoUpdatesEnabled, false);
  });
}

test("refreshing policy cannot undo reset/relaunch install deferral", async () => {
  const { manager, autoUpdater, setPolicy } = setup();
  await manager.refreshPolicy();
  manager.deferInstallOnQuit();
  setPolicy(managed("always_on"));
  manager.setAutoUpdatesEnabled(true);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
});

test("Linux package-manager installs remain unsupported even under always-on", async () => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  delete process.env.APPIMAGE;
  const { manager, autoUpdater } = setup({ snapshot: managed("always_on") });
  manager.setAutoUpdatesEnabled(true);
  await manager.checkForUpdates();
  await manager.downloadUpdate();
  manager.updateDownloaded = true;
  await manager.installUpdate();
  assert.equal((await manager.getUpdateStatus()).isSupported, false);
  assert.equal((await manager.getUpdateStatus()).effectiveAutoUpdatesEnabled, false);
  assert.equal(autoUpdater.checks + autoUpdater.downloads + autoUpdater.installs, 0);
});

test("manual checks explain IT policy on Linux package-manager installations", async () => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  delete process.env.APPIMAGE;
  const { manager, autoUpdater } = setup({ snapshot: managed("it_managed") });
  assert.equal((await manager.checkForUpdates()).code, "UPDATES_MANAGED_BY_ORG");
  assert.equal(autoUpdater.checks, 0);
});

test("cleanup cancels a queued startup check", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { manager, autoUpdater } = setup();
  manager.checkForUpdatesOnStartup();
  manager.cleanup();
  t.mock.timers.tick(4 * 60 * 60 * 1000);
  await flush();
  assert.equal(autoUpdater.checks, 0);
});
