import {
  MEETING_PAUSE_MS,
  QUICK_TURNS_EVENT_ID,
  quickTurns,
  quickerTurns,
} from '@/android/liveSpeakers/quickTurns';
import type { WebSocketLike } from '@/android/transcription/createRealtimeMeetingWs';

function leg() {
  const sent: string[] = [];
  const inner: WebSocketLike = {
    readyState: 1,
    send: (data) => sent.push(data),
    close: jest.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  const socket = quickTurns(() => inner)('wss://x', []);
  const received: unknown[] = [];
  socket.onmessage = (event) => received.push(JSON.parse(event.data));
  return {
    sent,
    received,
    deliver: (message: object) => inner.onmessage?.({ data: JSON.stringify(message) }),
  };
}

const serverVad = {
  type: 'server_vad',
  threshold: 0.3,
  prefix_padding_ms: 500,
  silence_duration_ms: 800,
};

it('shortens the pause once the session exists, keeping its other turn settings', () => {
  const { sent, received, deliver } = leg();
  const created = {
    type: 'session.created',
    session: { audio: { input: { turn_detection: serverVad } } },
  };
  deliver(created);
  deliver(created);
  expect(received).toEqual([created, created]);
  expect(sent.map((data) => JSON.parse(data))).toEqual([
    {
      type: 'session.update',
      event_id: QUICK_TURNS_EVENT_ID,
      session: {
        type: 'transcription',
        audio: {
          input: {
            turn_detection: { ...serverVad, silence_duration_ms: MEETING_PAUSE_MS },
          },
        },
      },
    },
  ]);
});

it('uses the older protocol’s event for an older session', () => {
  const { sent, deliver } = leg();
  deliver({ type: 'transcription_session.created', session: { turn_detection: serverVad } });
  expect(JSON.parse(sent[0])).toMatchObject({
    type: 'transcription_session.update',
    session: { turn_detection: { silence_duration_ms: MEETING_PAUSE_MS } },
  });
});

it('leaves a session without server turn detection, or one already quicker, alone', () => {
  expect(quickerTurns(null)).toBeNull();
  expect(quickerTurns({ type: 'semantic_vad' })).toBeNull();
  expect(quickerTurns({ ...serverVad, silence_duration_ms: 300 })).toBeNull();
  const { sent, deliver } = leg();
  deliver({ type: 'session.created', session: { audio: { input: { turn_detection: null } } } });
  expect(sent).toEqual([]);
});

it('hides OpenAI refusing the update, so the meeting isn’t marked failed', () => {
  const { received, deliver } = leg();
  deliver({ type: 'error', error: { event_id: QUICK_TURNS_EVENT_ID, message: 'nope' } });
  deliver({ type: 'error', error: { message: 'other' } });
  expect(received).toEqual([{ type: 'error', error: { message: 'other' } }]);
});
