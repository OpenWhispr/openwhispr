import { Platform } from 'react-native';
const mockAuthState: { user: { id: string } | null } = { user: null };
const mockProcessingState: { activeMode: 'cloud' | 'private' } = { activeMode: 'cloud' };
const mockConfigState: { config: { appleLocalIntelligenceEnabled?: boolean } | null } = {
  config: {},
};

jest.mock('@/lib/appleLLM', () => ({
  AppleLLM: {
    getAvailability: jest.fn(),
    countTokens: jest.fn(async () => null),
  },
}));

jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => mockAuthState },
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => mockProcessingState },
}));

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => mockConfigState },
}));

import {
  countLocalReasoningTokens,
  isLocalReasoningRequired,
  canRunLocalReasoning,
  clearLocalReasoningReadinessCache,
  countLocalInputTokens,
  fitsLocalCleanupOutput,
  getLocalReasoningReadiness,
  getLocalReasoningUnavailableMessage,
  isLocalOutputLimitError,
  isLocalReasoningUnsupported,
  shouldUseLocalReasoning,
  toLocalReasoningError,
} from '../localReasoning';
import { AppleLLM } from '@/lib/appleLLM';

const mockAppleAvailability = AppleLLM.getAvailability as jest.Mock;
const mockCountTokens = AppleLLM.countTokens as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  clearLocalReasoningReadinessCache();
  mockAppleAvailability.mockResolvedValue({
    status: 'available',
    contextSize: 4096,
    tokenCounting: true,
  });
  mockAuthState.user = { id: 'user-1' };
  mockProcessingState.activeMode = 'cloud';
  mockConfigState.config = {};
});

describe('local reasoning readiness policy', () => {
  it('keeps Android Local Mode notes local even when a note is shared', () => {
    const original = Platform.OS;
    Platform.OS = 'android';
    mockProcessingState.activeMode = 'private';
    try {
      expect(isLocalReasoningRequired({ isPrivateNote: false })).toBe(true);
    } finally {
      Platform.OS = original;
    }
  });

  it('does not use local reasoning for signed-in public cloud-mode content', async () => {
    await expect(shouldUseLocalReasoning({ isPrivateNote: false })).resolves.toBe(false);
    expect(mockAppleAvailability).not.toHaveBeenCalled();
  });

  // Note formatting follows its own selection in Local Mode; a note made there is private.
  it('does not require local reasoning for a shared note in Local Mode', async () => {
    mockProcessingState.activeMode = 'private';

    await expect(shouldUseLocalReasoning({ isPrivateNote: false })).resolves.toBe(false);
    await expect(shouldUseLocalReasoning({ isPrivateNote: true })).resolves.toBe(true);
  });

  it('uses local reasoning for signed-out content when ready', async () => {
    mockAuthState.user = null;

    await expect(shouldUseLocalReasoning()).resolves.toBe(true);
  });

  it('does not query Apple availability or use local reasoning when disabled by config', async () => {
    mockConfigState.config = { appleLocalIntelligenceEnabled: false };
    mockProcessingState.activeMode = 'private';

    await expect(getLocalReasoningReadiness()).resolves.toEqual({
      status: 'disabled',
      tokenCounting: false,
    });
    await expect(shouldUseLocalReasoning()).resolves.toBe(false);
    expect(mockAppleAvailability).not.toHaveBeenCalled();
  });

  it('maps Apple Intelligence disabled to appleIntelligenceOff', async () => {
    mockAppleAvailability.mockResolvedValue({
      status: 'appleIntelligenceNotEnabled',
      contextSize: 4096,
      tokenCounting: true,
    });

    await expect(getLocalReasoningReadiness()).resolves.toEqual({
      status: 'appleIntelligenceOff',
      contextSize: 4096,
      tokenCounting: true,
    });
    mockProcessingState.activeMode = 'private';
    await expect(shouldUseLocalReasoning()).resolves.toBe(false);
  });
});

it('explains Apple Intelligence being off without assuming the request is a note', () => {
  const message = getLocalReasoningUnavailableMessage({
    status: 'appleIntelligenceOff',
    tokenCounting: false,
  });
  expect(message).toContain('Apple Intelligence is turned off');
  expect(message).not.toMatch(/note/i);
});

it.each([
  ['deviceNotEligible', 'unsupportedDevice'],
  ['unsupportedOS', 'unsupportedOS'],
])(
  'reports an iPhone that cannot run Apple Intelligence (%s) as unsupported',
  async (native, status) => {
    mockAppleAvailability.mockResolvedValue({ status: native, tokenCounting: false });

    const readiness = await getLocalReasoningReadiness();

    expect(readiness.status).toBe(status);
    expect(isLocalReasoningUnsupported(readiness)).toBe(true);
  },
);

