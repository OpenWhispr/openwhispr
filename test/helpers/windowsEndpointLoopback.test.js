const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const MANAGER_PATH = path.join(__dirname, "../../src/helpers/windowsLoopbackAudioManager.js");
const IPC_PATH = path.join(__dirname, "../../src/helpers/ipcHandlers.js");

describe("WindowsLoopbackAudioManager endpoint-loopback mode", () => {
  const managerSrc = fs.readFileSync(MANAGER_PATH, "utf8");

  it("defaults mode to endpoint-loopback in start()", () => {
    assert.ok(
      managerSrc.includes('mode = "endpoint-loopback"'),
      "start() should default mode to endpoint-loopback"
    );
  });

  it("passes --mode flag to the helper binary", () => {
    assert.ok(
      managerSrc.includes('"--mode"'),
      "should pass --mode flag to helper"
    );
    assert.ok(
      managerSrc.includes("mode,"),
      "should pass mode variable in args array"
    );
  });

  it("only passes --exclude-pid for process-loopback mode", () => {
    assert.ok(
      managerSrc.includes('mode === "process-loopback"'),
      "should conditionally pass --exclude-pid only for process-loopback"
    );
  });

  it("parses supportsEndpointLoopback from probe response", () => {
    assert.ok(
      managerSrc.includes("supportsEndpointLoopback"),
      "should parse supportsEndpointLoopback from probe"
    );
  });

  it("parses supportsProcessLoopback from probe response", () => {
    assert.ok(
      managerSrc.includes("supportsProcessLoopback"),
      "should parse supportsProcessLoopback from probe"
    );
  });

  it("considers either mode as supporting native capture", () => {
    assert.ok(
      managerSrc.includes("supportsEndpointLoopback || supportsProcessLoopback"),
      "supportsNativeCapture should be true if either mode is supported"
    );
  });

  it("does not import wasapiAudioActivityWatchdog", () => {
    assert.ok(
      !managerSrc.includes("wasapiAudioActivityWatchdog"),
      "manager should not reference the deleted watchdog module"
    );
  });
});

describe("ipcHandlers.js endpoint-loopback wiring", () => {
  const ipcSrc = fs.readFileSync(IPC_PATH, "utf8");

  it("does not import wasapiAudioActivityWatchdog", () => {
    assert.ok(
      !ipcSrc.includes("wasapiAudioActivityWatchdog"),
      "ipcHandlers should not import the deleted watchdog module"
    );
  });

  it("does not reference createAudioActivityWatchdog", () => {
    assert.ok(
      !ipcSrc.includes("createAudioActivityWatchdog"),
      "ipcHandlers should not use the watchdog"
    );
  });

  it("does not reference WASAPI_AUDIO_ACTIVITY_WATCHDOG_MS", () => {
    assert.ok(
      !ipcSrc.includes("WASAPI_AUDIO_ACTIVITY_WATCHDOG_MS"),
      "ipcHandlers should not define the watchdog timeout"
    );
  });

  it("passes mode parameter to startManagedMeetingSystemAudio for wasapi-loopback", () => {
    // The wasapi-loopback branch should call startManagedMeetingSystemAudio with 4 args
    // including "endpoint-loopback" as the mode
    assert.ok(
      ipcSrc.includes('"endpoint-loopback"'),
      "should pass endpoint-loopback mode to startManagedMeetingSystemAudio"
    );
  });

  it("startManagedMeetingSystemAudio accepts mode parameter", () => {
    assert.ok(
      /startManagedMeetingSystemAudio\s*=\s*\([^)]*mode\)/.test(ipcSrc),
      "startManagedMeetingSystemAudio should accept a mode parameter"
    );
  });

  it("forwards mode to manager.start()", () => {
    assert.ok(
      /manager\.start\(\{[\s\S]*mode,/.test(ipcSrc),
      "should forward mode to manager.start()"
    );
  });
});
