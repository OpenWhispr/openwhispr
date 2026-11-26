const { wavToFloat32Samples } = require("./ffmpegUtils");
const { pcm16ToWav } = require("../utils/audioUtils");

// With VAD off, whisper.cpp can skip the speech that follows a pause, and a dictionary
// prompt makes that worse (#2474). Dictation only reads the text back, so pauses can be
// shortened before the decode without anything depending on the original timing.
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = SAMPLE_RATE / 50;
const MIN_PAUSE_FRAMES = 75; // 1.5 s
const KEPT_EDGE_FRAMES = 19; // ~0.38 s kept on each side of a shortened pause
// The quiet threshold sits this far from the noise floor toward the speech level, and
// a recording whose levels span less than MIN_LEVEL_RANGE_DB has no pause to tell apart.
const QUIET_FRACTION = 0.3;
const MIN_LEVEL_RANGE_DB = 15;
// When speech fills too little of a recording for the 90th percentile to reach it, the
// loudest frames stand in, but only this far above the noise; a noisy room's don't.
const MIN_SPARSE_SPEECH_RANGE_DB = 25;

function frameLevelsDb(samples) {
  const levels = new Float64Array(Math.ceil(samples.length / FRAME_SAMPLES));
  for (let frame = 0; frame < levels.length; frame++) {
    const start = frame * FRAME_SAMPLES;
    const end = Math.min(start + FRAME_SAMPLES, samples.length);
    let sumSquares = 0;
    for (let i = start; i < end; i++) sumSquares += samples[i] * samples[i];
    levels[frame] = 20 * Math.log10(Math.max(Math.sqrt(sumSquares / (end - start)), 1e-5));
  }
  return levels;
}

function shortenLongPauses(wavBuffer) {
  const floatBytes = wavToFloat32Samples(wavBuffer);
  const samples = new Float32Array(floatBytes.buffer, floatBytes.byteOffset, floatBytes.length / 4);
  const levels = frameLevelsDb(samples);
  const sorted = Array.from(levels).sort((a, b) => a - b);
  const level = (fraction) => sorted[Math.floor(sorted.length * fraction)];
  const noise = level(0.1);
  // Reading every recording at the 98th percentile would raise the threshold and clip
  // soft speech, so it is only for a dictation that is mostly pauses.
  let speech = null;
  if (level(0.9) - noise >= MIN_LEVEL_RANGE_DB) speech = level(0.9);
  else if (level(0.98) - noise >= MIN_SPARSE_SPEECH_RANGE_DB) speech = level(0.98);
  if (speech === null) return { buffer: wavBuffer, removedSeconds: 0 };

  const threshold = noise + (speech - noise) * QUIET_FRACTION;
  const droppedFrames = [];
  let runStart = -1;
  for (let frame = 0; frame <= levels.length; frame++) {
    if (frame < levels.length && levels[frame] < threshold) {
      if (runStart < 0) runStart = frame;
      continue;
    }
    if (runStart >= 0 && frame - runStart >= MIN_PAUSE_FRAMES) {
      droppedFrames.push([runStart + KEPT_EDGE_FRAMES, frame - KEPT_EDGE_FRAMES]);
    }
    runStart = -1;
  }
  if (!droppedFrames.length) return { buffer: wavBuffer, removedSeconds: 0 };

  const output = new Int16Array(samples.length);
  let written = 0;
  let next = 0;
  for (const [dropStart, dropEnd] of [...droppedFrames, [levels.length, levels.length]]) {
    const end = Math.min(dropStart * FRAME_SAMPLES, samples.length);
    for (let i = next; i < end; i++) output[written++] = Math.round(samples[i] * 32768);
    next = dropEnd * FRAME_SAMPLES;
  }
  const pcm = Buffer.from(output.buffer, 0, written * 2);
  return {
    buffer: pcm16ToWav(pcm),
    removedSeconds: (samples.length - written) / SAMPLE_RATE,
  };
}

module.exports = { shortenLongPauses };
