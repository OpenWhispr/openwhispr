const test = require("node:test");
const assert = require("node:assert/strict");

const { createPreparedSpeech } = require("../../src/workers/preparedSpeech");

// A synthesizer whose calls the test resolves one at a time.
function manualSynthesizer() {
  const calls = [];
  const synthesize = (text) =>
    new Promise((resolve, reject) => calls.push({ text, resolve, reject }));
  return { calls, synthesize };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("prepares lines one at a time and serves them once ready", async () => {
  const { calls, synthesize } = manualSynthesizer();
  const speech = createPreparedSpeech({ synthesize, onError: () => {} });

  speech.prepare(["One moment.", "Let me check your notes."]);
  assert.deepEqual(
    calls.map((call) => call.text),
    ["One moment."]
  );
  calls[0].resolve(new Float32Array([0.1]));
  await settle();
  assert.deepEqual(speech.get("One moment."), new Float32Array([0.1]));
  assert.equal(calls[1].text, "Let me check your notes.");
});

test("an answer being spoken pauses preparation until it ends", async () => {
  const { calls, synthesize } = manualSynthesizer();
  const speech = createPreparedSpeech({ synthesize, onError: () => {} });

  speech.speakStarted();
  speech.prepare(["One moment."]);
  assert.equal(calls.length, 0, "an answer never waits behind preparation it could avoid");
  speech.speakEnded();
  assert.equal(calls.length, 1);
});

test("a failed line is reported and the rest still get prepared", async () => {
  const { calls, synthesize } = manualSynthesizer();
  const errors = [];
  const speech = createPreparedSpeech({ synthesize, onError: (error) => errors.push(error) });

  speech.prepare(["A.", "B."]);
  calls[0].reject(new Error("synthesis failed"));
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(speech.get("A."), undefined);
  assert.equal(calls[1].text, "B.");
});

test("a line finished after the voice was reconfigured is not served", async () => {
  const { calls, synthesize } = manualSynthesizer();
  const speech = createPreparedSpeech({ synthesize, onError: () => {} });

  speech.prepare(["One moment."]);
  speech.clear();
  calls[0].resolve(new Float32Array([0.1]));
  await settle();
  assert.equal(speech.get("One moment."), undefined);
});
