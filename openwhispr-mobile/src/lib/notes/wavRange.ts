import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';
import type { AudioWindow } from '../../services/transcription/realtimeReconnect';

export const WAV_HEADER_BYTES = 44;

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;

const msToSampleBytes = (ms: number): number =>
  Math.floor((Math.max(0, ms) * SAMPLE_RATE) / 1000) * BYTES_PER_SAMPLE;

/** Whole milliseconds of audio in a 16 kHz mono 16-bit WAV of that size, header included. */
export const wavDurationMs = (fileBytes: number): number =>
  Math.max(0, Math.floor((fileBytes - WAV_HEADER_BYTES) / (BYTES_PER_SECOND / 1000)));

/** Byte offsets of [startMs, endMs) in a 16 kHz mono 16-bit WAV, clamped to the file and aligned to whole samples. */
export function wavByteRange(
  startMs: number,
  endMs: number,
  fileBytes: number,
): { offset: number; length: number } {
  // A truncated file may end mid-sample; only whole samples count as data.
  const dataBytes =
    Math.floor(Math.max(0, fileBytes - WAV_HEADER_BYTES) / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE;
  const start = Math.min(msToSampleBytes(startMs), dataBytes);
  const end = Math.min(msToSampleBytes(endMs), dataBytes);
  return { offset: WAV_HEADER_BYTES + start, length: Math.max(0, end - start) };
}

const buildWavHeader = (dataBytes: number): Buffer => {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
};

/**
 * The recording holds no audio in the range asked for (it ends earlier, or the range is empty).
 * Told apart from every other failure, which says nothing about what the recording holds.
 */
export class EmptyWavRangeError extends Error {
  readonly code = 'empty_range';

  constructor() {
    super('Recording has no audio in that range');
    this.name = 'EmptyWavRangeError';
  }
}

/**
 * Writes that stretch to a new WAV in the cache directory. Rejects with EmptyWavRangeError when
 * the recording has no audio there, and with the underlying error when it can't be read or written.
 */
export async function extractWavRange(
  sourceUri: string,
  startMs: number,
  endMs: number,
): Promise<string> {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error('Recording range is not valid');
  }
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    throw new Error('No cache directory to write the recording range to');
  }
  const info = await FileSystem.getInfoAsync(sourceUri);
  const fileBytes = info.exists && 'size' in info ? info.size : 0;
  const { offset, length } = wavByteRange(startMs, endMs, fileBytes);
  if (!(length > 0)) {
    throw new EmptyWavRangeError();
  }
  const base64 = await FileSystem.readAsStringAsync(sourceUri, {
    encoding: FileSystem.EncodingType.Base64,
    position: offset,
    length,
  });
  const read = Buffer.from(base64, 'base64');
  // A short read (the file shrank) must not leave a half sample or a header-only file.
  const data = read.subarray(0, read.length - (read.length % BYTES_PER_SAMPLE));
  if (data.length === 0) {
    throw new EmptyWavRangeError();
  }
  const wav = Buffer.concat([buildWavHeader(data.length), data]);
  const destination = `${cacheDirectory}meeting-range-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}.wav`;
  try {
    await FileSystem.writeAsStringAsync(destination, wav.toString('base64'), {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch (error) {
    // A partial file must never be mistaken for a finished stretch.
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
    throw error;
  }
  return destination;
}

/** Splits windows into pieces of at most maxMs and drops pieces shorter than minMs. */
export function splitWindows(windows: AudioWindow[], maxMs: number, minMs: number): AudioWindow[] {
  const pieces: AudioWindow[] = [];
  // A non-positive step would never advance the loop.
  if (!(maxMs > 0)) return pieces;
  for (const window of windows) {
    if (!Number.isFinite(window.startMs) || !Number.isFinite(window.endMs)) continue;
    for (let startMs = window.startMs; startMs < window.endMs; startMs += maxMs) {
      const endMs = Math.min(startMs + maxMs, window.endMs);
      if (endMs - startMs >= minMs) pieces.push({ startMs, endMs });
    }
  }
  return pieces;
}
