const test = require("node:test");
const assert = require("node:assert/strict");

const { shortenLongPauses } = require("../../src/helpers/pauseShortening");
const { isPcm16Mono16kWav } = require("../../src/helpers/ffmpegUtils");
const { pcm16ToWav } = require("../../src/utils/audioUtils");
const {
  makeSine,
  makeSeededNoise,
  mix,
  delayBy,
  toInt16Buffer,
  dbToGain,
} = require("./harness/pcmFixtures");

const SAMPLE_RATE = 16000;
const SPEECH_AMPLITUDE = 0.3;

// A noise floor near -59 dBFS with tones (stand-ins for speech) at the given starts.
function recording(totalMs, tones) {
  const noise = makeSeededNoise({ durationMs: totalMs, amplitude: 0.002, sampleRate: SAMPLE_RATE });
  const placed = tones.map(({ atMs, durationMs, amplitude = SPEECH_AMPLITUDE }) =>
    delayBy(makeSine({ durationMs, amplitude, sampleRate: SAMPLE_RATE }), atMs, SAMPLE_RATE)
  );
  return pcm16ToWav(toInt16Buffer(mix(noise, ...placed)));
}

function samplesAbove(wav, amplitude) {
  let count = 0;
  for (let offset = 44; offset < wav.length; offset += 2) {
    if (Math.abs(wav.readInt16LE(offset)) / 32768 > amplitude) count++;
  }
  return count;
}

const seconds = (wav) => (wav.length - 44) / (SAMPLE_RATE * 2);

test("a long pause between two stretches of speech shrinks to about 0.75 s", () => {
  const input = recording(14000, [
    { atMs: 500, durationMs: 2000 },
    { atMs: 11500, durationMs: 2000 },
  ]);

  const { buffer, removedSeconds } = shortenLongPauses(input);

  assert.ok(isPcm16Mono16kWav(buffer));
  assert.ok(Math.abs(removedSeconds - 8.24) < 0.05, `removed ${removedSeconds} s`);
  assert.ok(Math.abs(seconds(buffer) - (14 - removedSeconds)) < 0.001);
  assert.equal(samplesAbove(buffer, 0.1), samplesAbove(input, 0.1), "both tones stay whole");
});

test("pauses under 1.5 s are left alone", () => {
  const input = recording(6000, [
    { atMs: 200, durationMs: 2000 },
    { atMs: 3400, durationMs: 2400 },
  ]);

  const result = shortenLongPauses(input);

  assert.equal(result.buffer, input);
  assert.equal(result.removedSeconds, 0);
});

test("a recording with nothing but noise, or nothing but speech, is returned as is", () => {
  const noiseOnly = recording(10000, []);
  const speechOnly = recording(10000, [{ atMs: 0, durationMs: 10000 }]);

  assert.equal(shortenLongPauses(noiseOnly).buffer, noiseOnly);
  assert.equal(shortenLongPauses(speechOnly).buffer, speechOnly);
});

test("a quiet word 20 dB below the speech inside a long pause is kept", () => {
  const quiet = SPEECH_AMPLITUDE * dbToGain(-20);
  const input = recording(16000, [
    { atMs: 500, durationMs: 2000 },
    { atMs: 7000, durationMs: 400, amplitude: quiet },
    { atMs: 13500, durationMs: 2000 },
  ]);

  const { buffer, removedSeconds } = shortenLongPauses(input);

  assert.ok(removedSeconds > 7, `the pauses around the word still shrink (${removedSeconds} s)`);
  assert.equal(samplesAbove(buffer, quiet * 0.7), samplesAbove(input, quiet * 0.7));
});
