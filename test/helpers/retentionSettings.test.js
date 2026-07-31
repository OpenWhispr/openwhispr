const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_RETENTION_SETTINGS,
  applyRetentionSettings,
} = require("../../src/helpers/retentionSettings");

test("reports a change when a retention period is shortened", () => {
  assert.deepEqual(
    applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
      audioRetentionDays: 1,
      transcriptRetentionDays: 1,
      dataRetentionEnabled: true,
    }),
    {
      changed: true,
      settings: {
        audioRetentionDays: 1,
        transcriptRetentionDays: 1,
        dataRetentionEnabled: true,
      },
    }
  );
});

test("is idempotent when both values are unchanged — dual-window mount sync", () => {
  const { changed } = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
    audioRetentionDays: 30,
    transcriptRetentionDays: 0,
    dataRetentionEnabled: true,
  });
  assert.equal(changed, false);
});

test("keeps the current value when an incoming value is missing or unusable", () => {
  const current = {
    audioRetentionDays: 7,
    transcriptRetentionDays: 1,
    dataRetentionEnabled: true,
  };
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

test("reports a change when data retention is toggled", () => {
  const { changed, settings } = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
    audioRetentionDays: 30,
    transcriptRetentionDays: 0,
    dataRetentionEnabled: false,
  });
  assert.equal(changed, true);
  assert.equal(settings.dataRetentionEnabled, false);
});
