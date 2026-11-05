import { startRealtimeMeetingWs, type WebSocketLike } from '../RealtimeMeetingWsService';
import { LivePCMStreaming } from '../../../modules/live-pcm-streaming/src/index.android';

jest.mock('@/lib/apiClient', () => ({
  api: { post: jest.fn(async () => ({ clientSecret: 'test' })) },
}));
jest.mock('expo-network', () => ({ getNetworkStateAsync: jest.fn() }));
jest.mock('../../../modules/live-pcm-streaming/src/index.android', () => ({
  DEFAULT_SAMPLE_RATE: 24000,
  LivePCMStreaming: { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined) },
  addPcmFrameListener: () => ({ remove: jest.fn() }),
}));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
class Socket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  send = jest.fn();
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}
beforeEach(() => {
  jest.clearAllMocks();
});
it('does not reject cancelled startup until native capture has stopped', async () => {
  const stopped = deferred();
  jest.mocked(LivePCMStreaming.stop).mockReturnValueOnce(stopped.promise);
  const controller = new AbortController();
  const socket = new Socket();
  let settled = false;
  const starting = startRealtimeMeetingWs(
    { signal: controller.signal },
    {},
    { wsFactory: () => socket },
  );
  const observed = starting.catch((error: unknown) => {
    settled = true;
    return error;
  });
  await flush();
  controller.abort();
  await flush();
  expect(LivePCMStreaming.stop).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  stopped.resolve();
  expect(await observed).toBeInstanceOf(Error);
});
it('shares native Stop completion across abort and repeated stop calls', async () => {
  const stopped = deferred();
  jest.mocked(LivePCMStreaming.stop).mockReturnValueOnce(stopped.promise);
  const controller = new AbortController();
  const socket = new Socket();
  const starting = startRealtimeMeetingWs(
    { signal: controller.signal },
    {},
    { wsFactory: () => socket },
  );
  await flush();
  socket.open();
  const session = await starting;
  controller.abort();
  const first = session.stop();
  const second = session.stop();
  expect(LivePCMStreaming.stop).toHaveBeenCalledTimes(1);
  stopped.resolve();
  await Promise.all([first, second]);
  expect(LivePCMStreaming.stop).toHaveBeenCalledTimes(1);
});

it('closes a first socket that opens immediately before cancellation', async () => {
  const controller = new AbortController();
  const socket = new Socket();
  const starting = startRealtimeMeetingWs(
    { signal: controller.signal },
    {},
    { wsFactory: () => socket },
  );
  await flush();
  socket.open();
  controller.abort();
  await expect(starting).rejects.toThrow('cancelled');
  expect(socket.readyState).toBe(3);
  expect(socket.send).not.toHaveBeenCalledWith(
    expect.stringContaining('input_audio_buffer.append'),
  );
});
