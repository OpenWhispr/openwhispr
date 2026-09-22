/**
 * Tests for agentName wiring in cleanupTranscript:
 * - agentName passed only for dictation/keyboard contexts when agent is applicable
 * - never passed for notes/meeting contexts or when context is omitted
 * - timeout bumped to 30s only when detectAgentMention hits
 * - regression: feature disabled → behavior byte-identical to disabled case
 */
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { cleanupTranscript, CLEANUP_TIMEOUT_MS } from '@/lib/cleanupTranscript';

// accountAccess pulls in the router for its sign-in alert; stub it here.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(async (req: { text: string }) => ({
      text: `cleaned:${req.text}`,
      model: 'm',
    })),
  },
}));

jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u', isAnonymous: false } }) },
}));

jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));

jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => undefined,
}));

// Config store: use a mutable ref so each test can set a different config without
// jest.resetModules (which doesn't work without --experimental-vm-modules).
let mockConfig: Record<string, unknown> = { cleanupEnabled: true, defaultMode: 'cloud' };
let mockActiveMode = 'cloud';

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: mockActiveMode }) },
}));

const mockProcessText = ReasoningService.processText as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = { cleanupEnabled: true, defaultMode: 'cloud' };
  mockActiveMode = 'cloud';
});

// ── agentName gating ─────────────────────────────────────────────────────────

describe('cleanupTranscript agentName — dictation/keyboard context (applicable)', () => {
  it('passes agentName for a keyboard context when agent is enabled (cloud)', async () => {
    mockConfig = {
      cleanupEnabled: true,
      defaultMode: 'cloud',
      dictationAgentEnabled: true,
      dictationAgentName: 'Aria',
    };

    await cleanupTranscript('hey Aria do something', { context: 'keyboard' });

    const req = mockProcessText.mock.calls[0][0] as Record<string, unknown>;
    expect(req.agentName).toBe('Aria');
  });

  it('passes the default agent name when dictationAgentName is unset', async () => {
    mockConfig = {
      cleanupEnabled: true,
      defaultMode: 'cloud',
      dictationAgentEnabled: true,
    };

    await cleanupTranscript('hey OpenWhispr draft a reply', { context: 'recording' });

    const req = mockProcessText.mock.calls[0][0] as Record<string, unknown>;
    expect(req.agentName).toBe('OpenWhispr');
  });

  it('passes agentName for a recording context when agent is enabled (cloud)', async () => {
    mockConfig = {
      cleanupEnabled: true,
      defaultMode: 'cloud',
      dictationAgentEnabled: true,
    };

    await cleanupTranscript('hey OpenWhispr draft a reply', { context: 'recording' });

    const req = mockProcessText.mock.calls[0][0] as Record<string, unknown>;
    expect(req.agentName).toBe('OpenWhispr');
  });
});

describe('cleanupTranscript agentName — never for notes/meetings', () => {
  beforeEach(() => {
    mockConfig = {
      cleanupEnabled: true,
      defaultMode: 'cloud',
      dictationAgentEnabled: true,
    };
  });

  it('does not pass agentName for notes context even when agent is enabled', async () => {
    await cleanupTranscript('some note text', { context: 'notes' });

    const req = mockProcessText.mock.calls[0][0] as Record<string, unknown>;
    expect(req.agentName).toBeUndefined();
  });

  it('does not pass agentName for meeting context even when agent is enabled', async () => {
    await cleanupTranscript('meeting transcript text', { context: 'meeting' });

    const req = mockProcessText.mock.calls[0][0] as Record<string, unknown>;
    expect(req.agentName).toBeUndefined();
  });

  it('does not pass agentName when context is omitted (legacy non-dictation callers)', async () => {
    await cleanupTranscript('some text');

    const req = mockProcessText.mock.calls[0][0] as Record<string, unknown>;
    expect(req.agentName).toBeUndefined();
  });
});

describe('cleanupTranscript agentName — feature disabled (regression guard)', () => {
  it('does not pass agentName when agent is disabled', async () => {
    mockConfig = {
      cleanupEnabled: true,
      defaultMode: 'cloud',
      dictationAgentEnabled: false,
    };

    await cleanupTranscript('hey OpenWhispr do something', { context: 'keyboard' });

    const req = mockProcessText.mock.calls[0][0] as Record<string, unknown>;
    expect(req.agentName).toBeUndefined();
  });

  it('does not pass agentName when mode is private', async () => {
    mockActiveMode = 'private';
    mockConfig = {
      cleanupEnabled: true,
      defaultMode: 'private',
      dictationAgentEnabled: true,
    };

    await cleanupTranscript('hey OpenWhispr do something', { context: 'keyboard' });

    const req = mockProcessText.mock.calls[0][0] as Record<string, unknown>;
    expect(req.agentName).toBeUndefined();
  });
});

// ── timeout bump ─────────────────────────────────────────────────────────────

const AGENT_TIMEOUT_MS = 30_000;

describe('cleanupTranscript timeout bump', () => {
  it('uses 30s timeout when agentName is applicable and mention is detected', async () => {
    mockConfig = {
      cleanupEnabled: true,
      defaultMode: 'cloud',
      dictationAgentEnabled: true,
    };

    await cleanupTranscript('hey OpenWhispr write a summary', { context: 'keyboard' });

    const req = mockProcessText.mock.calls[0][0] as Record<string, unknown>;
    expect(req.timeoutMs).toBe(AGENT_TIMEOUT_MS);
  });

  it('uses the default 12s timeout when agentName is applicable but no mention detected', async () => {
    mockConfig = {
      cleanupEnabled: true,
      defaultMode: 'cloud',
      dictationAgentEnabled: true,
    };

    await cleanupTranscript('just a regular dictation without the name', { context: 'keyboard' });

    const req = mockProcessText.mock.calls[0][0] as Record<string, unknown>;
    expect(req.timeoutMs).toBe(CLEANUP_TIMEOUT_MS);
  });

  it('uses the default 12s timeout when agent is disabled', async () => {
    mockConfig = {
      cleanupEnabled: true,
      defaultMode: 'cloud',
      dictationAgentEnabled: false,
    };

    await cleanupTranscript('hey OpenWhispr write a summary', { context: 'keyboard' });

    const req = mockProcessText.mock.calls[0][0] as Record<string, unknown>;
    expect(req.timeoutMs).toBe(CLEANUP_TIMEOUT_MS);
  });
});
