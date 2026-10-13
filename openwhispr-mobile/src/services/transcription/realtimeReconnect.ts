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

// Bounded reconnect backoff budget (drives `withRetry` in the service).
export const RECONNECT_MAX_RETRIES = 6;
export const RECONNECT_INITIAL_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 15000;
export const CONNECT_TIMEOUT_MS = 15000;

export const PCM_TAIL_SECONDS = 20;

// PCM16 mono is 2 bytes/sample.
export function pcmTailCapBytes(sampleRate: number): number {
  return sampleRate * 2 * PCM_TAIL_SECONDS;
}

/**
 * Byte-bounded FIFO of raw PCM chunks: `push` drops the oldest chunks once the total
 * exceeds `maxBytes` (a long outage becomes a bounded gap); `drain` empties it.
 */
export class PcmRingBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    // Keep the most recent chunk so a single oversized frame can't empty the buffer.
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift() as Buffer;
      this.bytes -= dropped.length;
    }
  }

  drain(): Buffer[] {
    const out = this.chunks;
    this.chunks = [];
    this.bytes = 0;
    return out;
  }

  get byteLength(): number {
    return this.bytes;
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
  return `L${legIndex}:${itemId}`;
}

interface LegOffsetEvent {
  audio_start_ms?: number;
  audio_end_ms?: number;
  [key: string]: unknown;
}

/**
 * Shift a server event's audio timings by the leg's cumulative offset. Returned
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
