const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_RETENTION_SETTINGS,
  applyRetentionSettings,
  createRetentionSettingsHandler,
} = require("../../src/helpers/retentionSettings");

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

test("only the main renderer can replace process-global retention settings", () => {
  const mainRenderer = {};
  const auxiliaryRenderers = [{}, {}, {}];
  const managedSettings = { audioRetentionDays: 7, transcriptRetentionDays: 30 };
  let current = { ...DEFAULT_RETENTION_SETTINGS };
  let cleanupRuns = 0;
  let synced = false;
  const handleRetentionSettingsChanged = createRetentionSettingsHandler({
    getCurrentSettings: () => current,
    getOwner: () => mainRenderer,
    hasSynced: () => synced,
    onSettingsChanged: (settings) => {
      current = settings;
      synced = true;
      cleanupRuns += 1;
    },
  });

  handleRetentionSettingsChanged({ sender: mainRenderer }, managedSettings);
  assert.deepEqual(current, managedSettings);
  assert.equal(cleanupRuns, 1);

  for (const auxiliaryRenderer of auxiliaryRenderers) {
    handleRetentionSettingsChanged(
      { sender: auxiliaryRenderer },
      { audioRetentionDays: 90, transcriptRetentionDays: 0 }
    );
    assert.deepEqual(current, managedSettings);
    assert.equal(cleanupRuns, 1);
  }

  handleRetentionSettingsChanged(
    { sender: mainRenderer },
    { audioRetentionDays: 90, transcriptRetentionDays: 0 }
  );
  assert.deepEqual(current, { audioRetentionDays: 90, transcriptRetentionDays: 0 });
  assert.equal(cleanupRuns, 2);
});

test("no sweep runs before the renderer has synced the persisted settings", () => {
  const IPCHandlers = require("../../src/helpers/ipcHandlers");
  const sweeps = [];
  const context = {
    _retentionCleanupInterval: null,
    _retentionSettingsSynced: false,
    _retentionSettings: { ...DEFAULT_RETENTION_SETTINGS },
    _runRetentionCleanup() {
      sweeps.push({ ...this._retentionSettings });
    },
  };

  IPCHandlers.prototype._setupRetentionCleanup.call(context);
  clearInterval(context._retentionCleanupInterval);

  // The 30-day default would have deleted audio a "Disabled" user asked to keep.
  assert.deepEqual(sweeps, []);
});

test("the first sync sweeps even when the user's settings match the defaults", () => {
  let current = { ...DEFAULT_RETENTION_SETTINGS };
  let synced = false;
  let cleanupRuns = 0;
  const owner = {};
  const handle = createRetentionSettingsHandler({
    getCurrentSettings: () => current,
    getOwner: () => owner,
    hasSynced: () => synced,
    onSettingsChanged: (settings) => {
      current = settings;
      synced = true;
      cleanupRuns += 1;
    },
  });

  handle({ sender: owner }, { ...DEFAULT_RETENTION_SETTINGS });
  assert.equal(cleanupRuns, 1);

  // A second window mounting must not sweep again.
  handle({ sender: owner }, { ...DEFAULT_RETENTION_SETTINGS });
  assert.equal(cleanupRuns, 1);
});

test("a disabled retention setting reaches the sweep before it can delete", () => {
  let current = { ...DEFAULT_RETENTION_SETTINGS };
  let synced = false;
  const sweptWith = [];
  const owner = {};
  const handle = createRetentionSettingsHandler({
    getCurrentSettings: () => current,
    getOwner: () => owner,
    hasSynced: () => synced,
    onSettingsChanged: (settings) => {
      current = settings;
      synced = true;
      sweptWith.push({ ...settings });
    },
  });

  handle({ sender: owner }, { audioRetentionDays: 0, transcriptRetentionDays: 0 });
  assert.deepEqual(sweptWith, [{ audioRetentionDays: 0, transcriptRetentionDays: 0 }]);
});
