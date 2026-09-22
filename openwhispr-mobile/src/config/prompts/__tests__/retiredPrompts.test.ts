import { createHash } from 'node:crypto';
import {
  DEFAULT_CLEANUP_PROMPT,
  PROMPT_KIND_LIST,
  type PromptKind,
} from '@/config/prompts/registry';
import {
  CURRENT_DEFAULT_PROMPT_HASHES,
  RETIRED_DEFAULT_PROMPT_HASHES,
  hashPromptText,
  isRetiredDefaultPrompt,
  sweepRetiredPromptOverrides,
} from '@/config/prompts/retiredPrompts';

// Byte-exact copies of retired desktop defaults, extracted from git history.
import fixtures from './retiredPromptFixtures.json';

// Hermes has no crypto.subtle; production hashes through expo-crypto. Under
// jest-expo the native module resolves undefined, so back it with node:crypto
// here and flip `mockDigestAvailable` to exercise the unavailable path.
let mockDigestAvailable = true;
jest.mock('expo-crypto', () => {
  const nodeCrypto = require('node:crypto') as typeof import('node:crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digestStringAsync: jest.fn(async (_algorithm: string, text: string) =>
      mockDigestAvailable
        ? nodeCrypto.createHash('sha256').update(text, 'utf8').digest('hex')
        : undefined,
    ),
  };
});

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

type FakeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  keys: () => string[];
};

function makeStorage(initial: Record<string, string> = {}): FakeStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    keys: () => [...map.keys()],
  };
}

beforeEach(() => {
  mockDigestAvailable = true;
});

describe('isRetiredDefaultPrompt', () => {
  it('flags the retired English two-mode fullPrompt that shadows hardened defaults', async () => {
    expect(await isRetiredDefaultPrompt(fixtures.enTwoModeFullPrompt)).toBe(true);
  });

  it('flags the retired pre-hardening English cleanup prompt', async () => {
    expect(await isRetiredDefaultPrompt(fixtures.enPreHardeningCleanupPrompt)).toBe(true);
  });

  it('flags the earliest DEFAULT_PROMPTS.agent shipped default', async () => {
    expect(await isRetiredDefaultPrompt(fixtures.eraADefaultAgentPrompt)).toBe(true);
  });

  it('treats a one-character edit of a retired default as a user customization', async () => {
    const appended = `${fixtures.enTwoModeFullPrompt}.`;
    const mutated = `${fixtures.enTwoModeFullPrompt.slice(0, 100)}!${fixtures.enTwoModeFullPrompt.slice(101)}`;
    expect(await isRetiredDefaultPrompt(appended)).toBe(false);
    expect(await isRetiredDefaultPrompt(mutated)).toBe(false);
  });

  it('never flags the currently shipped cleanup default', async () => {
    expect(await isRetiredDefaultPrompt(DEFAULT_CLEANUP_PROMPT)).toBe(false);
  });

  it('never flags user-authored text or degenerate values', async () => {
    expect(
      await isRetiredDefaultPrompt('Always format my dictations as bullet points and fix grammar.'),
    ).toBe(false);
    expect(await isRetiredDefaultPrompt('')).toBe(false);
    expect(await isRetiredDefaultPrompt(null)).toBe(false);
    expect(await isRetiredDefaultPrompt(undefined)).toBe(false);
    expect(await isRetiredDefaultPrompt(42)).toBe(false);
    expect(await isRetiredDefaultPrompt({})).toBe(false);
  });

  it('is false, not a throw, when the native digest is unavailable', async () => {
    mockDigestAvailable = false;
    expect(await hashPromptText(fixtures.enTwoModeFullPrompt)).toBeNull();
    expect(await isRetiredDefaultPrompt(fixtures.enTwoModeFullPrompt)).toBe(false);
  });
});

