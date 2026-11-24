import { Buffer } from 'buffer';
import {
  PcmRingBuffer,
  mergeAudioWindows,
  classifyClose,
  namespaceItemId,
  legItemPrefix,
  applyLegOffset,
  shouldRotate,
  pcmTailCapBytes,
  ROTATION_MS,
  ROTATE_ON_RECONNECT_THRESHOLD_MS,
  RECONNECT_MAX_RETRIES,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  CONNECT_TIMEOUT_MS,
  STOP_FLUSH_TIMEOUT_MS,
  SHORT_LEG_MS,
  shortLegBackoffMs,
} from '../realtimeReconnect';
import { createRealtimeEventReducer } from '../realtimeEvents';

describe('PcmRingBuffer', () => {
  it('accumulates chunks while under the cap and drains them in order', () => {
    const ring = new PcmRingBuffer(100);
    ring.push(Buffer.from([1, 2, 3, 4]), 0);
    ring.push(Buffer.from([5, 6]), 0);
    expect(ring.byteLength).toBe(6);
    const drained = Buffer.concat(ring.drain());
    expect([...drained]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('drops the oldest chunks when the cap is exceeded, keeping the recent tail', () => {
    const ring = new PcmRingBuffer(10);
    ring.push(Buffer.from([1, 1, 1, 1]), 0); // 4 bytes
    ring.push(Buffer.from([2, 2, 2, 2]), 0); // 8 bytes
    ring.push(Buffer.from([3, 3, 3, 3]), 0); // 12 > 10 → drop oldest ([1,1,1,1])
    expect(ring.byteLength).toBe(8);
    const drained = Buffer.concat(ring.drain());
    expect([...drained]).toEqual([2, 2, 2, 2, 3, 3, 3, 3]);
  });

  it('counts the bytes it drops, and a drain does not count as a drop', () => {
    const ring = new PcmRingBuffer(100);
    ring.push(Buffer.alloc(60), 0);
    expect(ring.droppedBytes).toBe(0);
    ring.push(Buffer.alloc(60), 0); // 120 > 100: the oldest chunk goes
    ring.push(Buffer.alloc(60), 0);
    expect(ring.droppedBytes).toBe(120);
    expect(ring.byteLength).toBe(60);
    ring.drain();
    expect(ring.droppedBytes).toBe(120); // a drain sends audio, it does not drop it
  });

  it('records where each evicted chunk sat on the capture clock', () => {
    // sampleRate 100 → 200 bytes a second, so a 200-byte chunk is 1000 ms; cap 400 bytes.
    const ring = new PcmRingBuffer(400, 100);
    ring.push(Buffer.alloc(200), 0);
    ring.push(Buffer.alloc(200), 1000);
    expect(ring.droppedWindows).toEqual([]);
    ring.push(Buffer.alloc(200), 2000); // 600 > 400: the chunk at 0 ms goes
    ring.push(Buffer.alloc(200), 3000); // the chunk at 1000 ms goes, joining the first window
    expect(ring.droppedWindows).toEqual([{ startMs: 0, endMs: 2000 }]);
    ring.drain();
    expect(ring.droppedWindows).toEqual([{ startMs: 0, endMs: 2000 }]); // a drain drops nothing
  });

  it('empties on drain so a subsequent drain returns nothing', () => {
    const ring = new PcmRingBuffer(100);
    ring.push(Buffer.from([9, 9]), 0);
    expect(Buffer.concat(ring.drain()).length).toBe(2);
    expect(ring.byteLength).toBe(0);
    expect(ring.drain()).toEqual([]);
  });
});

describe('mergeAudioWindows', () => {
  it('sorts windows and joins those closer than a second', () => {
    expect(
      mergeAudioWindows([
        { startMs: 5000, endMs: 6000 },
        { startMs: 0, endMs: 1000 },
        { startMs: 1500, endMs: 3000 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 3000 },
      { startMs: 5000, endMs: 6000 },
    ]);
  });

  it('keeps windows a full second apart separate and folds one inside another', () => {
    expect(
      mergeAudioWindows([
        { startMs: 0, endMs: 1000 },
        { startMs: 2000, endMs: 3000 },
        { startMs: 2200, endMs: 2500 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
    ]);
  });

  it('returns nothing for nothing', () => {
    expect(mergeAudioWindows([])).toEqual([]);
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

describe('createRealtimeEventReducer pending items', () => {
  it('counts committed items until they complete or fail', () => {
    const reducer = createRealtimeEventReducer({});
    reducer.handleEvent({ type: 'input_audio_buffer.committed', item_id: 'a' });
    reducer.handleEvent({ type: 'input_audio_buffer.committed', item_id: 'b' });
    expect(reducer.pendingItemCount()).toBe(2);
    reducer.handleEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'hi',
    });
    reducer.handleEvent({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'b',
    });
    expect(reducer.pendingItemCount()).toBe(0);
  });
});

describe('createRealtimeEventReducer failed turns and per-leg pending', () => {
  it('reports a failed turn with the timing it knows, and counts pending items per prefix', () => {
    const onTranscriptionFailed = jest.fn();
    const reducer = createRealtimeEventReducer({ onTranscriptionFailed });
    reducer.handleEvent({
      type: 'input_audio_buffer.speech_started',
      item_id: 'L1:f',
      audio_start_ms: 500,
    });
    reducer.handleEvent({
      type: 'input_audio_buffer.speech_stopped',
      item_id: 'L1:f',
      audio_end_ms: 1500,
    });
    reducer.handleEvent({ type: 'input_audio_buffer.committed', item_id: 'L1:f' });
    reducer.handleEvent({ type: 'input_audio_buffer.committed', item_id: 'L2:g' });
    expect(reducer.pendingItemCountWithPrefix('L1:')).toBe(1);
    expect(reducer.pendingItemCountWithPrefix('L2:')).toBe(1);

    reducer.handleEvent({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'L1:f',
    });

    expect(onTranscriptionFailed).toHaveBeenCalledWith({
      itemId: 'L1:f',
      startMs: 500,
      endMs: 1500,
    });
    expect(reducer.pendingItemCountWithPrefix('L1:')).toBe(0);
    expect(reducer.pendingItemCount()).toBe(1);
    expect(reducer.utterances()).toEqual([]);
  });

  it('lists pending items of one prefix with their timing and knows which VAD started', () => {
    const reducer = createRealtimeEventReducer({});
    reducer.handleEvent({
      type: 'input_audio_buffer.speech_started',
      item_id: 'L1:v',
      audio_start_ms: 1000,
    });
    reducer.handleEvent({ type: 'input_audio_buffer.committed', item_id: 'L1:v' });
    reducer.handleEvent({ type: 'input_audio_buffer.committed', item_id: 'L1:m' });
    reducer.handleEvent({ type: 'input_audio_buffer.committed', item_id: 'L2:n' });

    expect(reducer.pendingItemTimings('L1:')).toEqual([
      { itemId: 'L1:v', startMs: 1000, endMs: null },
      { itemId: 'L1:m', startMs: null, endMs: null },
    ]);
    expect(reducer.isSpeechStarted('L1:v')).toBe(true);
    expect(reducer.isSpeechStarted('L1:m')).toBe(false);
  });

  it('reports a failed turn it has no timing for with null times', () => {
    const onTranscriptionFailed = jest.fn();
    const reducer = createRealtimeEventReducer({ onTranscriptionFailed });
    reducer.handleEvent({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'x',
    });
    expect(onTranscriptionFailed).toHaveBeenCalledWith({ itemId: 'x', startMs: null, endMs: null });
  });
});

describe('dropPendingItems', () => {
  it('forgets only the pending items under the given leg prefix', () => {
    const reducer = createRealtimeEventReducer({});
    reducer.handleEvent({ type: 'input_audio_buffer.committed', item_id: namespaceItemId(1, 'a') });
    reducer.handleEvent({ type: 'input_audio_buffer.committed', item_id: namespaceItemId(2, 'a') });
    reducer.handleEvent({
      type: 'input_audio_buffer.committed',
      item_id: namespaceItemId(11, 'b'),
    });

    reducer.dropPendingItems(legItemPrefix(1));

    expect(reducer.pendingItemCount()).toBe(2);
  });
});

describe('shortLegBackoffMs', () => {
  it('waits nothing after a healthy leg and doubles up to the cap after short ones', () => {
    expect(SHORT_LEG_MS).toBe(5000);
    expect(shortLegBackoffMs(0)).toBe(0);
    expect(shortLegBackoffMs(1)).toBe(1000);
    expect(shortLegBackoffMs(2)).toBe(2000);
    expect(shortLegBackoffMs(5)).toBe(15000);
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

  it('never runs out of reconnect attempts, with a capped backoff', () => {
    expect(RECONNECT_MAX_RETRIES).toBe(Number.POSITIVE_INFINITY);
    expect(STOP_FLUSH_TIMEOUT_MS).toBe(3000);
    expect(RECONNECT_INITIAL_DELAY_MS).toBe(1000);
    expect(RECONNECT_MAX_DELAY_MS).toBe(15000);
    expect(CONNECT_TIMEOUT_MS).toBe(15000);
  });
});
