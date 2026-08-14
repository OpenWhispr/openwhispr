const test = require("node:test");
const assert = require("node:assert/strict");

const { fitAssistantWindowToWorkArea } = require("../../src/helpers/windowConfig");

test("assistant windows retain their requested ratio size when space allows", () => {
  assert.deepEqual(
    fitAssistantWindowToWorkArea({ width: 466, height: 562 }, { width: 1440, height: 900 }),
    { width: 466, height: 562 }
  );
});

test("assistant windows cap their visible panel at 600px wide", () => {
  assert.deepEqual(
    fitAssistantWindowToWorkArea({ width: 900, height: 900 }, { width: 1600, height: 1000 }),
    { width: 624, height: 754 }
  );
});

test("assistant windows shrink proportionally to a short work area", () => {
  const size = fitAssistantWindowToWorkArea(
    { width: 624, height: 754 },
    { width: 1280, height: 700 }
  );
  assert.deepEqual(size, { width: 579, height: 700 });
});
