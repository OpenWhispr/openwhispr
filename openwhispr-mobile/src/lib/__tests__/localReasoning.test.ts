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
  canRunLocalReasoning,
  clearLocalReasoningReadinessCache,
  getLocalReasoningReadiness,
  getLocalReasoningUnavailableMessage,
  isLocalReasoningUnsupported,
  shouldUseLocalReasoning,
  toLocalReasoningError,
} from '../localReasoning';
import { AppleLLM } from '@/lib/appleLLM';

const mockAppleAvailability = AppleLLM.getAvailability as jest.Mock;

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
  it('does not use local reasoning for signed-in public cloud-mode content', async () => {
    await expect(shouldUseLocalReasoning({ isPrivateNote: false })).resolves.toBe(false);
    expect(mockAppleAvailability).not.toHaveBeenCalled();
  });

  it('uses local reasoning in private mode when Apple Intelligence is ready', async () => {
    mockProcessingState.activeMode = 'private';

    await expect(shouldUseLocalReasoning({ isPrivateNote: false })).resolves.toBe(true);
    expect(mockAppleAvailability).toHaveBeenCalledTimes(1);
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

it.each(['ready', 'disabled', 'appleIntelligenceOff', 'modelNotReady', 'unavailable'] as const)(
  'does not treat %s as an unsupported iPhone, since it can change',
  (status) => {
    expect(isLocalReasoningUnsupported({ status, tokenCounting: false })).toBe(false);
  },
);

// Off in iOS Settings or still preparing its model, the iPhone still runs Apple Intelligence.
it.each([
  ['ready', true],
  ['appleIntelligenceOff', true],
  ['modelNotReady', true],
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

describe('toLocalReasoningError', () => {
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

  it.each(['APPLE_LLM_GUARDRAIL', 'APPLE_LLM_RATE_LIMITED', 'APPLE_LLM_CONTEXT_LIMIT'])(
    'marks %s as not worth retrying',
    (code) => {
      expect(toLocalReasoningError(Object.assign(new Error('x'), { code }))).toMatchObject({
        code,
        retryable: false,
      });
    },
  );
});
