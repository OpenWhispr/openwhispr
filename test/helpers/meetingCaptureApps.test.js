const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const modulePath = require.resolve("../../src/helpers/meetingCaptureApps");

function loadWithProcessLists(lists) {
  delete require.cache[modulePath];
  const fetches = [];
  const originalLoad = Module._load;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./processListCache") {
      return {
        getProcesses: async () => {
          fetches.push("fetch");
          return lists.shift() ?? [];
        },
        invalidate: () => fetches.push("invalidate"),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { ...require(modulePath), fetches };
  } finally {
    Module._load = originalLoad;
  }
}

test("a macOS helper process is named after the app bundle it lives in", () => {
  const { captureAppFromProcess } = loadWithProcessLists([]);
  assert.deepEqual(
    captureAppFromProcess(
      {
        name: "Orca Helper",
        path: "/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper",
      },
      "darwin"
    ),
    { id: "orca", name: "Orca" }
  );
  // ps-list gives up on a path with this many spaces: no `path`, the whole path as `name`.
  assert.deepEqual(
    captureAppFromProcess(
      {
        name: "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/131.0.6778.86/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper",
        path: "",
      },
      "darwin"
    ),
    { id: "google chrome", name: "Google Chrome" }
  );
  assert.deepEqual(
    captureAppFromProcess({ name: "sox", path: "/opt/homebrew/bin/sox" }, "darwin"),
    {
      id: "sox",
      name: "sox",
    }
  );
});

test("Windows and Linux name the executable", () => {
  const { captureAppFromProcess } = loadWithProcessLists([]);
  assert.deepEqual(captureAppFromProcess({ name: "Orca.exe" }, "win32"), {
    id: "orca.exe",
    name: "Orca",
  });
  assert.deepEqual(captureAppFromProcess({ name: "orca", path: "/usr/bin/orca" }, "linux"), {
    id: "orca",
    name: "orca",
  });
  assert.equal(captureAppFromProcess({ name: "" }, "win32"), null);
});

test("a capture missing from the cached process list is looked up in a fresh one", async () => {
  const { resolveCaptureApps, fetches } = loadWithProcessLists([
    [{ pid: 1, name: "other" }],
    [
      { pid: 1, name: "other" },
      { pid: 42, name: "orca" },
    ],
  ]);
  const apps = await resolveCaptureApps([42]);
  assert.deepEqual(fetches, ["fetch", "invalidate", "fetch"]);
  assert.deepEqual([...apps], [[42, { id: "orca", name: "orca" }]]);
});
