import { requestProviderNative, requestProviderFileNative } from '../NativeProviderTransport';
const mockRequest = jest.fn();
const mockCancel = jest.fn();
jest.mock('../../../../modules/background-uploader/src', () => ({
  BackgroundUploader: {
    requestProvider: (...args: unknown[]) => mockRequest(...args),
    cancelProviderRequest: (...args: unknown[]) => mockCancel(...args),
  },
}));
// Hermes has no DOMException global; run the abort paths the way the device does.
const nodeDOMException = globalThis.DOMException;
beforeAll(() => {
  delete (globalThis as { DOMException?: unknown }).DOMException;
});
afterAll(() => {
  globalThis.DOMException = nodeDOMException;
});
beforeEach(() => jest.clearAllMocks());
it.each(['json', 'file'])(
  'rejects a late successful %s response after cancellation',
  async (kind) => {
    const controller = new AbortController();
    mockRequest.mockImplementation(async () => {
      controller.abort();
      return { status: 200, body: '{}', url: 'https://api.example.com', headers: {} };
    });
    const result =
      kind === 'json'
        ? requestProviderNative('https://api.example.com', { signal: controller.signal })
        : requestProviderFileNative({
            url: 'https://api.example.com',
            fileUri: 'file://audio.wav',
            fileFieldName: 'file',
            fileMimeType: 'audio/wav',
            fileName: 'audio.wav',
            parameters: {},
            headers: {},
            signal: controller.signal,
          });
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockCancel).toHaveBeenCalled();
  },
);
it.each(['json', 'file'])('sends the 300 second provider timeout for %s requests', async (kind) => {
  mockRequest.mockResolvedValue({
    status: 200,
    body: '{}',
    url: 'https://api.example.com',
    headers: {},
  });
  if (kind === 'json') await requestProviderNative('https://api.example.com', { method: 'GET' });
  else
    await requestProviderFileNative({
      url: 'https://api.example.com',
      fileUri: 'file://audio.wav',
      fileFieldName: 'file',
      fileMimeType: 'audio/wav',
      fileName: 'audio.wav',
      parameters: {},
      headers: {},
    });
  expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: 300 }));
});
