const { pcm16ToWav } = require("../../../src/utils/audioUtils");

// Minimal RIFF/WAVE builders for tests that need a real header without FFmpeg.

function wavHeader({
  audioFormat = 1,
  channels = 1,
  sampleRate = 16000,
  bitsPerSample = 16,
  dataSize = 0,
} = {}) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

// 16 kHz mono PCM16, the shape every local engine decodes as-is.
function pcm16Mono16kWav(samples = [0, 100, -100, 200]) {
  return pcm16ToWav(Buffer.from(Int16Array.from(samples).buffer));
}

function insertWavChunk(wav, id, payload, offset) {
  const chunk = Buffer.alloc(8 + payload.length + (payload.length % 2));
  chunk.write(id, 0, 4, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  const result = Buffer.concat([wav.subarray(0, offset), chunk, wav.subarray(offset)]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

module.exports = { wavHeader, pcm16Mono16kWav, insertWavChunk };
