import { Buffer } from 'buffer';
import { createLineClock, type LineSpan } from '@/android/liveSpeakers/lineClock';
import { createSpeakerMatcher, cosineSimilarity } from '@/android/liveSpeakers/speakerMatcher';
import { createLiveSpeakers } from '@/android/liveSpeakers/liveSpeakers';
import { applySpeakerPass } from '@/android/liveSpeakers/speakerPass';
import { speakerRuns } from '@/android/providers/deepgram';
import type { WebSocketLike } from '@/services/transcription/createRealtimeMeetingWs';

const RATE = 24000;
const BYTES_PER_MS = (RATE * 2) / 1000;

function fakeSocket() {
  const sent: string[] = [];
  const socket: WebSocketLike = {
    readyState: 1,
    send: (data) => sent.push(data),
    close: jest.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  return {
    socket,
    sent,
    deliver: (event: object) => socket.onmessage?.({ data: JSON.stringify(event) }),
  };
}

const append = (ms: number) =>
  JSON.stringify({
    type: 'input_audio_buffer.append',
    audio: Buffer.alloc(ms * BYTES_PER_MS).toString('base64'),
  });

describe('lineClock', () => {
  it('puts each leg on the WAV clock, also after a reconnect that replays buffered audio', () => {
    const lines: LineSpan[] = [];
    const clock = createLineClock({ sampleRate: RATE, onLine: (line) => lines.push(line) });
    const legs: ReturnType<typeof fakeSocket>[] = [];
    const factory = clock.wrapFactory(() => {
      const leg = fakeSocket();
      legs.push(leg);
      return leg.socket;
    });

    const first = factory('wss://x', []);
    clock.captured(1000 * BYTES_PER_MS);
    first.send(append(1000));
    first.onmessage = jest.fn();
    legs[0].deliver({
      type: 'input_audio_buffer.speech_started',
      item_id: 'a',
      audio_start_ms: 200,
    });
    legs[0].deliver({ type: 'input_audio_buffer.speech_stopped', item_id: 'a', audio_end_ms: 900 });
    legs[0].deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'Hello there',
    });
    expect(first.onmessage).toHaveBeenCalledTimes(3);

    // 10 s more audio while the first leg dies; the new leg gets the last 4 s replayed first.
    clock.captured(10_000 * BYTES_PER_MS);
    const second = factory('wss://x', []);
    second.send(append(4000));
    legs[1].deliver({
      type: 'input_audio_buffer.speech_started',
      item_id: 'b',
      audio_start_ms: 500,
    });
    legs[1].deliver({
      type: 'input_audio_buffer.speech_stopped',
      item_id: 'b',
      audio_end_ms: 3500,
    });
    legs[1].deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'b',
      transcript: 'Back again',
      speaker: 'B',
    });

    expect(lines).toEqual([
      { itemId: 'L1:a', startMs: 200, endMs: 900, estimated: false, providerSpeaker: null },
      // Leg 2 starts at 11 s − 4 s = 7 s into the WAV.
      { itemId: 'L2:b', startMs: 7500, endMs: 10500, estimated: false, providerSpeaker: 'B' },
    ]);
  });

  it('estimates a line OpenAI sent without timings from the audio sent so far', () => {
    const lines: LineSpan[] = [];
    const clock = createLineClock({ sampleRate: RATE, onLine: (line) => lines.push(line) });
    const leg = fakeSocket();
    const socket = clock.wrapFactory(() => leg.socket)('wss://x', []);
    clock.captured(6000 * BYTES_PER_MS);
    socket.send(append(6000));
    leg.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'c',
      transcript: 'x'.repeat(40),
    });
    expect(lines).toEqual([
      { itemId: 'L1:c', startMs: 2600, endMs: 5200, estimated: true, providerSpeaker: null },
    ]);
  });
});

