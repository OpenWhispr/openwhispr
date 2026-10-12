import { Buffer } from 'buffer';
import {
  PcmRingBuffer,
  classifyClose,
  namespaceItemId,
  applyLegOffset,
  shouldRotate,
  pcmTailCapBytes,
  ROTATION_MS,
  ROTATE_ON_RECONNECT_THRESHOLD_MS,
  RECONNECT_MAX_RETRIES,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  CONNECT_TIMEOUT_MS,
} from '../realtimeReconnect';
import { createRealtimeEventReducer } from '../realtimeEvents';

describe('PcmRingBuffer', () => {
  it('accumulates chunks while under the cap and drains them in order', () => {
    const ring = new PcmRingBuffer(100);
    ring.push(Buffer.from([1, 2, 3, 4]));
    ring.push(Buffer.from([5, 6]));
    expect(ring.byteLength).toBe(6);
    const drained = Buffer.concat(ring.drain());
    expect([...drained]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('drops the oldest chunks when the cap is exceeded, keeping the recent tail', () => {
    const ring = new PcmRingBuffer(10);
    ring.push(Buffer.from([1, 1, 1, 1])); // 4 bytes
    ring.push(Buffer.from([2, 2, 2, 2])); // 8 bytes
    ring.push(Buffer.from([3, 3, 3, 3])); // 12 > 10 → drop oldest ([1,1,1,1])
    expect(ring.byteLength).toBe(8);
    const drained = Buffer.concat(ring.drain());
    expect([...drained]).toEqual([2, 2, 2, 2, 3, 3, 3, 3]);
  });

  it('empties on drain so a subsequent drain returns nothing', () => {
    const ring = new PcmRingBuffer(100);
    ring.push(Buffer.from([9, 9]));
    expect(Buffer.concat(ring.drain()).length).toBe(2);
    expect(ring.byteLength).toBe(0);
    expect(ring.drain()).toEqual([]);
  });
});

describe('pcmTailCapBytes', () => {
  it('bounds the buffer to ~20s of PCM16 mono at the given sample rate', () => {
    expect(pcmTailCapBytes(24000)).toBe(24000 * 2 * 20);
    expect(pcmTailCapBytes(16000)).toBe(16000 * 2 * 20);
  });
});

describe('classifyClose', () => {
  const YOUNG = 10 * 60 * 1000;
  const OLD = 56 * 60 * 1000;

  it('reconnects a young live leg on an abnormal close', () => {
    expect(classifyClose(1006, true, YOUNG)).toBe('reconnect');
  });

  it('rotates instead of reconnecting once the session nears the ~60-min cap', () => {
    expect(classifyClose(1006, true, OLD)).toBe('rotate');
    expect(classifyClose(1000, true, ROTATE_ON_RECONNECT_THRESHOLD_MS)).toBe('rotate');
  });

  it('treats an online policy/auth close as terminal (a fresh token would not help)', () => {
    expect(classifyClose(1008, true, YOUNG)).toBe('terminal');
  });

  it('never goes terminal while offline — the reconnect loop waits for connectivity', () => {
    expect(classifyClose(1008, false, YOUNG)).toBe('reconnect');
    expect(classifyClose(1006, false, YOUNG)).toBe('reconnect');
  });
});

describe('shouldRotate', () => {
  it('is true only once the age reaches the threshold', () => {
    expect(shouldRotate(ROTATION_MS - 1, ROTATION_MS)).toBe(false);
    expect(shouldRotate(ROTATION_MS, ROTATION_MS)).toBe(true);
    expect(shouldRotate(ROTATION_MS + 1, ROTATION_MS)).toBe(true);
  });
});

describe('namespaceItemId', () => {
  it('prefixes the raw item id with its leg index', () => {
    expect(namespaceItemId(1, 'item_abc')).toBe('L1:item_abc');
    expect(namespaceItemId(2, 'item_abc')).toBe('L2:item_abc');
  });

  it('keeps the same raw id from two legs as two distinct finalized utterances', () => {
    const reducer = createRealtimeEventReducer({});
    const completed = (itemId: string, transcript: string): unknown => ({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      transcript,
    });
    // Same server-side raw id "item_1" recycled by a fresh leg after a roll.
    reducer.handleEvent(completed(namespaceItemId(1, 'item_1'), 'first leg'));
    reducer.handleEvent(completed(namespaceItemId(2, 'item_1'), 'second leg'));
    const utterances = reducer.utterances();
    expect(utterances).toHaveLength(2);
    expect(utterances.map((u) => u.text)).toEqual(['first leg', 'second leg']);
    expect(utterances.map((u) => u.itemId)).toEqual(['L1:item_1', 'L2:item_1']);
  });
});

describe('applyLegOffset', () => {
  it('passes an event through untouched when the offset is zero (leg 0)', () => {
    const event = { type: 'x', audio_start_ms: 100, audio_end_ms: 500 };
    const out = applyLegOffset(event, 0);
    expect(out).toEqual({ type: 'x', audio_start_ms: 100, audio_end_ms: 500 });
  });

  it('adds the leg offset to both audio timings without mutating the input', () => {
    const event = { type: 'x', audio_start_ms: 100, audio_end_ms: 500 };
    const out = applyLegOffset(event, 60000) as typeof event;
    expect(out.audio_start_ms).toBe(60100);
    expect(out.audio_end_ms).toBe(60500);
    // Input untouched.
    expect(event.audio_start_ms).toBe(100);
    expect(event.audio_end_ms).toBe(500);
  });

  it('leaves events without audio timings alone so the segment fallback still applies', () => {
    const event = { type: 'conversation.item.input_audio_transcription.delta', delta: 'hi' };
    const out = applyLegOffset(event, 60000);
    expect(out).toEqual({ type: 'conversation.item.input_audio_transcription.delta', delta: 'hi' });
  });
});

describe('reconnect constants', () => {
  it('rotate proactively (50m) before the reconnect-must-rotate threshold (55m), both under the 60-min cap', () => {
    expect(ROTATION_MS).toBeLessThan(ROTATE_ON_RECONNECT_THRESHOLD_MS);
    expect(ROTATE_ON_RECONNECT_THRESHOLD_MS).toBeLessThan(60 * 60 * 1000);
  });

  it('exposes a bounded reconnect backoff budget', () => {
    expect(RECONNECT_MAX_RETRIES).toBe(6);
    expect(RECONNECT_INITIAL_DELAY_MS).toBe(1000);
    expect(RECONNECT_MAX_DELAY_MS).toBe(15000);
    expect(CONNECT_TIMEOUT_MS).toBe(15000);
  });
});
