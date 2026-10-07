const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Each load is a fresh module with nothing loaded yet, so every test sees the
// first-use path. The platform is read when reassertAllSpaces is called.
function load({ platform = "darwin", binary = "/app/bin/macos-window-spaces.node", dlopen }) {
  const loads = [];
  const debugLogs = [];
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../../src/helpers/macosWindowSpaces.js"), "utf8"),
    {
      module,
      exports: module.exports,
      process: {
        platform,
        dlopen: (addonModule, filename) => {
          loads.push(filename);
          dlopen(addonModule, filename);
        },
      },
      require: (name) => {
        if (name === "./binaryResolver") return { resolveBundledBinary: () => binary };
        if (name === "./debugLogger") return { debug: (...args) => debugLogs.push(args) };
        return require(name);
      },
    }
  );
  return { ...module.exports, loads, debugLogs };
}

const addon = (reassertAllSpaces) => (addonModule) => {
  addonModule.exports = { reassertAllSpaces };
};

const windowWithHandle = (handle) => ({ getNativeWindowHandle: () => handle });

test("on macOS the addon gets the window's native handle and its answer is returned", () => {
  for (const answer of [true, false]) {
    const handle = Buffer.alloc(8);
    const received = [];
    const { reassertAllSpaces, loads } = load({
      dlopen: addon((nativeHandle) => {
        received.push(nativeHandle);
        return answer;
      }),
    });

    assert.equal(reassertAllSpaces(windowWithHandle(handle)), answer);
    assert.equal(received.length, 1);
    assert.equal(received[0], handle);
    assert.deepEqual(loads, ["/app/bin/macos-window-spaces.node"]);
  }
});

test("the addon is loaded on first use and only once", () => {
  const { reassertAllSpaces, loads } = load({ dlopen: addon(() => true) });
  assert.equal(loads.length, 0);

  reassertAllSpaces(windowWithHandle(Buffer.alloc(8)));
  reassertAllSpaces(windowWithHandle(Buffer.alloc(8)));

  assert.equal(loads.length, 1);
});

test("Windows and Linux never load the addon or touch the window", () => {
  for (const platform of ["win32", "linux"]) {
    let handleReads = 0;
    const win = {
      getNativeWindowHandle: () => {
        handleReads += 1;
        return Buffer.alloc(8);
      },
    };
    const { reassertAllSpaces, loads } = load({ platform, dlopen: addon(() => true) });

    assert.equal(reassertAllSpaces(win), false, platform);
    assert.equal(loads.length, 0, platform);
    assert.equal(handleReads, 0, platform);
  }
});

test("an addon that fails to load returns false, logs once at debug level and is not retried", () => {
  const { reassertAllSpaces, loads, debugLogs } = load({
    dlopen: () => {
      throw new Error("dlopen failed");
    },
  });
  const win = windowWithHandle(Buffer.alloc(8));

  assert.equal(reassertAllSpaces(win), false);
  assert.equal(reassertAllSpaces(win), false);

  assert.equal(loads.length, 1);
  assert.equal(debugLogs.length, 1);
});

test("a missing addon binary returns false without loading anything", () => {
  const { reassertAllSpaces, loads, debugLogs } = load({ binary: null, dlopen: addon(() => true) });
  const win = windowWithHandle(Buffer.alloc(8));

  assert.equal(reassertAllSpaces(win), false);
  assert.equal(reassertAllSpaces(win), false);

  assert.equal(loads.length, 0);
  assert.equal(debugLogs.length, 1);
});

test("a failing call returns false instead of throwing, and logs once", () => {
  const { reassertAllSpaces, debugLogs } = load({
    dlopen: addon(() => {
      throw new Error("addon threw");
    }),
  });
  // A destroyed window throws from getNativeWindowHandle before the addon runs.
  const destroyed = {
    getNativeWindowHandle: () => {
      throw new Error("Object has been destroyed");
    },
  };

  assert.equal(reassertAllSpaces(windowWithHandle(Buffer.alloc(8))), false);
  assert.equal(reassertAllSpaces(destroyed), false);

  assert.equal(debugLogs.length, 1);
});
