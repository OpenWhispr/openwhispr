/**
 * Voice Activity Detection (VAD) processor for gap compression.
 *
 * Detects speech segments in a 16kHz mono AudioBuffer using energy-based RMS
 * analysis, then compresses long silence gaps to prevent Whisper hallucinations
 * (e.g. "Thank you for watching!") during silence sent to cloud providers.
 *
 * Works on raw PCM Float32Array data — no external dependencies needed.
 */

import logger from "../utils/logger";

const VAD_DEFAULTS = {
  threshold: 0.01, // RMS threshold for speech vs silence
  frameSizeMs: 30, // Analysis frame size in ms
  minSpeechMs: 250, // Ignore speech segments shorter than this
  minSilenceMs: 1500, // Silence must be this long to count as a gap
  maxGapMs: 500, // Compress long gaps down to this duration
  speechPadMs: 300, // Padding around speech segments (don't clip edges)
};

/**
 * Detect speech segments in a 16kHz mono AudioBuffer.
 *
 * @param {Float32Array} samples - PCM samples (16kHz mono)
 * @param {number} sampleRate - Sample rate (typically 16000)
 * @param {object} options - VAD parameters (see VAD_DEFAULTS)
 * @returns {Array<{start: number, end: number}>} Speech segments as sample indices
 */
export function detectSpeechSegments(samples, sampleRate, options = {}) {
  const opts = { ...VAD_DEFAULTS, ...options };
  const frameSize = Math.floor((opts.frameSizeMs / 1000) * sampleRate);
  const totalFrames = Math.floor(samples.length / frameSize);

  if (totalFrames === 0) return [{ start: 0, end: samples.length }];

  // Step 1: Compute RMS energy per frame
  const frameEnergies = new Float32Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    const offset = i * frameSize;
    let sum = 0;
    for (let j = 0; j < frameSize; j++) {
      const s = samples[offset + j];
      sum += s * s;
    }
    frameEnergies[i] = Math.sqrt(sum / frameSize);
  }

  // Step 2: Classify frames as speech/silence
  const isSpeech = new Uint8Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    isSpeech[i] = frameEnergies[i] >= opts.threshold ? 1 : 0;
  }

  // Step 3: Extract contiguous speech runs
  const rawSegments = [];
  let inSpeech = false;
  let segStart = 0;

  for (let i = 0; i < totalFrames; i++) {
    if (isSpeech[i] && !inSpeech) {
      inSpeech = true;
      segStart = i;
    } else if (!isSpeech[i] && inSpeech) {
      inSpeech = false;
      rawSegments.push({
        start: segStart * frameSize,
        end: i * frameSize,
      });
    }
  }
  // Handle speech at end of audio
  if (inSpeech) {
    rawSegments.push({
      start: segStart * frameSize,
      end: samples.length,
    });
  }

  if (rawSegments.length === 0) return [];

  // Step 4: Filter out segments shorter than minSpeechMs
  const minSpeechSamples = Math.floor((opts.minSpeechMs / 1000) * sampleRate);
  const filtered = rawSegments.filter((seg) => seg.end - seg.start >= minSpeechSamples);

  if (filtered.length === 0) return [];

  // Step 5: Merge segments separated by less than minSilenceMs
  const minSilenceSamples = Math.floor((opts.minSilenceMs / 1000) * sampleRate);
  const merged = [filtered[0]];

  for (let i = 1; i < filtered.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = filtered[i];
    const gap = curr.start - prev.end;

    if (gap < minSilenceSamples) {
      // Merge: extend previous segment to cover current
      prev.end = curr.end;
    } else {
      merged.push({ ...curr });
    }
  }

  // Step 6: Add padding (clamped to audio bounds)
  const padSamples = Math.floor((opts.speechPadMs / 1000) * sampleRate);
  for (const seg of merged) {
    seg.start = Math.max(0, seg.start - padSamples);
    seg.end = Math.min(samples.length, seg.end + padSamples);
  }

  return merged;
}

/**
 * Compress silence gaps between speech segments.
 *
 * For each gap between segments:
 *   - if gap <= maxGapMs: keep as-is (natural speech pause)
 *   - if gap > maxGapMs: replace with maxGapMs of silence
 *
 * @param {Float32Array} samples - Original PCM samples
 * @param {number} sampleRate - Sample rate
 * @param {Array<{start: number, end: number}>} segments - Speech segments
 * @param {number} maxGapMs - Maximum gap duration to keep
 * @returns {{samples: Float32Array, originalDuration: number, compressedDuration: number}}
 */
