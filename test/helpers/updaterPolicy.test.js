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

function setup({
  snapshot = managed("user_choice"),
  getPolicy,
  download,
  check,
  closeConnections,
} = {}) {
  let current = snapshot;
  const events = [];
  const autoUpdater = new EventEmitter();
  const nativeUpdater = new EventEmitter();
  const networkSession = {
    closures: 0,
    async closeAllConnections() {
      this.closures++;
      await closeConnections?.();
    },
  };
  const token = {
    cancelled: false,
    cancel() {
      this.cancelled = true;
    },
  };
  Object.assign(autoUpdater, {
    checks: 0,
    downloads: 0,
    installs: 0,
    setFeedURL() {},
    async checkForUpdates() {
      this.checks++;
      if (check) await check();
      this.emit("update-available", { version: "99.0.0" });
      return {
        isUpdateAvailable: true,
        updateInfo: { version: "99.0.0" },
        cancellationToken: token,
      };
    },
    downloadUpdate(cancellationToken) {
      this.downloads++;
      assert.equal(cancellationToken, token);
      return download ? download(cancellationToken) : Promise.resolve([]);
    },
    quitAndInstall() {
      this.installs++;
    },
  });
  delete require.cache[modulePath];
  Module._load = function (request, parent, isMain) {
    if (request === "electron-updater") return { autoUpdater };
    if (request === "electron-updater/out/electronHttpExecutor") {
      return { getNetSession: () => networkSession };
    }
    if (request === "electron") return { autoUpdater: nativeUpdater };
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
    networkSession,
    events,
    token,
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
  const { manager, autoUpdater, networkSession, token, events, setPolicy } = setup({
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
  assert.equal(token.cancelled, true);
  await flush();
  assert.equal(networkSession.closures, 1);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  autoUpdater.emit("update-downloaded", { version: "99.0.0" });
  finish([]);
  assert.equal((await downloading).code, "UPDATES_MANAGED_BY_ORG");
  assert.equal(events.includes("update-downloaded"), false);
  assert.equal((await manager.installUpdate()).success, false);
});

test("restored update permission waits for cancelled transport to close", async () => {
  let finishDownload;
  let finishClosing;
  const { manager, autoUpdater, setPolicy } = setup({
    download: () => new Promise((resolve) => (finishDownload = resolve)),
    closeConnections: () => new Promise((resolve) => (finishClosing = resolve)),
  });
  manager.setAutoUpdatesEnabled(false);
  await manager.checkForUpdates();
  const downloading = manager.downloadUpdate();
  await flush();
  setPolicy(managed("it_managed"));
  let denial;
  void manager.checkForUpdates().then((result) => (denial = result));
  await flush();
  assert.equal(denial?.code, "UPDATES_MANAGED_BY_ORG");
  finishDownload([]);
  assert.equal((await downloading).code, "UPDATES_MANAGED_BY_ORG");
  setPolicy(managed("user_choice"));
  const checking = manager.checkForUpdates();
  await flush();
  assert.equal(autoUpdater.checks, 1);
  finishClosing();
  assert.equal((await checking).updateAvailable, true);
  assert.equal(autoUpdater.checks, 2);
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

test("idle policy changes leave unrelated network sessions alone", async () => {
  const { manager, networkSession, setPolicy } = setup();
  await manager.refreshPolicy();
  setPolicy(managed("it_managed"));
  assert.equal(networkSession.closures, 0);
});

test("a downloaded event does not release an operation still preparing its native handoff", async () => {
  let finish;
  const { manager, autoUpdater, networkSession, setPolicy } = setup({
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
  assert.equal(networkSession.closures, 1);
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
  const { manager, networkSession, setPolicy } = setup({
    check: () => new Promise((_resolve, reject) => (rejectCheck = reject)),
    closeConnections: () => rejectCheck(new Error("net::ERR_CONNECTION_CLOSED")),
  });
  const checking = manager.checkForUpdates();
  await flush();
  setPolicy(managed("it_managed"));
  await flush();
  assert.equal(networkSession.closures, 1);
  assert.equal((await checking).code, "UPDATES_MANAGED_BY_ORG");
});

test("failed connection cleanup cannot undo the IT verdict or block later policy checks", async () => {
  let finish;
  const { manager, autoUpdater, setPolicy } = setup({
    download: () => new Promise((resolve) => (finish = resolve)),
    closeConnections: () => {
      throw new Error("Session unavailable");
    },
  });
  manager.setAutoUpdatesEnabled(false);
  await manager.checkForUpdates();
  const downloading = manager.downloadUpdate();
  await flush();
  setPolicy(managed("it_managed"));
  finish([]);
  assert.equal((await downloading).code, "UPDATES_MANAGED_BY_ORG");
  assert.equal((await manager.checkForUpdates()).code, "UPDATES_MANAGED_BY_ORG");
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
});

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
  const { manager, autoUpdater, token, setPolicy } = setup({ check: () => pending });
  manager.setAutoUpdatesEnabled(true);
  const checking = manager.checkForUpdates();
  await flush();
  setPolicy(managed("it_managed"));
  finish();
  assert.equal((await checking).code, "UPDATES_MANAGED_BY_ORG");
  assert.equal(token.cancelled, true);
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
