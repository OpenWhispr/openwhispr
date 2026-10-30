const test = require("node:test");
const assert = require("node:assert/strict");
const { applyThinkingSuppression } = require("../../src/services/ai/thinkingSuppression");

// The GenieX (Snapdragon NPU) runtime ignores llama.cpp's think /
// chat_template_kwargs dialect; suppression must reach it through its own
// enable_think body field, without changing what llama.cpp servers receive.
test("a geniex model gets enable_think:false alongside the llama.cpp dialect", () => {
  const body = {};
  const suppressed = applyThinkingSuppression(
    body,
    "qualcomm_qwen3_5_2b_q4_0",
    "local",
    { disableThinking: true },
    undefined
  );
  assert.equal(suppressed, true);
  assert.equal(body.enable_think, false);
  // The llama.cpp fields still go out: harmless to GenieX, required for
  // llama.cpp models.
  assert.equal(body.think, false);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
});

test("a llama.cpp local model never gains the geniex field", () => {
  const body = {};
  const suppressed = applyThinkingSuppression(
    body,
    "qwen3.5-2b-q4_k_m",
    "local",
    { disableThinking: true },
    undefined
  );
  assert.equal(suppressed, true);
  assert.equal(body.enable_think, undefined);
});

test("the geniex field is only sent when suppression is on", () => {
  const body = {};
  const suppressed = applyThinkingSuppression(
    body,
    "qualcomm_qwen3_5_2b_q4_0",
    "local",
    { disableThinking: false },
    undefined
  );
  assert.equal(suppressed, false);
  assert.equal(body.enable_think, undefined);
});
