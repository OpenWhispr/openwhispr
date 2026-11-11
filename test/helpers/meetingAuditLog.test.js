const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMeetingAuditLog } = require("../../src/helpers/meetingAuditLog");

// #3029: a managed device keeps a local JSON Lines record of meeting recordings
// for IT's log collector, with no titles, names or transcript content.

const FIELDS = [
  "ts",
  "event",
  "sessionId",
  "noteId",
  "trigger",
  "reason",
  "durationSec",
  "participantsNotified",
  "notificationMethod",
  "externalAttendees",
  "appVersion",
  "deviceUser",
];
const START = Date.parse("2026-11-11T09:00:00.000Z");

let userData;
test.beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-audit-"));
});
test.afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

function harness({ enabled = true, configuredPath = null, deviceUser = "jdoe" } = {}) {
  const clock = { now: START };
  const state = { enabled, configuredPath };
  const timers = [];
  const warnings = [];
  const log = createMeetingAuditLog({
    isEnabled: () => state.enabled,
    getConfiguredPath: () => state.configuredPath,
    userDataPath: userData,
    appVersion: "1.11.1",
    deviceUser,
    logger: { warn: (message, meta) => warnings.push({ message, meta }) },
    now: () => clock.now,
    setInterval: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      if (timer) timer.cleared = true;
    },
  });
  return { log, clock, state, timers, warnings };
}

const marker = () => path.join(userData, "meeting-audit-session.json");
const lines = (dir = path.join(userData, "audit")) =>
  fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").trim().split("\n"))
    .map((line) => JSON.parse(line));

test("a started and stopped recording writes one line each, with no content fields", async () => {
  const { log, clock } = harness();
  log.recordingStarted({ sessionId: "s1", noteId: 42, trigger: "hotkey" });
  clock.now = START + 125_400;
  log.recordingStopped({ sessionId: "s1", reason: "user" });
  await log.flush();

  const [started, stopped] = lines();
  for (const entry of [started, stopped]) assert.deepEqual(Object.keys(entry), FIELDS);
  assert.deepEqual(started, {
    ts: "2026-11-11T09:00:00.000Z",
    event: "recording.started",
    sessionId: "s1",
    noteId: 42,
    trigger: "hotkey",
    reason: null,
    durationSec: null,
    participantsNotified: null,
    notificationMethod: null,
    externalAttendees: null,
    appVersion: "1.11.1",
    deviceUser: "jdoe",
  });
  assert.equal(stopped.event, "recording.stopped");
  assert.equal(stopped.reason, "user");
  assert.equal(stopped.durationSec, 125);
  assert.equal(stopped.noteId, 42);
  assert.deepEqual(fs.readdirSync(path.join(userData, "audit")), [
    "meeting-audit-jdoe-2026-11-11.jsonl",
  ]);
  assert.equal(fs.existsSync(marker()), false);
});

test("nothing is written while the device is unmanaged", async () => {
  const { log } = harness({ enabled: false });
  log.recordingStarted({ sessionId: "s1", noteId: 1, trigger: "tray" });
  log.recordingStopped({ sessionId: "s1", reason: "user" });
  log.recordingRefused({ noteId: null, trigger: "tray", reason: "POLICY_UNRESOLVABLE" });
  await log.flush();
  assert.equal(fs.existsSync(path.join(userData, "audit")), false);
});

test("a refusal records its trigger and policy code", async () => {
  const { log } = harness();
  log.recordingRefused({
    noteId: null,
    trigger: "pill",
    reason: "POLICY_MEETING_RECORDING_DISABLED",
  });
  await log.flush();
  const [refused] = lines();
  assert.equal(refused.event, "recording.refused");
  assert.equal(refused.trigger, "pill");
  assert.equal(refused.reason, "POLICY_MEETING_RECORDING_DISABLED");
  assert.equal(refused.sessionId, null);
});

test("a stop is written beside its start after the policy or AuditLogPath changes", async () => {
  const custom = path.join(userData, "it-collector");
  const { log, state } = harness({ configuredPath: custom });
  log.recordingStarted({ sessionId: "s1", noteId: 7, trigger: "prompt" });
  state.enabled = false;
  state.configuredPath = path.join(userData, "elsewhere");
  log.recordingStopped({ sessionId: "s1", reason: "policy" });
  await log.flush();
  assert.equal(fs.existsSync(state.configuredPath), false);
  assert.deepEqual(
    lines(custom).map((entry) => [entry.event, entry.reason]),
    [
      ["recording.started", null],
      ["recording.stopped", "policy"],
    ]
  );
});

