const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const loadPolicy = () => import("../../src/helpers/sttConfigPolicy.js");

describe("needsSttConfigBeforeStart", () => {
  test("signed-in OpenWhispr cloud mode blocks the start on the config", async () => {
    const { needsSttConfigBeforeStart } = await loadPolicy();
    assert.equal(
      needsSttConfigBeforeStart({
        useLocalWhisper: false,
        cloudTranscriptionMode: "openwhispr",
        isSignedIn: true,
      }),
      true
    );
  });

  test("local STT never blocks the mic open (#1673)", async () => {
    const { needsSttConfigBeforeStart } = await loadPolicy();
    assert.equal(
      needsSttConfigBeforeStart({
        useLocalWhisper: true,
        cloudTranscriptionMode: "openwhispr",
        isSignedIn: true,
      }),
      false
    );
  });

  test("signed-out session never blocks — streaming is impossible anyway (#1673)", async () => {
    const { needsSttConfigBeforeStart } = await loadPolicy();
    assert.equal(
      needsSttConfigBeforeStart({
        useLocalWhisper: false,
        cloudTranscriptionMode: "openwhispr",
        isSignedIn: false,
      }),
      false
    );
    assert.equal(
      needsSttConfigBeforeStart({
        useLocalWhisper: false,
        cloudTranscriptionMode: "openwhispr",
      }),
      false
    );
  });

  test("BYOK mode decides streaming without the config", async () => {
    const { needsSttConfigBeforeStart } = await loadPolicy();
    assert.equal(
      needsSttConfigBeforeStart({
        useLocalWhisper: false,
        cloudTranscriptionMode: "byok",
        isSignedIn: true,
      }),
      false
    );
  });

  test("missing settings fail open to a non-blocking start", async () => {
    const { needsSttConfigBeforeStart } = await loadPolicy();
    assert.equal(needsSttConfigBeforeStart(null), false);
    assert.equal(needsSttConfigBeforeStart({}), false);
  });
});
