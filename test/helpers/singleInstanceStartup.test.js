const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const mainPath = path.resolve(__dirname, "../../main.js");
const mainSource = fs.readFileSync(mainPath, "utf8");

function runStartup({ lockAvailable, hidden }) {
  const events = [];
  const exited = Symbol("app.exit");
  const continued = Symbol("post-lock startup");
  const app = {
    commandLine: { appendSwitch() {} },
    getPath: () => "/fixture/user-data",
    setPath() {},
    setDesktopName() {},
    requestSingleInstanceLock: () => {
      events.push(["lock"]);
      return lockAvailable;
    },
    exit: (code) => {
      events.push(["exit", code]);
      // Model app.exit's immediate termination rather than continuing a mock process.
      throw exited;
    },
  };
  const mocks = {
    electron: { app },
    path,
    http: {},
    tls: { getCACertificates: () => [] },
    dotenv: { config: () => ({}) },
    "./src/helpers/xwayland": {
      XWAYLAND_FLAG: "--ozone-platform=x11",
      shouldForceXWayland: () => false,
    },
    "./src/helpers/hotkeyRepeatGate": { createHotkeyRepeatGate() {} },
    "./src/helpers/linuxGpuCompositing": { shouldDisableGpuCompositing: () => false },
    "./src/helpers/linuxUrlSchemeHandler": {
      registerLinuxUrlSchemeHandler: () => ({ registered: true }),
    },
  };
  const context = {
    require: (name) => {
      if (name === "./src/helpers/environment") {
        events.push(["continue"]);
        throw continued;
      }
      assert.ok(Object.hasOwn(mocks, name), `Unexpected startup dependency: ${name}`);
      return mocks[name];
    },
    __dirname: path.dirname(mainPath),
    __filename: mainPath,
    process: {
      platform: "linux",
      execPath: "/fixture/open-whispr",
      argv: ["/fixture/open-whispr", ...(hidden ? ["--hidden"] : []), "fixture-private-arg"],
      env: { OPENWHISPR_CHANNEL: "production" },
      on() {},
    },
    console: {
      warn: (...args) => events.push(["warn", ...args]),
      error: (...args) => events.push(["error", ...args]),
    },
  };
  assert.throws(
    () => vm.runInNewContext(mainSource, context, { filename: mainPath }),
    (error) => error === (lockAvailable ? continued : exited)
  );
  return events;
}

for (const hidden of [false, true]) {
  test(`failed single-instance lock logs before exiting (hidden=${hidden})`, () => {
    const events = runStartup({ lockAvailable: false, hidden });
    assert.deepEqual(
      events.map(([event]) => event),
      ["lock", "warn", "exit"]
    );
    assert.match(events[1][1], /single-instance lock/i);
    assert.match(events[1][1], /another.*instance.*may/i);
    assert.equal(events[2][1], 0);
    assert.ok(!JSON.stringify(events).includes("fixture-private-arg"));
    assert.ok(!JSON.stringify(events).includes("/fixture/user-data"));
  });
}

test("successful single-instance lock continues startup without failure logging", () => {
  assert.deepEqual(runStartup({ lockAvailable: true, hidden: true }), [["lock"], ["continue"]]);
});
