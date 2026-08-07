const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_RETENTION_SETTINGS,
  applyRetentionSettings,
} = require("../../src/helpers/retentionSettings");

test("waits for persisted settings before running startup cleanup", () => {
  const IPCHandlers = require("../../src/helpers/ipcHandlers");
  const cleanupRuns = [];
  const context = {
    _retentionCleanupInterval: null,
    _retentionSettings: { ...DEFAULT_RETENTION_SETTINGS },
    _runRetentionCleanup() {
      cleanupRuns.push({ ...this._retentionSettings });
    },
  };

  IPCHandlers.prototype._setupRetentionCleanup.call(context);
  clearInterval(context._retentionCleanupInterval);

  assert.deepEqual(cleanupRuns, []);
});

test("applies disabled audio retention before the first cleanup", () => {
  const IPCHandlers = require("../../src/helpers/ipcHandlers");
  const cleanupRuns = [];
  const context = {
    _retentionSettings: { ...DEFAULT_RETENTION_SETTINGS },
    _retentionSettingsSynced: false,
    _runRetentionCleanup() {
      cleanupRuns.push({ ...this._retentionSettings });
    },
  };

  IPCHandlers.prototype._syncRetentionSettings.call(context, {
    audioRetentionDays: 0,
    transcriptRetentionDays: 0,
  });

  assert.deepEqual(cleanupRuns, [{ audioRetentionDays: 0, transcriptRetentionDays: 0 }]);
});

test("runs the default first sync once and de-duplicates an unchanged second-window sync", () => {
  const IPCHandlers = require("../../src/helpers/ipcHandlers");
  let cleanupRuns = 0;
  const context = {
    _retentionSettings: { ...DEFAULT_RETENTION_SETTINGS },
    _retentionSettingsSynced: false,
    _runRetentionCleanup() {
      cleanupRuns++;
    },
  };

  IPCHandlers.prototype._syncRetentionSettings.call(context, DEFAULT_RETENTION_SETTINGS);
  IPCHandlers.prototype._syncRetentionSettings.call(context, DEFAULT_RETENTION_SETTINGS);

  assert.equal(cleanupRuns, 1);

  IPCHandlers.prototype._syncRetentionSettings.call(context, {
    ...DEFAULT_RETENTION_SETTINGS,
    audioRetentionDays: 7,
  });

  assert.equal(cleanupRuns, 2);
  assert.equal(context._retentionSettings.audioRetentionDays, 7);
});

test("reports a change when a retention period is shortened", () => {
  assert.deepEqual(
    applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
      audioRetentionDays: 1,
      transcriptRetentionDays: 1,
    }),
    {
      changed: true,
      settings: { audioRetentionDays: 1, transcriptRetentionDays: 1 },
    }
  );
});

test("is idempotent when both values are unchanged — dual-window mount sync", () => {
  const { changed } = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
    audioRetentionDays: 30,
    transcriptRetentionDays: 0,
  });
  assert.equal(changed, false);
});

test("keeps the current value when an incoming value is missing or unusable", () => {
  const current = { audioRetentionDays: 7, transcriptRetentionDays: 1 };
  for (const incoming of [
    undefined,
    {},
    { audioRetentionDays: "abc", transcriptRetentionDays: -5 },
  ]) {
    assert.deepEqual(applyRetentionSettings(current, incoming), {
      changed: false,
      settings: current,
    });
  }
});
