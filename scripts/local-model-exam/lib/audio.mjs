// 16 kHz mono PCM16 helpers. Everything the engines receive is converted the
// way the app converts (ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le, ffmpegUtils.js).
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpegPath = require("ffmpeg-static");

export const SAMPLE_RATE = 16000;

export function pcmToWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function fileToPcm(inputPath) {
  const { stdout } = await execFileAsync(
    ffmpegPath,
    [
      "-v",
      "error",
      "-i",
      inputPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 512 }
  );
  return stdout;
}

export function secondsOf(pcm) {
  return pcm.length / 2 / SAMPLE_RATE;
}

export function silencePcm(seconds) {
  return Buffer.alloc(Math.round(seconds * SAMPLE_RATE) * 2);
}

// Seeded noise so the silence set is identical on every run.
export function noisePcm(seconds, dbfs, color = "white", seed = 1) {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = Buffer.alloc(n * 2);
  let state = seed >>> 0 || 1;
  const rand = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffffffff) * 2 - 1;
  };
  const amplitude = Math.pow(10, dbfs / 20);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let k = 0; k < n; k++) {
    const white = rand();
    let v = white;
    if (color === "pink") {
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      v = (b0 + b1 + b2 + white * 0.1848) / 3.5;
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * amplitude * 32767))), k * 2);
  }
  return out;
}

export function concatPcm(parts, gapSeconds = 0) {
  const gap = silencePcm(gapSeconds);
  const pieces = [];
  parts.forEach((part, index) => {
    if (index > 0 && gapSeconds > 0) pieces.push(gap);
    pieces.push(part);
  });
  return Buffer.concat(pieces);
}