it.each([
  'ready',
  'disabled',
  'appleIntelligenceOff',
  'modelNotReady',
  'unavailable',
  'unsupportedLanguage',
] as const)('does not treat %s as an unsupported iPhone, since it can change', (status) => {
  expect(isLocalReasoningUnsupported({ status, tokenCounting: false })).toBe(false);
});

// Off in iOS Settings or still preparing its model, the iPhone still runs Apple Intelligence.
it.each([
  ['ready', true],
  ['appleIntelligenceOff', true],
  ['modelNotReady', true],
  ['unsupportedLanguage', true],
  ['disabled', false],
  ['unavailable', false],
  ['unsupportedDevice', false],
  ['unsupportedOS', false],
] as const)('reports whether this iPhone runs Apple Intelligence when %s', (status, runs) => {
  expect(canRunLocalReasoning({ status, tokenCounting: false })).toBe(runs);
});

it.each([
  [
    'unsupportedDevice',
    'On-Device AI needs an iPhone with Apple Intelligence (iPhone 15 Pro or later).',
  ],
  ['unsupportedOS', 'On-Device AI needs iOS 26 or later on an iPhone with Apple Intelligence.'],
] as const)('says what an unsupported iPhone needs (%s)', (status, message) => {
  expect(getLocalReasoningUnavailableMessage({ status, tokenCounting: false })).toBe(message);
});

it('never asks the Apple engine to count Android input tokens', async () => {
  const original = Platform.OS;
  Platform.OS = 'android';
  try {
    await expect(countLocalReasoningTokens({ prompt: 'Private Android note' })).resolves.toBeNull();
    expect(AppleLLM.countTokens).not.toHaveBeenCalled();
  } finally {
    Platform.OS = original;
  }
});

// iOS reports Apple Intelligence as off when the language keeps it off, so the language explains it.
describe("an iPhone set to a language Apple Intelligence doesn't support", () => {
  it.each(['appleIntelligenceNotEnabled', 'unavailable'])(
    'names the language when availability is %s',
    async (native) => {
      mockAppleAvailability.mockResolvedValue({
        status: native,
        tokenCounting: false,
        localeSupported: false,
        deviceLanguage: 'Polish (Poland)',
      });

      const readiness = await getLocalReasoningReadiness();

      expect(readiness).toEqual({
        status: 'unsupportedLanguage',
        deviceLanguage: 'Polish (Poland)',
        tokenCounting: false,
      });
      expect(getLocalReasoningUnavailableMessage(readiness)).toBe(
        "Apple Intelligence doesn't support Polish (Poland), your iPhone's language. Choose a supported one in Settings → General → Language & Region.",
      );
    },
  );

  // An ineligible iPhone can't be fixed in Settings, and a download means Apple Intelligence is on.
  it.each([
    ['deviceNotEligible', 'unsupportedDevice'],
    ['modelNotReady', 'modelNotReady'],
  ])('keeps the reason iOS gave for %s', async (native, status) => {
    mockAppleAvailability.mockResolvedValue({
      status: native,
      tokenCounting: false,
      localeSupported: false,
      deviceLanguage: 'Polish (Poland)',
    });

    await expect(getLocalReasoningReadiness()).resolves.toEqual(
      expect.objectContaining({ status }),
    );
  });

  it('never stops Apple Intelligence that iOS says is available', async () => {
    mockAppleAvailability.mockResolvedValue({
      status: 'available',
      contextSize: 4096,
      tokenCounting: true,
      localeSupported: false,
      deviceLanguage: 'English (South Africa)',
    });

    await expect(getLocalReasoningReadiness()).resolves.toMatchObject({ status: 'ready' });
  });

  // Binaries built before the check shipped send no language fields, and the model lists no
  // languages while it is off, so localeSupported is left out then.
  it.each([
    { status: 'appleIntelligenceNotEnabled', tokenCounting: false },
    {
      status: 'appleIntelligenceNotEnabled',
      tokenCounting: false,
      deviceLanguage: 'English (United States)',
    },
  ])('keeps the reason iOS gave when the language is not known to be wrong', async (payload) => {
    mockAppleAvailability.mockResolvedValue(payload);

    await expect(getLocalReasoningReadiness()).resolves.toMatchObject({
      status: 'appleIntelligenceOff',
    });
  });

  it("says the iPhone's language without a name", () => {
    expect(
      getLocalReasoningUnavailableMessage({ status: 'unsupportedLanguage', tokenCounting: false }),
    ).toBe(
      "Apple Intelligence doesn't support your iPhone's language. Choose a supported one in Settings → General → Language & Region.",
    );
  });
});

