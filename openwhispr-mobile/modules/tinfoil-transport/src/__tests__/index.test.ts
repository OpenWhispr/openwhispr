const mockGetCredential = jest.fn(async (_reference: string) => ({ apiKey: 'fixture' }));
const mockCredentialListeners = new Set<(reference: string | null) => void>();
jest.mock('@/services/providers/ProviderCredentials', () => ({
  getProviderCredential: (reference: string) => mockGetCredential(reference),
  subscribeProviderCredentialChanges: (listener: (reference: string | null) => void) => {
    mockCredentialListeners.add(listener);
    return () => mockCredentialListeners.delete(listener);
  },
}));
import { createTinfoilWebSocket, requestTinfoil } from '../index';
const mockNative = {
  prepare: jest.fn(),
  request: jest.fn(),
  openSocket: jest.fn(async () => undefined),
  send: jest.fn(async () => undefined),
  cancel: jest.fn(),
  addListener: jest.fn(),
};
let mockListener: (event: { id: string; type: string; data?: string }) => void;
const mockRemove = jest.fn();
jest.mock('expo', () => ({ requireOptionalNativeModule: () => mockNative }));
jest.mock('@/lib/uuid', () => ({ randomUUID: () => 'request-id' }));
beforeEach(() => {
  jest.clearAllMocks();
  mockCredentialListeners.clear();
  mockGetCredential.mockResolvedValue({ apiKey: 'fixture' });
  mockNative.addListener.mockImplementation((_name, listener) => {
    mockListener = listener;
    return { remove: mockRemove };
  });
});
it('rejects pre-cancelled requests without native transmission', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    requestTinfoil({ apiKey: 'fixture', path: '/v1/models', signal: controller.signal }),
  ).rejects.toThrow('cancelled');
  expect(mockNative.request).not.toHaveBeenCalled();
});
it('cancels native in-flight work and removes the abort listener', async () => {
  const controller = new AbortController();
  mockNative.request.mockImplementation(async () => {
    controller.abort();
    return { status: 200, body: '{}' };
  });
  await expect(
    requestTinfoil({ apiKey: 'fixture', path: '/v1/models', signal: controller.signal }),
  ).rejects.toThrow('cancelled');
  expect(mockNative.cancel).toHaveBeenCalledWith('request-id');
});
it('waits for a verified native open and preserves abnormal close events', () => {
  const socket = createTinfoilWebSocket('fixture', 'voxtral-mini-4b-realtime');
  const onOpen = jest.fn();
  const onClose = jest.fn();
  socket.onopen = onOpen;
  socket.onclose = onClose;
  expect(socket.readyState).toBe(0);
  mockListener({ id: 'unrelated', type: 'open' });
  expect(onOpen).not.toHaveBeenCalled();
  mockListener({ id: 'request-id', type: 'open' });
  expect(socket.readyState).toBe(1);
  mockListener({ id: 'request-id', type: 'close', data: '1006' });
  expect(onClose).toHaveBeenCalledWith({ code: 1006 });
  expect(mockRemove).toHaveBeenCalledTimes(1);
});

it('rejects promptly when attestation never finishes and the request is cancelled', async () => {
  mockNative.request.mockImplementation(() => new Promise(() => undefined));
  const controller = new AbortController();
  const pending = requestTinfoil({
    apiKey: 'fixture',
    path: '/v1/models',
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  expect(mockCredentialListeners.size).toBe(0);
});
it('closes an active attested socket when its credential is deleted or rotated', async () => {
  const socket = createTinfoilWebSocket('fixture', 'voxtral-mini-4b-realtime');
  await Promise.resolve();
  const onClose = jest.fn();
  socket.onclose = onClose;
  mockCredentialListeners.forEach((listener) => listener('provider.openai'));
  expect(onClose).not.toHaveBeenCalled();
  mockCredentialListeners.forEach((listener) => listener('provider.tinfoil'));
  expect(onClose).toHaveBeenCalledWith({ code: 1008 });
  expect(mockNative.cancel).toHaveBeenCalledWith('request-id');
  expect(mockCredentialListeners.size).toBe(0);
});
it('rejects a stale credential before starting native attestation', async () => {
  mockGetCredential.mockResolvedValueOnce({ apiKey: 'rotated' });
  await expect(requestTinfoil({ apiKey: 'fixture', path: '/v1/models' })).rejects.toThrow(
    'changed',
  );
  expect(mockNative.request).not.toHaveBeenCalled();
});
it('closes sockets on device credential reset and prevents later native opens', async () => {
  const socket = createTinfoilWebSocket('fixture', 'voxtral-mini-4b-realtime');
  mockCredentialListeners.forEach((listener) => listener(null));
  await Promise.resolve();
  expect(socket.readyState).toBe(3);
  expect(mockNative.openSocket).not.toHaveBeenCalled();
});

it('cancels an in-flight HTTP request on device credential reset', async () => {
  mockNative.request.mockImplementation(() => new Promise(() => undefined));
  const pending = requestTinfoil({ apiKey: 'fixture', path: '/v1/models' });
  await Promise.resolve();
  await Promise.resolve();
  expect(mockNative.prepare).toHaveBeenCalledWith('request-id');
  expect(mockNative.request).toHaveBeenCalled();
  mockCredentialListeners.forEach((listener) => listener(null));
  await expect(pending).rejects.toThrow('cancelled');
  expect(mockNative.cancel).toHaveBeenCalledWith('request-id');
  expect(mockCredentialListeners.size).toBe(0);
});
