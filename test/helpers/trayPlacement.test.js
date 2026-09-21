const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Spelled out rather than imported: a new GUID resets every user's saved
// menu-bar position, so changing it should fail here.
const TRAY_GUID = "eb809902-04b5-5b08-b12a-f81d6f27e185";
const trayPath = path.join(__dirname, "../../src/helpers/tray.js");
const traySource = fs.readFileSync(trayPath, "utf8");

// Runs tray.js in its own context so each test picks a platform without
// touching the real process.platform.
async function createTrayOn(platform) {
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
    "./debugLogger": { error: (...args) => calls.push(["error", ...args]) },
    "./dockManager": {},
    "./i18nMain": { i18nMain: { t: (key) => key } },
  };
  const loadedModule = { exports: {} };
  vm.runInNewContext(
    traySource,
    {
      module: loadedModule,
      process: { platform },
      require: (specifier) => stubs[specifier] ?? require(specifier),
    },
    { filename: trayPath }
  );

  const trayManager = new loadedModule.exports();
  trayManager.loadTrayIcon = async () => icon;
  await trayManager.createTray();
  return { calls, icon };
}

test("macOS registers the starting position before creating its tray under the fixed GUID", async () => {
  const { calls, icon } = await createTrayOn("darwin");

  assert.deepEqual(calls, [
    ["register", { [`NSStatusItem Preferred Position ${TRAY_GUID}`]: 0 }],
    ["construct", icon, TRAY_GUID],
    ["ignoreDoubleClick", true],
  ]);
});

for (const platform of ["win32", "linux"]) {
  test(`${platform} creates its tray without a GUID or a starting position`, async () => {
    const { calls, icon } = await createTrayOn(platform);

    assert.deepEqual(calls, [["construct", icon]]);
  });
}