describe('speakerMatcher', () => {
  it('matches a voice to the closest speaker and starts a new one below the bar', () => {
    const matcher = createSpeakerMatcher();
    expect(matcher.assign([1, 0, 0]).label).toBe('speaker_0');
    expect(matcher.assign([0.95, 0.1, 0]).label).toBe('speaker_0');
    expect(matcher.assign([0, 1, 0])).toMatchObject({ label: 'speaker_1', created: true });
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('merges two speakers that turn out to be one voice and never reuses a label', () => {
    const matcher = createSpeakerMatcher();
    matcher.assign([1, 0, 0]);
    // Under the 0.6 match bar, so a second speaker.
    expect(matcher.assign([0.55, 0.835, 0]).label).toBe('speaker_1');
    // Closer to speaker_0, and pulls it within 0.7 of speaker_1.
    expect(matcher.assign([0.9, 0.436, 0]).label).toBe('speaker_0');
    const merges = matcher.recluster();
    expect(merges).toEqual([expect.objectContaining({ keep: 'speaker_0', remove: 'speaker_1' })]);
    expect(matcher.assign([0, 0, 1]).label).toBe('speaker_2');
  });
});

describe('createLiveSpeakers', () => {
  const span = (
    itemId: string,
    startMs: number,
    endMs: number,
    providerSpeaker: string | null = null,
  ) => ({
    itemId,
    startMs,
    endMs,
    estimated: false,
    providerSpeaker,
  });

  it('labels long lines from voiceprints, one at a time, and fills a short line between the same voice', async () => {
    const voices: Record<string, number[]> = { a: [1, 0], c: [1, 0], d: [0, 1] };
    let running = 0;
    let most = 0;
    const embed = jest.fn(async (startMs: number) => {
      running++;
      most = Math.max(most, running);
      await Promise.resolve();
      running--;
      return voices[{ 0: 'a', 5000: 'c', 9000: 'd' }[startMs] as string];
    });
    const changes: Record<string, string>[] = [];
    const live = createLiveSpeakers(
      { embed, modelReady: async () => true },
      { onChange: (labels) => changes.push(labels) },
    );
    live.line(span('a', 0, 3000));
    live.line(span('b', 3000, 3600)); // too short for a voiceprint
    live.line(span('c', 5000, 8000));
    live.line(span('d', 9000, 12000));
    await live.drain(1000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(embed).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
    expect(live.labels()).toEqual({
      a: 'speaker_0',
      b: 'speaker_0',
      c: 'speaker_0',
      d: 'speaker_1',
    });
    expect(changes.length).toBeGreaterThan(0);
  });

  it("uses the provider's speakers and takes no voiceprints", () => {
    const embed = jest.fn();
    const live = createLiveSpeakers({ embed, modelReady: async () => true });
    live.line(span('a', 0, 3000, 'A'));
    live.line(span('b', 3000, 3500, 'PENDING'));
    live.line(span('c', 3500, 6000, 'A'));
    live.line(span('d', 6000, 9000, 'B'));
    expect(embed).not.toHaveBeenCalled();
    expect(live.providerLabelled()).toBe(true);
    expect(live.labels()).toEqual({
      a: 'speaker_0',
      b: 'speaker_0',
      c: 'speaker_0',
      d: 'speaker_1',
    });
  });

  it('labels nothing without the speaker model and stops after repeated failures', async () => {
    const embed = jest.fn().mockRejectedValue(new Error('boom'));
    const live = createLiveSpeakers({ embed, modelReady: async () => true });
    for (let index = 0; index < 5; index++)
      live.line(span(`l${index}`, index * 3000, index * 3000 + 2000));
    await live.drain(1000);
    expect(embed).toHaveBeenCalledTimes(3);
    expect(live.labels()).toEqual({});

    const missing = jest.fn();
    const without = createLiveSpeakers({ embed: missing, modelReady: async () => false });
    without.line(span('a', 0, 3000));
    await without.drain(1000);
    expect(missing).not.toHaveBeenCalled();
  });
});

describe('applySpeakerPass', () => {
  it('keeps live labels where the pass agrees and corrects lines it got wrong', () => {
    const segments = applySpeakerPass(
      [
        { text: 'One.', startMs: 0, endMs: 3000, label: 'speaker_0' },
        { text: 'Two.', startMs: 3000, endMs: 6000, label: 'speaker_1' },
        { text: 'Three.', startMs: 6000, endMs: 9000, label: 'speaker_1' },
      ],
      [
        // The pass's speaker 4 is the live speaker_0; its 7 is speaker_1.
        { startMs: 0, endMs: 3000, speakerId: 4 },
        { startMs: 3000, endMs: 6000, speakerId: 7 },
        { startMs: 6000, endMs: 9000, speakerId: 4 },
      ],
    );
    expect(segments.map((segment) => segment.speakerLabel)).toEqual([
      'speaker_0',
      'speaker_1',
      'speaker_0',
    ]);
  });

  it('splits a line holding two people at a sentence boundary and ignores a short blip', () => {
    const [first, second, ...rest] = applySpeakerPass(
      [
        {
          text: 'I think we ship on Friday. No, the release needs another week of testing.',
          startMs: 0,
          endMs: 8000,
          label: null,
        },
      ],
      [
        { startMs: 0, endMs: 2800, speakerId: 0 },
        { startMs: 2800, endMs: 3200, speakerId: 1 },
        { startMs: 3200, endMs: 3500, speakerId: 0 },
        { startMs: 3500, endMs: 8000, speakerId: 1 },
      ],
    );
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ text: 'I think we ship on Friday.', speakerLabel: 'speaker_0' });
    expect(second).toMatchObject({
      text: 'No, the release needs another week of testing.',
      speakerLabel: 'speaker_1',
    });
    expect(second.startMs).toBe(first.endMs);
  });

  it('gives a new speaker the next free number and leaves a line with no turns as it was', () => {
    const segments = applySpeakerPass(
      [
        { text: 'Hi.', startMs: 0, endMs: 2000, label: 'speaker_3' },
        { text: 'Hello.', startMs: 2000, endMs: 4000, label: 'speaker_3' },
        { text: 'Silence?', startMs: 9000, endMs: 10000, label: 'speaker_3' },
      ],
      [
        { startMs: 0, endMs: 2000, speakerId: 0 },
        { startMs: 2000, endMs: 4000, speakerId: 1 },
      ],
    );
    expect(segments.map((segment) => segment.speakerLabel)).toEqual([
      'speaker_3',
      'speaker_4',
      'speaker_3',
    ]);
  });
});

describe('Deepgram speaker runs', () => {
  it('splits a result where the speaker changes', () => {
    expect(
      speakerRuns([
        { punctuated_word: 'Yes,', start: 0.1, end: 0.4, speaker: 0 },
        { punctuated_word: 'agreed.', start: 0.4, end: 0.9, speaker: 0 },
        { punctuated_word: 'Great.', start: 1.2, end: 1.6, speaker: 1 },
      ]),
    ).toEqual([
      { text: 'Yes, agreed.', startMs: 100, endMs: 900, speaker: '0' },
      { text: 'Great.', startMs: 1200, endMs: 1600, speaker: '1' },
    ]);
    expect(speakerRuns([{ word: 'hi', start: 0, end: 1 }])).toEqual([]);
  });
});
