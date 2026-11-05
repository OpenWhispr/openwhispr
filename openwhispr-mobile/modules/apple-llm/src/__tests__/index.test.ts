const mockNative: {
  generateText: jest.Mock;
  cancelGeneration?: jest.Mock;
} = {
  generateText: jest.fn(),
  cancelGeneration: jest.fn(),
};

jest.mock('expo', () => ({
  requireNativeModule: jest.fn(() => mockNative),
}));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

// Required after the mocks above: a hoisted import would read mockNative before it exists.
const { AppleLLM } = jest.requireActual<typeof import('../index')>('../index');

const request = { instructions: 'Clean this up.', prompt: 'um hello' };
const response = { text: 'Hello.', model: 'apple-foundation-models' as const };

function pendingNative(): { reject: (error: Error) => void } {
  let reject: (error: Error) => void = () => undefined;
  mockNative.generateText.mockReturnValue(
    new Promise((_resolve, rejectNative) => {
      reject = rejectNative;
    }),
  );
  return { reject: (error) => reject(error) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNative.cancelGeneration = jest.fn();
});

it('sends the request unchanged when there is no signal', async () => {
  mockNative.generateText.mockResolvedValue(response);
  await expect(AppleLLM.generateText(request)).resolves.toEqual(response);
  expect(mockNative.generateText).toHaveBeenCalledWith(request);
});

it('cancels the native run by its id and rejects with an AbortError on abort', async () => {
  const native = pendingNative();
  const controller = new AbortController();
  const result = AppleLLM.generateText(request, { signal: controller.signal });

  controller.abort();

  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  const { requestId } = mockNative.generateText.mock.calls[0][0] as { requestId: string };
  expect(requestId).toEqual(expect.any(String));
  expect(mockNative.cancelGeneration).toHaveBeenCalledWith(requestId);
  // The native cancellation arriving afterwards is swallowed, not reported unhandled.
  native.reject(Object.assign(new Error('cancelled'), { code: 'APPLE_LLM_CANCELLED' }));
  await Promise.resolve();
});

it('gives each request its own id', async () => {
  mockNative.generateText.mockResolvedValue(response);
  const { signal } = new AbortController();
  await AppleLLM.generateText(request, { signal });
  await AppleLLM.generateText(request, { signal });
  const [first, second] = mockNative.generateText.mock.calls.map(
    ([sent]) => (sent as { requestId: string }).requestId,
  );
  expect(first).not.toBe(second);
});

// A JS reload restarts the counter, but native keeps the runs started before it.
it('keeps ids unique across a JS reload', async () => {
  mockNative.generateText.mockResolvedValue(response);
  const { signal } = new AbortController();
  const now = jest.spyOn(Date, 'now');
  for (const time of [1_000, 2_000]) {
    now.mockReturnValue(time);
    await jest.isolateModulesAsync(async () => {
      const reloaded = jest.requireActual<typeof import('../index')>('../index');
      await reloaded.AppleLLM.generateText(request, { signal });
    });
  }
  now.mockRestore();
  const [beforeReload, afterReload] = mockNative.generateText.mock.calls.map(
    ([sent]) => (sent as { requestId: string }).requestId,
  );
  expect(beforeReload).not.toBe(afterReload);
});

it('rejects an already-aborted signal without starting a native run', async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(AppleLLM.generateText(request, { signal: controller.signal })).rejects.toMatchObject(
    { name: 'AbortError' },
  );
  expect(mockNative.generateText).not.toHaveBeenCalled();
  expect(mockNative.cancelGeneration).not.toHaveBeenCalled();
});

it('stops listening for abort once the native run settles', async () => {
  mockNative.generateText.mockResolvedValue(response);
  const controller = new AbortController();
  const removeEventListener = jest.spyOn(controller.signal, 'removeEventListener');

  await expect(AppleLLM.generateText(request, { signal: controller.signal })).resolves.toEqual(
    response,
  );
  await Promise.resolve();
  expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));

  controller.abort();
  expect(mockNative.cancelGeneration).not.toHaveBeenCalled();
});

it('passes a native failure through', async () => {
  const failure = Object.assign(new Error('blocked'), { code: 'APPLE_LLM_GUARDRAIL' });
  mockNative.generateText.mockRejectedValue(failure);
  const { signal } = new AbortController();
  await expect(AppleLLM.generateText(request, { signal })).rejects.toBe(failure);
});

it('still rejects on abort when the binary predates cancelGeneration', async () => {
  pendingNative();
  delete mockNative.cancelGeneration;
  const controller = new AbortController();
  const result = AppleLLM.generateText(request, { signal: controller.signal });

  controller.abort();

  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
});