describe('hash registry', () => {
  it('holds well-formed sha256 hex digests', () => {
    for (const hash of RETIRED_DEFAULT_PROMPT_HASHES) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const hash of Object.values(CURRENT_DEFAULT_PROMPT_HASHES)) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('current-hash snapshot matches the shipped default (ratchet)', () => {
    // A shipped default prompt changed: move its old hash into
    // RETIRED_DEFAULT_PROMPT_HASHES and record the new hash in
    // CURRENT_DEFAULT_PROMPT_HASHES (src/config/prompts/retiredPrompts.ts).
    expect(CURRENT_DEFAULT_PROMPT_HASHES).toEqual({ cleanup: sha256(DEFAULT_CLEANUP_PROMPT) });
  });

  it('keeps the retired and current sets disjoint', () => {
    for (const hash of Object.values(CURRENT_DEFAULT_PROMPT_HASHES)) {
      expect(RETIRED_DEFAULT_PROMPT_HASHES.has(hash)).toBe(false);
    }
  });
});

describe('sweepRetiredPromptOverrides', () => {
  it('clears an override matching a retired default and archives it', async () => {
    const storage = makeStorage({
      'customPrompt.cleanup': fixtures.enTwoModeFullPrompt,
      'customPrompt.dictationAgent': fixtures.enTwoModeFullPrompt,
    });
    const swept = await sweepRetiredPromptOverrides(storage, ['cleanup', 'dictationAgent']);
    expect(swept).toEqual(['cleanup', 'dictationAgent']);
    expect(storage.getItem('customPrompt.cleanup')).toBeNull();
    expect(storage.getItem('customPrompt.dictationAgent')).toBeNull();
    expect(storage.getItem('customPrompt.cleanup.retired')).toBe(fixtures.enTwoModeFullPrompt);
    expect(storage.getItem('customPrompt.dictationAgent.retired')).toBe(
      fixtures.enTwoModeFullPrompt,
    );
  });

  it('never touches a prompt the user edited, even by one character', async () => {
    const edited = `${fixtures.enTwoModeFullPrompt}\nAlways sign my name.`;
    const storage = makeStorage({ 'customPrompt.cleanup': edited });
    expect(await sweepRetiredPromptOverrides(storage, ['cleanup'])).toEqual([]);
    expect(storage.getItem('customPrompt.cleanup')).toBe(edited);
    expect(storage.getItem('customPrompt.cleanup.retired')).toBeNull();
  });

  it('leaves a stored copy of the current default alone', async () => {
    const storage = makeStorage({ 'customPrompt.cleanup': DEFAULT_CLEANUP_PROMPT });
    expect(await sweepRetiredPromptOverrides(storage, ['cleanup'])).toEqual([]);
    expect(storage.getItem('customPrompt.cleanup')).toBe(DEFAULT_CLEANUP_PROMPT);
  });

  it('is idempotent across restarts', async () => {
    const storage = makeStorage({
      'customPrompt.cleanup': fixtures.enPreHardeningCleanupPrompt,
    });
    expect(await sweepRetiredPromptOverrides(storage, ['cleanup'])).toEqual(['cleanup']);
    expect(await sweepRetiredPromptOverrides(storage, ['cleanup'])).toEqual([]);
    expect(storage.getItem('customPrompt.cleanup.retired')).toBe(
      fixtures.enPreHardeningCleanupPrompt,
    );
  });

  it('skips removal when the value changes while hashing', async () => {
    const storage = makeStorage({ 'customPrompt.cleanup': fixtures.enTwoModeFullPrompt });
    const userSaved = 'My own prompt, saved mid-sweep.';
    let reads = 0;
    const racy: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
      getItem: (key) => {
        if (key === 'customPrompt.cleanup') {
          reads += 1;
          return reads === 1 ? fixtures.enTwoModeFullPrompt : userSaved;
        }
        return storage.getItem(key);
      },
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => storage.removeItem(key),
    };
    expect(await sweepRetiredPromptOverrides(racy, ['cleanup'])).toEqual([]);
    expect(storage.getItem('customPrompt.cleanup')).toBe(fixtures.enTwoModeFullPrompt);
    expect(storage.getItem('customPrompt.cleanup.retired')).toBeNull();
  });

  it('keeps sweeping the other kinds when one kind throws', async () => {
    const storage = makeStorage({
      'customPrompt.dictationAgent': fixtures.enTwoModeFullPrompt,
    });
    const failing: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
      getItem: (key) => {
        if (key === 'customPrompt.cleanup') throw new Error('storage unavailable');
        return storage.getItem(key);
      },
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => storage.removeItem(key),
    };
    expect(await sweepRetiredPromptOverrides(failing, ['cleanup', 'dictationAgent'])).toEqual([
      'dictationAgent',
    ]);
    expect(storage.getItem('customPrompt.dictationAgent.retired')).toBe(
      fixtures.enTwoModeFullPrompt,
    );
  });

  it('is a no-op on missing or empty overrides', async () => {
    const storage = makeStorage({ 'customPrompt.translate': '' });
    const kinds: readonly PromptKind[] = PROMPT_KIND_LIST;
    expect(await sweepRetiredPromptOverrides(storage, kinds)).toEqual([]);
    expect(storage.getItem('customPrompt.translate')).toBe('');
    expect(storage.keys().some((key) => key.endsWith('.retired'))).toBe(false);
  });
});