// The app can't read Siri's language, so the off message says what a Siri-only Settings page means.
it("says Apple Intelligence also needs Siri set to the iPhone's language", async () => {
  mockAppleAvailability.mockResolvedValue({
    status: 'appleIntelligenceNotEnabled',
    tokenCounting: false,
    localeSupported: true,
    deviceLanguage: 'English (South Africa)',
  });

  const readiness = await getLocalReasoningReadiness();

  expect(readiness).toMatchObject({ status: 'appleIntelligenceOff' });
  expect(getLocalReasoningUnavailableMessage(readiness)).toBe(
    "Apple Intelligence is turned off, so this can't run on-device. Turn it on in Settings → Apple Intelligence & Siri. If that page shows only Siri, set Siri to the same language as your iPhone.",
  );
});

describe('toLocalReasoningError', () => {
  it('explains an unsupported language rather than passing on the native text', () => {
    const error = toLocalReasoningError(
      Object.assign(new Error('UnsupportedLanguageOrLocale'), {
        code: 'APPLE_LLM_UNSUPPORTED_LANGUAGE',
      }),
    );
    expect(error).toMatchObject({
      code: 'APPLE_LLM_UNSUPPORTED_LANGUAGE',
      message:
        "Apple Intelligence doesn't support this language. If it's your iPhone's, choose another in Settings → General → Language & Region.",
      retryable: false,
    });
  });

  it('reads an aborted request as cancelled', () => {
    const aborted = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    expect(toLocalReasoningError(aborted)).toMatchObject({
      code: 'APPLE_LLM_CANCELLED',
      retryable: false,
    });
  });

  it('keeps the native cancellation code', () => {
    const cancelled = Object.assign(new Error('cancelled'), { code: 'APPLE_LLM_CANCELLED' });
    expect(toLocalReasoningError(cancelled)).toMatchObject({ code: 'APPLE_LLM_CANCELLED' });
  });

  it.each([
    'APPLE_LLM_GUARDRAIL',
    'APPLE_LLM_RATE_LIMITED',
    'APPLE_LLM_CONTEXT_LIMIT',
    'APPLE_LLM_OUTPUT_LIMIT',
  ])('marks %s as not worth retrying', (code) => {
    expect(toLocalReasoningError(Object.assign(new Error('x'), { code }))).toMatchObject({
      code,
      retryable: false,
    });
  });
});

it('reads the native output-limit code as an output limit, and nothing else', () => {
  const outputLimit = toLocalReasoningError(
    Object.assign(new Error('decodingFailure'), { code: 'APPLE_LLM_OUTPUT_LIMIT' }),
  );
  expect(isLocalOutputLimitError(outputLimit)).toBe(true);
  expect(
    isLocalOutputLimitError(Object.assign(new Error('x'), { code: 'APPLE_LLM_CONTEXT_LIMIT' })),
  ).toBe(false);
  expect(isLocalOutputLimitError(new Error('x'))).toBe(false);
});

describe('countLocalInputTokens', () => {
  it('counts on the device, and estimates instructions and prompt together without it', async () => {
    mockCountTokens.mockResolvedValueOnce(42);
    await expect(countLocalInputTokens({ instructions: 'rules', prompt: 'text' })).resolves.toBe(
      42,
    );
    expect(mockCountTokens).toHaveBeenCalledWith({ instructions: 'rules', prompt: 'text' });

    mockCountTokens.mockResolvedValueOnce(null);
    await expect(
      countLocalInputTokens({ instructions: 'a'.repeat(33), prompt: 'b'.repeat(33) }),
    ).resolves.toBe(20);
  });
});

describe('fitsLocalCleanupOutput', () => {
  // A 2,000-word dictation fits a 4,096-token context, but its cleaned copy can't fit the
  // 900-token output cap.
  it('refuses a transcript whose cleaned copy would run past the output cap', async () => {
    mockCountTokens.mockResolvedValueOnce(2_060);
    await expect(fitsLocalCleanupOutput('long dictation')).resolves.toBe(false);
    expect(mockCountTokens).toHaveBeenCalledWith({ prompt: 'long dictation' });
  });

  it('accepts a transcript that leaves room for punctuation under the cap', async () => {
    mockCountTokens.mockResolvedValueOnce(720);
    await expect(fitsLocalCleanupOutput('short dictation')).resolves.toBe(true);
  });

  it('estimates from length where iOS cannot count tokens', async () => {
    mockCountTokens.mockResolvedValueOnce(null);
    await expect(fitsLocalCleanupOutput('word '.repeat(600))).resolves.toBe(false);
    mockCountTokens.mockResolvedValueOnce(null);
    await expect(fitsLocalCleanupOutput('word '.repeat(100))).resolves.toBe(true);
  });
});