test("an absolute AuditLogPath is used; a relative one falls back to the default and warns", async () => {
  const custom = path.join(userData, "it-collector");
  const { log, state, warnings } = harness({ configuredPath: custom });
  log.recordingRefused({ noteId: null, trigger: "tray", reason: "POLICY_UNRESOLVABLE" });
  state.configuredPath = "relative/audit";
  log.recordingRefused({ noteId: null, trigger: "tray", reason: "POLICY_UNRESOLVABLE" });
  log.recordingRefused({ noteId: null, trigger: "tray", reason: "POLICY_UNRESOLVABLE" });
  await log.flush();
  assert.equal(lines(custom).length, 1);
  assert.equal(lines().length, 2);
  assert.equal(warnings.length, 1);
});

const day = (offset) => new Date(START - offset * 86_400_000).toISOString().slice(0, 10);

test("rotation keeps the user's 90 newest daily files and leaves other files alone", async () => {
  const dir = path.join(userData, "audit");
  fs.mkdirSync(dir);
  for (let offset = 1; offset <= 95; offset += 1)
    fs.writeFileSync(path.join(dir, `meeting-audit-jdoe-${day(offset)}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(dir, `meeting-audit-asmith-${day(95)}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(dir, "collector-state.json"), "{}");

  const { log } = harness();
  log.recordingRefused({ noteId: null, trigger: "tray", reason: "POLICY_UNRESOLVABLE" });
  await log.flush();

  const kept = fs.readdirSync(dir);
  assert.equal(kept.filter((name) => name.startsWith("meeting-audit-jdoe-")).length, 90);
  assert.ok(kept.includes(`meeting-audit-jdoe-${day(0)}.jsonl`));
  assert.ok(kept.includes(`meeting-audit-jdoe-${day(89)}.jsonl`));
  assert.ok(!kept.includes(`meeting-audit-jdoe-${day(90)}.jsonl`));
  assert.ok(kept.includes(`meeting-audit-asmith-${day(95)}.jsonl`));
  assert.ok(kept.includes("collector-state.json"));
});

// A device-wide AuditLogPath is shared by every OS user on the device.
test("users sharing an AuditLogPath each write their own daily file", async () => {
  const shared = path.join(userData, "shared");
  for (const deviceUser of ["jdoe", "asmith"]) {
    const { log } = harness({ configuredPath: shared, deviceUser });
    log.recordingRefused({ noteId: null, trigger: "hotkey", reason: "POLICY_UNRESOLVABLE" });
    await log.flush();
  }
  assert.deepEqual(fs.readdirSync(shared).sort(), [
    "meeting-audit-asmith-2026-11-11.jsonl",
    "meeting-audit-jdoe-2026-11-11.jsonl",
  ]);
});

test("a rotation that can't delete a file still keeps the open-session marker", async () => {
  const dir = path.join(userData, "audit");
  for (let offset = 1; offset <= 91; offset += 1)
    fs.mkdirSync(path.join(dir, `meeting-audit-jdoe-${day(offset)}.jsonl`), { recursive: true });
  const { log, warnings } = harness();
  log.recordingStarted({ sessionId: "s1", noteId: 1, trigger: "hotkey" });
  await log.flush();
  assert.equal(JSON.parse(fs.readFileSync(marker(), "utf8")).sessionId, "s1");
  assert.deepEqual(
    warnings.map((warning) => warning.message),
    ["Meeting audit log rotation failed"]
  );
});

test("an unwritable path never throws into the recording and warns once", async () => {
  const blocked = path.join(userData, "not-a-folder");
  fs.writeFileSync(blocked, "");
  const { log, warnings } = harness({ configuredPath: blocked });
  assert.doesNotThrow(() => {
    log.recordingStarted({ sessionId: "s1", noteId: 1, trigger: "hotkey" });
    log.recordingStopped({ sessionId: "s1", reason: "user" });
    log.recordingRefused({ noteId: null, trigger: "hotkey", reason: "POLICY_UNRESOLVABLE" });
  });
  await log.flush();
  assert.deepEqual(
    warnings.map((warning) => warning.message),
    ["Meeting audit log write failed"]
  );
});

test("a recording the app never stopped is closed on the next launch at its last checkpoint", async () => {
  const first = harness();
  first.log.recordingStarted({ sessionId: "s1", noteId: 9, trigger: "calendar-join" });
  first.clock.now = START + 90_000;
  first.timers[0].callback();
  await first.log.flush();

  const relaunch = harness();
  relaunch.clock.now = START + 3_600_000;
  relaunch.log.recoverInterrupted();
  await relaunch.log.flush();

  const [, stopped] = lines();
  assert.equal(stopped.event, "recording.stopped");
  assert.equal(stopped.sessionId, "s1");
  assert.equal(stopped.noteId, 9);
  assert.equal(stopped.reason, "interrupted");
  assert.equal(stopped.durationSec, 90);
  assert.equal(stopped.ts, "2026-11-11T09:01:30.000Z");
  assert.equal(fs.existsSync(marker()), false);

  relaunch.log.recoverInterrupted();
  await relaunch.log.flush();
  assert.equal(lines().length, 2);
});

test("an interrupted stop a launch can't write is kept and written before its next recording", async () => {
  const share = path.join(userData, "share");
  const first = harness({ configuredPath: share });
  first.log.recordingStarted({ sessionId: "s1", noteId: 9, trigger: "hotkey" });
  await first.log.flush();

  fs.rmSync(share, { recursive: true });
  fs.writeFileSync(share, "");
  const relaunch = harness({ configuredPath: share });
  relaunch.log.recoverInterrupted();
  await relaunch.log.flush();
  assert.equal(fs.existsSync(marker()), true);

  // The share comes back later in the same launch.
  fs.rmSync(share);
  relaunch.log.recordingStarted({ sessionId: "s2", noteId: 10, trigger: "tray" });
  relaunch.log.recordingStopped({ sessionId: "s2", reason: "user" });
  await relaunch.log.flush();
  assert.deepEqual(
    lines(share).map((line) => [line.sessionId, line.event, line.reason]),
    [
      ["s1", "recording.stopped", "interrupted"],
      ["s2", "recording.started", null],
      ["s2", "recording.stopped", "user"],
    ]
  );
  assert.equal(fs.existsSync(marker()), false);
});

test("a recording neither replaces nor removes the marker a failed recovery kept", async () => {
  const share = path.join(userData, "share");
  const away = path.join(userData, "share-away");
  const first = harness({ configuredPath: share });
  first.log.recordingStarted({ sessionId: "s1", noteId: 9, trigger: "hotkey" });
  await first.log.flush();

  fs.renameSync(share, away);
  fs.writeFileSync(share, "");
  const relaunch = harness({ configuredPath: share });
  relaunch.log.recoverInterrupted();
  relaunch.log.recordingStarted({ sessionId: "s2", noteId: 10, trigger: "tray" });
  relaunch.timers[0].callback();
  await relaunch.log.flush();

  // The share comes back before the recording stops.
  fs.rmSync(share);
  fs.renameSync(away, share);
  relaunch.log.recordingStopped({ sessionId: "s2", reason: "user" });
  await relaunch.log.flush();
  assert.equal(JSON.parse(fs.readFileSync(marker(), "utf8")).sessionId, "s1");

  relaunch.log.recoverInterrupted();
  await relaunch.log.flush();
  assert.deepEqual(
    lines(share).map((line) => [line.sessionId, line.event, line.reason]),
    [
      ["s1", "recording.started", null],
      ["s2", "recording.stopped", "user"],
      ["s1", "recording.stopped", "interrupted"],
    ]
  );
  assert.equal(fs.existsSync(marker()), false);
});

test("values outside the known sets are written as null", async () => {
  const { log } = harness();
  log.recordingStarted({ sessionId: "s1", noteId: "42", trigger: "Board meeting notes" });
  log.recordingStopped({ sessionId: "s1", reason: "the CEO asked" });
  log.recordingRefused({ noteId: 1.5, trigger: "somewhere", reason: "free text" });
  await log.flush();
  for (const entry of lines()) {
    assert.equal(entry.noteId, null);
    assert.equal(entry.trigger, null);
    assert.equal(entry.reason, null);
  }
});

test("a quit closes a live recording as app-quit, and does nothing otherwise", async () => {
  const { log, clock } = harness();
  await log.closeOpenSession("app-quit");
  log.recordingStarted({ sessionId: "s1", noteId: 5, trigger: "tray" });
  clock.now = START + 60_000;
  await log.closeOpenSession("app-quit");
  log.recordingStopped({ sessionId: "s1", reason: "window-lost" });
  await log.flush();
  assert.deepEqual(
    lines().map((entry) => [entry.event, entry.reason, entry.durationSec]),
    [
      ["recording.started", null, null],
      ["recording.stopped", "app-quit", 60],
    ]
  );
  assert.equal(fs.existsSync(marker()), false);
});
