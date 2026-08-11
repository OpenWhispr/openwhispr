const test = require("node:test");
const assert = require("node:assert/strict");

const health = require("../../src/helpers/meetingDetectionHealth");
const { MeetingDetectionHealth } = health;

// Detection could fail in four different ways with nothing recorded anywhere, so
// "it stopped working" was the only diagnosis available. This registry is passive:
// it records what each detector is doing and why anything was dropped.

test("a registry with nothing running reports off", () => {
  const registry = new MeetingDetectionHealth();
  assert.equal(registry.getStatus(), "off");
});

test("an event-driven detector is healthy", () => {
  const registry = new MeetingDetectionHealth();
  registry.setMode("audio", "event-driven", { via: "macos-mic-listener" });

  assert.equal(registry.getStatus(), "healthy");
  const snapshot = registry.getSnapshot();
  assert.equal(snapshot.detectors[0].name, "audio");
  assert.equal(snapshot.detectors[0].mode, "event-driven");
});

test("a polling detector is degraded and names its reason", () => {
  const registry = new MeetingDetectionHealth();
  registry.setMode("audio", "polling", { reason: "listener-exited" });

  assert.equal(registry.getStatus(), "degraded");
  assert.equal(registry.getSnapshot().reason, "listener-exited");
});

test("an unavailable detector outranks a healthy one", () => {
  const registry = new MeetingDetectionHealth();
  registry.setMode("process", "event-driven");
  registry.setMode("audio", "unavailable", { reason: "no-mic-signal-on-this-platform" });

  assert.equal(registry.getStatus(), "unavailable");
  assert.equal(registry.getSnapshot().reason, "no-mic-signal-on-this-platform");
});

test("a stopped detector no longer counts toward status", () => {
  const registry = new MeetingDetectionHealth();
  registry.setMode("audio", "unavailable", { reason: "gone" });
  registry.setMode("audio", "stopped");

  assert.equal(registry.getStatus(), "off");
});

test("child restarts are counted with their exit code", () => {
  const registry = new MeetingDetectionHealth();
  registry.setMode("audio", "event-driven");
  registry.recordChild("audio", { pid: 4242, alive: true });
  registry.recordChild("audio", { alive: false, exitCode: 9 });
  registry.recordRestart("audio", { attempt: 1, delayMs: 1000, reason: "exit" });
  registry.recordRestart("audio", { attempt: 2, delayMs: 2000, reason: "exit" });

  const detector = registry.getSnapshot().detectors.find((d) => d.name === "audio");
  assert.equal(detector.restartCount, 2);
  assert.equal(detector.lastExitCode, 9);
  assert.equal(detector.childAlive, false);
  assert.equal(detector.childPid, 4242);
});

test("suppressions are counted by reason and the last one is kept", () => {
  const registry = new MeetingDetectionHealth();
  registry.recordSuppression("meeting-mode-active", { detectionId: "audio:sustained-audio" });
  registry.recordSuppression("meeting-mode-active", { detectionId: "calendar:evt-1" });
  registry.recordSuppression("already-prompted", {});

  const snapshot = registry.getSnapshot();
  assert.equal(snapshot.suppressionCounts["meeting-mode-active"], 2);
  assert.equal(snapshot.suppressionCounts["already-prompted"], 1);
  assert.equal(snapshot.lastSuppression.reason, "already-prompted");
});

test("latch values are exposed for diagnosis", () => {
  const registry = new MeetingDetectionHealth();
  registry.setLatches({ meetingModeActive: true });
  registry.setLatches({ userRecording: false });

  assert.deepEqual(registry.getSnapshot().latches, {
    meetingModeActive: true,
    userRecording: false,
  });
});

test("the snapshot survives a structured clone, as IPC requires", () => {
  const registry = new MeetingDetectionHealth();
  registry.setMode("audio", "event-driven");
  registry.recordChild("audio", { pid: 1, alive: true });
  registry.recordEvent("audio");
  registry.recordSuppression("meeting-mode-active", { detectionId: "x" });

  const snapshot = registry.getSnapshot();
  assert.deepEqual(structuredClone(snapshot), snapshot);
});

test("the module exports a shared singleton", () => {
  assert.ok(health instanceof MeetingDetectionHealth);
});
