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
// `swell` rises and falls linearly, so its frames span every level like a word's onset.
function recording(totalMs, tones) {
  const noise = makeSeededNoise({ durationMs: totalMs, amplitude: 0.002, sampleRate: SAMPLE_RATE });
  const placed = tones.map(({ atMs, durationMs, amplitude = SPEECH_AMPLITUDE, swell = false }) => {
    const tone = makeSine({ durationMs, amplitude, sampleRate: SAMPLE_RATE });
    if (swell) {
      for (let i = 0; i < tone.length; i++) tone[i] *= 1 - Math.abs((2 * i) / tone.length - 1);
    }
    return delayBy(tone, atMs, SAMPLE_RATE);
  });
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

test("a dictation that is mostly pauses still has them shortened", () => {
  // Speech fills about a tenth of it, so its 90th-percentile frame is a soft onset,
  // some 9 dB above the noise.
  const input = recording(
    80000,
    [0, 1, 2, 3, 4].map((k) => ({ atMs: 500 + k * 15800, durationMs: 1620, swell: true }))
  );

  const { buffer, removedSeconds } = shortenLongPauses(input);

  assert.ok(removedSeconds > 60, `removed ${removedSeconds} s`);
  assert.equal(samplesAbove(buffer, 0.05), samplesAbove(input, 0.05));
});

test("a noisy recording keeps its pauses even when a few frames are loud", () => {
  // Noise near -33 dBFS, speech about 12 dB above it, and a louder burst in 3% of frames.
  const noise = makeSeededNoise({ durationMs: 16000, amplitude: 0.0388, sampleRate: SAMPLE_RATE });
  const tone = (atMs, durationMs, amplitude) =>
    delayBy(makeSine({ durationMs, amplitude, sampleRate: SAMPLE_RATE }), atMs, SAMPLE_RATE);
  const input = pcm16ToWav(
    toInt16Buffer(
      mix(noise, tone(500, 4000, 0.126), tone(10500, 4000, 0.126), tone(15000, 500, 0.3))
    )
  );

  assert.ok(shortenLongPauses(input).buffer === input);
});

test("pauses under 1.5 s are left alone", () => {
  const input = recording(6000, [
    { atMs: 200, durationMs: 2000 },
    { atMs: 3400, durationMs: 2400 },
  ]);

  const result = shortenLongPauses(input);

  assert.ok(result.buffer === input);
  assert.equal(result.removedSeconds, 0);
});

test("a recording with nothing but noise, or nothing but speech, is returned as is", () => {
  const noiseOnly = recording(10000, []);
  const speechOnly = recording(10000, [{ atMs: 0, durationMs: 10000 }]);

  assert.ok(shortenLongPauses(noiseOnly).buffer === noiseOnly);
  assert.ok(shortenLongPauses(speechOnly).buffer === speechOnly);
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
