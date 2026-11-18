import { requestProviderFileNative } from '../NativeProviderTransport';

const mockRequest = jest.fn();
const mockCancel = jest.fn();
const mockCapture = jest.fn(() => null);
const mockCurrent = jest.fn((_scope: unknown) => true);
const mockStop = jest.fn();
const mockObserve = jest.fn((_change: () => void) => mockStop);

jest.mock('@/lib/transcriptScope', () => ({
  captureTranscriptScope: () => mockCapture(),
  isTranscriptScopeCurrent: (scope: unknown) => mockCurrent(scope),
  observeTranscriptScope: (change: () => void) => mockObserve(change),
}));
jest.mock('../../../../modules/background-uploader/src', () => ({
  BackgroundUploader: {
    requestProvider: (...args: unknown[]) => mockRequest(...args),
    cancelProviderRequest: (...args: unknown[]) => mockCancel(...args),
  },
}));

const response = {
  status: 200,
  body: '{"text":"fixture words"}',
  url: 'https://fixture.invalid/v1/audio/transcriptions',
  headers: {},
};
const input = {
  url: response.url,
  fileUri: 'file:///synthetic/audio.m4a',
  fileFieldName: 'file',
  fileMimeType: 'audio/m4a',
  fileName: 'audio.m4a',
  parameters: { model: 'fixture-model' },
  headers: {},
  routeSnapshot: '{"noteId":"fixture-note"}',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue(response);
});

describe('upstream iOS native provider boundary', () => {
  it('uploads the original route without reading or observing transcript ownership', async () => {
    const result = await requestProviderFileNative(input);
    await expect(result.json()).resolves.toEqual({ text: 'fixture words' });
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ routeSnapshot: input.routeSnapshot }),
    );
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockObserve).not.toHaveBeenCalled();
    expect(mockCurrent).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('cancels a late native result without an Android ownership subscription', async () => {
    const controller = new AbortController();
    mockRequest.mockImplementation(async () => {
      controller.abort();
      return response;
    });
    await expect(
      requestProviderFileNative({ ...input, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockObserve).not.toHaveBeenCalled();
    expect(mockCurrent).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
  });
});
