const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const policyFile = path.resolve(__dirname, "../../src/helpers/personalUpdatePolicy.js");

test("personal updates wait for recording, processing and every renderer to be idle", () => {
  assert.ok(fs.existsSync(policyFile), "personal update policy must exist");
  const { canRestart } = require(policyFile);
  const idle = {
    enabled: true,
    downloaded: true,
    idleSeconds: 90,
    panelVisible: false,
    dictationState: "idle",
    mainBusy: false,
    now: 100000,
    renderers: [{ busy: false, at: 99000 }],
  };
  assert.equal(canRestart(idle), true);
  for (const patch of [
    { enabled: false },
    { downloaded: false },
    { idleSeconds: 59 },
    { panelVisible: true },
    { dictationState: "recording" },
    { dictationState: "processing" },
    { mainBusy: true },
    { renderers: [] },
    { renderers: [null] },
    { renderers: [{ busy: true, at: 99000 }] },
    { renderers: [{ busy: false, at: 0 }] },
  ])
    assert.equal(canRestart({ ...idle, ...patch }), false, JSON.stringify(patch));
});