export function compressGaps(samples, sampleRate, segments, maxGapMs = 500) {
  if (segments.length === 0) {
    return {
      samples: new Float32Array(0),
      originalDuration: samples.length / sampleRate,
      compressedDuration: 0,
    };
  }

  const maxGapSamples = Math.floor((maxGapMs / 1000) * sampleRate);

  // Calculate output size
  let outputLength = 0;

  // Leading silence (before first speech)
  const leadGap = segments[0].start;
  outputLength += Math.min(leadGap, maxGapSamples);

  // Speech segments + gaps between them
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    outputLength += seg.end - seg.start; // Speech duration

    if (i < segments.length - 1) {
      const gap = segments[i + 1].start - seg.end;
      outputLength += Math.min(gap, maxGapSamples); // Compressed gap
    }
  }

  // Trailing silence (after last speech)
  const trailGap = samples.length - segments[segments.length - 1].end;
  outputLength += Math.min(trailGap, maxGapSamples);

  // Build output
  const output = new Float32Array(outputLength);
  let writePos = 0;

  // Leading silence
  const leadKeep = Math.min(leadGap, maxGapSamples);
  if (leadKeep > 0) {
    // Fill with silence (zeros) — don't copy potentially noisy leading audio
    writePos += leadKeep;
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segLen = seg.end - seg.start;

    // Copy speech
    output.set(samples.subarray(seg.start, seg.end), writePos);
    writePos += segLen;

    // Inter-segment gap
    if (i < segments.length - 1) {
      const gapStart = seg.end;
      const gapEnd = segments[i + 1].start;
      const gapLen = gapEnd - gapStart;
      const keepLen = Math.min(gapLen, maxGapSamples);

      if (keepLen > 0 && gapLen <= maxGapSamples) {
        // Short gap — keep original audio (natural pause)
        output.set(samples.subarray(gapStart, gapStart + keepLen), writePos);
      }
      // Long gap — leave as zeros (silence)
      writePos += keepLen;
    }
  }

  // Trailing silence
  const trailKeep = Math.min(trailGap, maxGapSamples);
  writePos += trailKeep;

  const originalDuration = samples.length / sampleRate;
  const compressedDuration = outputLength / sampleRate;

  return { samples: output, originalDuration, compressedDuration };
}

/**
 * Run VAD gap compression on an AudioBuffer.
 * Returns a new AudioBuffer with compressed silence gaps.
 *
 * @param {AudioBuffer} audioBuffer - 16kHz mono AudioBuffer
 * @param {object} options - VAD options (see VAD_DEFAULTS)
 * @returns {AudioBuffer|null} New AudioBuffer with compressed gaps, or null if no compression needed
 */
export function processAudioBuffer(audioBuffer, options = {}) {
  const sampleRate = audioBuffer.sampleRate;
  const samples = audioBuffer.getChannelData(0);

  const segments = detectSpeechSegments(samples, sampleRate, options);

  if (segments.length === 0) {
    logger.info("VAD: No speech detected in audio", {}, "audio");
    return null;
  }

  // Check if compression would actually help
  const result = compressGaps(samples, sampleRate, segments, options.maxGapMs || VAD_DEFAULTS.maxGapMs);

  const silenceRemoved = result.originalDuration - result.compressedDuration;
  const compressionRatio = result.compressedDuration / result.originalDuration;

  logger.info(
    "VAD gap compression",
    {
      segments: segments.length,
      originalDuration: result.originalDuration.toFixed(1) + "s",
      compressedDuration: result.compressedDuration.toFixed(1) + "s",
      silenceRemoved: silenceRemoved.toFixed(1) + "s",
      compressionRatio: (compressionRatio * 100).toFixed(0) + "%",
    },
    "audio"
  );

  // Don't bother if we'd remove less than 1 second
  if (silenceRemoved < 1.0) {
    logger.debug("VAD: Skipping compression — less than 1s silence to remove", {}, "audio");
    return null;
  }

  // Build new AudioBuffer from compressed samples
  const offlineCtx = new OfflineAudioContext(1, result.samples.length, sampleRate);
  const newBuffer = offlineCtx.createBuffer(1, result.samples.length, sampleRate);
  newBuffer.getChannelData(0).set(result.samples);

  return newBuffer;
}
