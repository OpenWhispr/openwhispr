/**
 * Pure helpers + tuning constants for the realtime transport's reconnect + rotation
 * logic — free of React Native, the WebSocket, and native modules so they unit-test
 * cleanly. The stateful leg-swap machinery lives in `RealtimeMeetingWsService.ts`.
 */
import { Buffer } from 'buffer';

// Roll into a fresh session at ~50 min, well before OpenAI's ~60-min cap.
export const ROTATION_MS = 50 * 60 * 1000;
// A drop past this age must rotate, not reconnect: a plain reconnect would resurrect
// a session the server rejects near the ~60-min cap.
export const ROTATE_ON_RECONNECT_THRESHOLD_MS = 55 * 60 * 1000;

// Reconnects never give up: the mic keeps recording through any outage and the
// backoff is capped, so a long one only costs a retry every RECONNECT_MAX_DELAY_MS.
export const RECONNECT_MAX_RETRIES = Number.POSITIVE_INFINITY;
export const RECONNECT_INITIAL_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 15000;
export const CONNECT_TIMEOUT_MS = 15000;
// How long a closing leg waits for its last turn to be transcribed.
export const STOP_FLUSH_TIMEOUT_MS = 3000;

// A leg the server closes sooner than this after it opened counts as short-lived.
export const SHORT_LEG_MS = 5000;

/**
 * Wait before reconnecting after `consecutiveShortLegs` legs in a row closed right after
 * opening. Each reconnect starts a fresh retry loop whose first attempt is immediate, so
 * without this a server that accepts and then drops every socket gets an unthrottled loop.
 */
export function shortLegBackoffMs(consecutiveShortLegs: number): number {
  if (consecutiveShortLegs <= 0) return 0;
  return Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_INITIAL_DELAY_MS * 2 ** (consecutiveShortLegs - 1),
  );
}

export const PCM_TAIL_SECONDS = 20;

// PCM16 mono is 2 bytes/sample.
export function pcmTailCapBytes(sampleRate: number): number {
  return sampleRate * 2 * PCM_TAIL_SECONDS;
}

/** How long `bytes` of PCM16 mono last, in ms, unrounded; callers pick the rounding. */
export function pcmBytesToMs(bytes: number, sampleRate: number): number {
  return (bytes * 1000) / (sampleRate * 2);
}

/** A stretch of captured audio, `[startMs, endMs)` on the capture clock. */
export interface AudioWindow {
  startMs: number;
  endMs: number;
}

// Windows this close are re-transcribed as one stretch; a sliver of audio that did reach
// the socket between two drops is cheaper to transcribe twice than to cut around.
const AUDIO_WINDOW_JOIN_MS = 1000;

/** Sorted, merged; windows closer than 1 s are joined. */
export function mergeAudioWindows(windows: AudioWindow[]): AudioWindow[] {
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  const merged: AudioWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.startMs - last.endMs < AUDIO_WINDOW_JOIN_MS) {
      last.endMs = Math.max(last.endMs, window.endMs);
    } else {
      merged.push({ startMs: window.startMs, endMs: window.endMs });
    }
  }
  return merged;
}

/**
 * Byte-bounded FIFO of raw PCM chunks: `push` drops the oldest chunks once the total
 * exceeds `maxBytes` (a long outage becomes a bounded gap) and records where each dropped
 * chunk sat on the capture clock; `drain` empties it.
 */
export class PcmRingBuffer {
  private chunks: { chunk: Buffer; startMs: number }[] = [];
  private bytes = 0;
  private dropped = 0;
  private windows: AudioWindow[] = [];

  /** `sampleRate` (PCM16 mono) gives a dropped chunk its length in ms. */
  constructor(
    private readonly maxBytes: number,
    private readonly sampleRate: number,
  ) {}

  /** `startMs` is where the chunk begins on the capture clock. */
  push(chunk: Buffer, startMs: number): void {
    this.chunks.push({ chunk, startMs });
    this.bytes += chunk.length;
    // Keep the most recent chunk so a single oversized frame can't empty the buffer.
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const evicted = this.chunks.shift() as { chunk: Buffer; startMs: number };
      this.bytes -= evicted.chunk.length;
      this.dropped += evicted.chunk.length;
      this.recordDrop(evicted.startMs, evicted.chunk.length);
    }
  }

  drain(): Buffer[] {
    const out = this.chunks.map((entry) => entry.chunk);
    this.chunks = [];
    this.bytes = 0;
    return out;
  }

  get byteLength(): number {
    return this.bytes;
  }

  /** Bytes pushed out past the cap over the buffer's life; drains don't count. */
  get droppedBytes(): number {
    return this.dropped;
  }

  /** Where the evicted chunks sat on the capture clock, oldest first. */
  get droppedWindows(): AudioWindow[] {
    return this.windows.map((window) => ({ ...window }));
  }

  private recordDrop(startMs: number, length: number): void {
    // Rounded up so a window never stops short of the audio it lost.
    const endMs = startMs + Math.ceil(pcmBytesToMs(length, this.sampleRate));
    const last = this.windows[this.windows.length - 1];
    // Evictions run oldest first and back to back, so a long outage stays one window.
    if (last && startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, endMs);
      return;
    }
    this.windows.push({ startMs, endMs });
  }
}

export type CloseDecision = 'reconnect' | 'rotate' | 'terminal';

// Non-recoverable close codes (policy/auth/quota) — a fresh token won't fix a
// rejected account, so give up rather than hammer.
export const TERMINAL_CLOSE_CODES = new Set<number>([1008]);

export function shouldRotate(ageMs: number, thresholdMs: number): boolean {
  return ageMs >= thresholdMs;
}

/** `sessionAgeMs` is the whole session's age; `isConnected` is sampled at close time. */
export function classifyClose(
  code: number | undefined,
  isConnected: boolean,
  sessionAgeMs: number,
): CloseDecision {
  if (shouldRotate(sessionAgeMs, ROTATE_ON_RECONNECT_THRESHOLD_MS)) return 'rotate';
  // Offline close codes (e.g. 1006) are unreliable — reconnect and let the loop wait.
  if (!isConnected) return 'reconnect';
  if (code !== undefined && TERMINAL_CLOSE_CODES.has(code)) return 'terminal';
  return 'reconnect';
}

/**
 * Namespace a server `item_id` with its leg index — the server restarts ids on every
 * fresh leg, so without this two legs could overwrite each other (and collide as keys).
 */
export function namespaceItemId(legIndex: number, itemId: string): string {
  return `${legItemPrefix(legIndex)}${itemId}`;
}

/** The prefix every namespaced item id of one leg starts with. */
export function legItemPrefix(legIndex: number): string {
  return `L${legIndex}:`;
}

interface LegOffsetEvent {
  audio_start_ms?: number;
  audio_end_ms?: number;
  [key: string]: unknown;
}

/**
 * Shift a server event's audio timings by the leg's offset on the capture clock. Returned
 * untouched when the offset is zero or the event carries no timings (so null timings
 * still reach the reducer's fallback). Never mutates the input.
 */
export function applyLegOffset<T extends object>(event: T, offsetMs: number): T {
  if (offsetMs === 0) return event;
  const next = { ...(event as LegOffsetEvent) };
  if (typeof next.audio_start_ms === 'number') next.audio_start_ms += offsetMs;
  if (typeof next.audio_end_ms === 'number') next.audio_end_ms += offsetMs;
  return next as unknown as T;
}
