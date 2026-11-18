const test = require("node:test");
const assert = require("node:assert/strict");

const { createPreparedSpeech } = require("../../src/workers/preparedSpeech");

const HELIOS = { sid: 5, speed: 1, lang: "en" };
const HELIOS_KEY = "5:1:en";

// A synthesizer whose calls the test resolves one at a time.
function manualSynthesizer() {
  const calls = [];
  const synthesize = (text, profile) =>
    new Promise((resolve, reject) => calls.push({ text, profile, resolve, reject }));
  return { calls, synthesize };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("prepares lines one at a time and serves them once ready", async () => {
  const { calls, synthesize } = manualSynthesizer();
  const speech = createPreparedSpeech({ synthesize, onError: () => {} });

  speech.prepare(["One moment.", "Let me check your notes."], HELIOS, HELIOS_KEY);
  assert.deepEqual(
    calls.map((call) => call.text),
    ["One moment."]
  );
  calls[0].resolve(new Float32Array([0.1]));
  await settle();
  assert.deepEqual(speech.get("One moment.", HELIOS_KEY), new Float32Array([0.1]));
  assert.equal(calls[1].text, "Let me check your notes.");
});

test("an answer being spoken pauses preparation until it ends", async () => {
  const { calls, synthesize } = manualSynthesizer();
  const speech = createPreparedSpeech({ synthesize, onError: () => {} });

  speech.speakStarted();
  speech.prepare(["One moment."], HELIOS, HELIOS_KEY);
  assert.equal(calls.length, 0, "an answer never waits behind preparation it could avoid");
  speech.speakEnded();
  assert.equal(calls.length, 1);
});

test("a failed line is reported and the rest still get prepared", async () => {
  const { calls, synthesize } = manualSynthesizer();
  const errors = [];
  const speech = createPreparedSpeech({ synthesize, onError: (error) => errors.push(error) });

  speech.prepare(["A.", "B."], HELIOS, HELIOS_KEY);
  calls[0].reject(new Error("synthesis failed"));
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(speech.get("A.", HELIOS_KEY), undefined);
  assert.equal(calls[1].text, "B.");
});

test("a line finished after the voice was reconfigured is not served", async () => {
  const { calls, synthesize } = manualSynthesizer();
  const speech = createPreparedSpeech({ synthesize, onError: () => {} });

  speech.prepare(["One moment."], HELIOS, HELIOS_KEY);
  speech.clear();
  calls[0].resolve(new Float32Array([0.1]));
  await settle();
  assert.equal(speech.get("One moment.", HELIOS_KEY), undefined);
});

test("a line is served only in the profile it was prepared for, and a new profile starts over", async () => {
  const { calls, synthesize } = manualSynthesizer();
  const speech = createPreparedSpeech({ synthesize, onError: () => {} });

  speech.prepare(["One moment."], HELIOS, HELIOS_KEY);
  calls[0].resolve(new Float32Array([0.1]));
  await settle();
  assert.equal(speech.get("One moment.", "1:1:en"), undefined, "another voice never hears it");

  const aurora = { sid: 1, speed: 1.5, lang: "es" };
  speech.prepare(["Un momento."], aurora, "1:1.5:es");
  assert.equal(speech.get("One moment.", HELIOS_KEY), undefined, "the old profile's lines go");
  assert.equal(calls[1].text, "Un momento.");
  assert.deepEqual(calls[1].profile, aurora, "it is synthesized in the new voice and rate");
});
