// s16le samples from a Buffer, tolerating the odd-length and unaligned buffers
// helper stdout reads produce -- a plain Int16Array view throws on an odd
// byteOffset. Same contract computePcm16Rms already documents below.
function readInt16Samples(pcmBuffer) {
  const sampleCount = pcmBuffer.length >> 1;
  if ((pcmBuffer.byteOffset & 1) === 0) {
    return new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, sampleCount);
  }
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) samples[i] = pcmBuffer.readInt16LE(i * 2);
  return samples;
}

function downsample24kTo16k(pcmBuffer) {
  const input = readInt16Samples(pcmBuffer);
  const ratio = 1.5;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;
    const s0 = input[idx];
    const s1 = idx + 1 < input.length ? input[idx + 1] : s0;
    output[i] = Math.round(s0 + frac * (s1 - s0));
  }

  return Buffer.from(output.buffer);
}

function pcm16ToWav(pcmBuffer, sampleRate = 16000, channels = 1) {
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function pcm16ToFloat32(pcmBuffer) {
  const input = readInt16Samples(pcmBuffer);
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    output[i] = input[i] / 32768;
  }
  return output;
}

// Energy floors below which a meeting channel is treated as silent. Shared by
// the echo-leak detector and the auto-end activity monitor so both agree on
// what "audible" means.
const MEETING_MIC_ACTIVITY_RMS = 0.006;
const MEETING_SYSTEM_ACTIVITY_RMS = 0.004;

// RMS of raw s16le PCM in [0, 1]. Tolerates the odd-length and unaligned
// buffers that helper stdout reads produce (an Int16Array view would throw on
// an odd byteOffset), which is why it doesn't reuse pcm16ToFloat32.
function computePcm16Rms(pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length < 2) return 0;

  const sampleCount = pcmBuffer.length >> 1;
  let sumSquares = 0;

  if ((pcmBuffer.byteOffset & 1) === 0) {
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const sample = samples[i] / 32768;
      sumSquares += sample * sample;
    }
  } else {
    for (let i = 0; i < sampleCount; i++) {
      const sample = pcmBuffer.readInt16LE(i * 2) / 32768;
      sumSquares += sample * sample;
    }
  }

  return Math.sqrt(sumSquares / sampleCount);
}

module.exports = {
  downsample24kTo16k,
  pcm16ToWav,
  pcm16ToFloat32,
  computePcm16Rms,
  MEETING_MIC_ACTIVITY_RMS,
  MEETING_SYSTEM_ACTIVITY_RMS,
};
