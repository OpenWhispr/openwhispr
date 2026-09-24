const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Spelled out rather than imported: a new GUID resets every user's saved tray
// position, so changing either should fail here.
const MACOS_TRAY_GUID = "eb809902-04b5-5b08-b12a-f81d6f27e185";
const WINDOWS_TRAY_GUID = "9afd9bd5-53da-42ef-8334-6e2b494c66fe";
const trayPath = path.join(__dirname, "../../src/helpers/tray.js");
const traySource = fs.readFileSync(trayPath, "utf8");

// Runs tray.js in its own context so each test picks a platform, channel, and
// packaged metadata without touching the real process.
async function createTrayOn(platform, { channel = "production", metadata = {} } = {}) {
  const calls = [];
  const icon = { isEmpty: () => false };
  const stubs = {
    electron: {
      Tray: class {
        constructor(...args) {
          calls.push(["construct", ...args]);
        }
        setIgnoreDoubleClickEvents(ignore) {
          calls.push(["ignoreDoubleClick", ignore]);
        }
        setToolTip() {}
        setContextMenu() {}
        on() {}
      },
      Menu: { buildFromTemplate: () => ({}) },
      systemPreferences: {
        // Copied because the object comes from the VM's realm, whose prototype
        // deepStrictEqual would reject.
        registerDefaults: (defaults) => calls.push(["register", { ...defaults }]),
      },
    },
    "../../package.json": metadata,
    "./debugLogger": { error: (...args) => calls.push(["error", ...args]) },
    "./dockManager": {},
    "./i18nMain": { i18nMain: { t: (key) => key } },
  };
  const loadedModule = { exports: {} };
  vm.runInNewContext(
    traySource,
    {
      module: loadedModule,
      process: { platform, env: { OPENWHISPR_CHANNEL: channel } },
      require: (specifier) => stubs[specifier] ?? require(specifier),
    },
    { filename: trayPath }
  );

  const trayManager = new loadedModule.exports();
  trayManager.loadTrayIcon = async () => icon;
  await trayManager.createTray();
  return { calls, icon };
}

const signedBuild = { windowsTrayIdentity: true };

test("macOS registers the starting position before creating its tray under the fixed GUID", async () => {
  const { calls, icon } = await createTrayOn("darwin");

  assert.deepEqual(calls, [
    ["register", { [`NSStatusItem Preferred Position ${MACOS_TRAY_GUID}`]: 0 }],
    ["construct", icon, MACOS_TRAY_GUID],
    ["ignoreDoubleClick", true],
  ]);
});

test("a signed production Windows build creates its tray under the fixed Windows GUID", async () => {
  const { calls, icon } = await createTrayOn("win32", { metadata: signedBuild });

  assert.deepEqual(calls, [["construct", icon, WINDOWS_TRAY_GUID]]);
});

for (const [label, platform, options] of [
  ["Windows without the build marker", "win32", {}],
  ["unsigned Windows", "win32", { metadata: { windowsTrayIdentity: false } }],
  ["development Windows", "win32", { channel: "development", metadata: signedBuild }],
  ["staging Windows", "win32", { channel: "staging", metadata: signedBuild }],
  ["Linux", "linux", { metadata: signedBuild }],
]) {
  test(`${label} creates its tray without a GUID or a starting position`, async () => {
    const { calls, icon } = await createTrayOn(platform, options);

    assert.deepEqual(calls, [["construct", icon]]);
  });
}
