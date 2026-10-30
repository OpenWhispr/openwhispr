const mockFits = jest.fn();
const mockReadiness = jest.fn();
jest.mock('../localReasoning', () => ({
  fitsLocalReasoningBudget: (...args: unknown[]) => mockFits(...args),
  getLocalReasoningReadiness: (...args: unknown[]) => mockReadiness(...args),
}));

import { fitDictionaryOnDevice, MAX_SHARED_WORDS_ON_DEVICE } from '../onDeviceDictionary';

const PERSONAL = ['Piha'];
const SHARED = Array.from({ length: 300 }, (_, i) => `term${i}`);
const TIERS = [PERSONAL, [], SHARED];
const build = ({ personal, shared }: { personal: string[]; shared: string[] }) => ({
  instructions: [...personal, ...shared].join(', '),
  prompt: 'text',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockReadiness.mockResolvedValue({ status: 'ready', contextSize: 4096 });
  mockFits.mockResolvedValue(true);
});

it('returns the personal words without counting when nothing is shared', async () => {
  await expect(fitDictionaryOnDevice([PERSONAL, [], []], build)).resolves.toEqual({
    personal: PERSONAL,
    shared: [],
  });
  expect(mockFits).not.toHaveBeenCalled();
});

it('caps shared words when the capped prompt fits', async () => {
  await expect(fitDictionaryOnDevice(TIERS, build)).resolves.toEqual({
    personal: PERSONAL,
    shared: SHARED.slice(0, MAX_SHARED_WORDS_ON_DEVICE),
  });
});

it('falls back to the personal words, then to the usual list when nothing fits', async () => {
  mockFits.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await expect(fitDictionaryOnDevice(TIERS, build)).resolves.toEqual({
    personal: PERSONAL,
    shared: [],
  });

  mockFits.mockResolvedValue(false);
  await expect(fitDictionaryOnDevice(TIERS, build)).resolves.toEqual({
    personal: PERSONAL,
    shared: SHARED.slice(0, 200),
  });
});

// It will be refused or go to Cloud, so trimming for a model that won't run is wasted.
it.each(['unavailable', 'appleIntelligenceOff', 'modelNotReady'])(
  'returns the usual list at once when Apple Intelligence is %s',
  async (status) => {
    mockReadiness.mockResolvedValue({ status });
    await expect(fitDictionaryOnDevice(TIERS, build)).resolves.toEqual({
      personal: PERSONAL,
      shared: SHARED.slice(0, 200),
    });
    expect(mockFits).not.toHaveBeenCalled();
  },
);
