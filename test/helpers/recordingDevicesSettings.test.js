const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { openRecordingDevicesSettings } = require("../../src/helpers/recordingDevicesSettings");

// The "Microphone In Use" pill's Sound settings button opens the Sound dialog's
// Recording tab, where the exclusive-mode checkbox lives (#1138).
function fakeSpawn(outcome) {
  const calls = [];
  const spawnProcess = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      unref: () => calls.push("unref"),
    });
    calls.push({ file, args, options });
    setImmediate(() =>
      outcome instanceof Error ? child.emit("error", outcome) : child.emit("spawn")
    );
    return child;
  };
  return { spawnProcess, calls };
}

test("Windows opens the Recording tab detached from the app", async () => {
  const { spawnProcess, calls } = fakeSpawn("spawn");

  const result = await openRecordingDevicesSettings({ platform: "win32", spawnProcess });

  assert.deepEqual(result, { success: true });
  assert.deepEqual(calls, [
    { file: "control.exe", args: ["mmsys.cpl,,1"], options: { detached: true, stdio: "ignore" } },
    "unref",
  ]);
});

test("a dialog that can't start reports the failure instead of throwing", async () => {
  const { spawnProcess } = fakeSpawn(new Error("spawn control.exe ENOENT"));

  const result = await openRecordingDevicesSettings({ platform: "win32", spawnProcess });

  assert.deepEqual(result, { success: false, error: "spawn control.exe ENOENT" });
});

test("a spawn that throws synchronously reports the failure too", async () => {
  const spawnProcess = () => {
    throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
  };

  const result = await openRecordingDevicesSettings({ platform: "win32", spawnProcess });

  assert.deepEqual(result, { success: false, error: "spawn EPERM" });
});

test("other platforms have no such dialog and start nothing", async () => {
  for (const platform of ["darwin", "linux"]) {
    const { spawnProcess, calls } = fakeSpawn("spawn");
    assert.deepEqual(await openRecordingDevicesSettings({ platform, spawnProcess }), {
      success: false,
    });
    assert.deepEqual(calls, []);
  }
});
