import * as fs from 'fs';
import * as path from 'path';
import { DEBUG_LOG_KEYS } from '@/android/lib/debugLogKeys';
import {
  fieldValue,
  formatLine,
  newRunId,
  routeOf,
  safeError,
  textHash,
  wordCount,
} from '@/android/lib/debugLogFormat';
import { buildDebugLogHeader, type DebugLogSnapshot } from '@/android/lib/debugLogHeader';

const ROOT = path.resolve(__dirname, '../../../..');
const KOTLIN = path.join(
  ROOT,
  'modules/android-dictation/android/src/main/java/com/openwhispr/dictation/DebugLogFormat.kt',
);

// What a user might say, write or own: none of it may reach the log.
const SAMPLE = {
  transcript: 'Remind Priya the biopsy results come back Thursday',
  cleaned: 'Remind Priya: the biopsy results come back on Thursday.',
  dictionaryWord: 'Zylophrax',
  prompt: 'You are my secret negotiating assistant',
  fileName: 'therapy-session-03.m4a',
  email: 'saket.tester@example.com',
  token: 'sk-live-5d2f9a1b8c7e',
};

describe('debug log line format', () => {
  it('writes time, level, area, event and fields', () => {
    const line = formatLine(new Date(2026, 10, 27, 13, 45, 2, 118), 'I', 'mic', 'lock.taken', {
      run: 'd-7k2q',
      owner: 'bubble',
      rate: 16000,
      peak: 0.4123,
      ok: true,
      skipped: undefined,
    });
    expect(line).toMatch(
      /^2026-11-27T13:45:02\.118[+-]\d{4} I mic {4}lock\.taken run=d-7k2q owner=bubble rate=16000 peak=0\.41 ok=true$/,
    );
  });

  it('replaces a string under an unknown key with its length', () => {
    for (const [key, value] of Object.entries(SAMPLE)) {
      expect(DEBUG_LOG_KEYS.has(key)).toBe(false);
      const line = formatLine(new Date(), 'I', 'dict', 'x', { [key]: value });
      expect(line).not.toContain(value);
      expect(line).toContain(`${key}=<${value.length} chars>`);
    }
  });

  it('keeps known strings to one short line', () => {
    expect(fieldValue('model', `a\nb${'x'.repeat(200)}`)).not.toContain('\n');
    expect(fieldValue('model', 'x'.repeat(200)).length).toBeLessThanOrEqual(66);
    expect(fieldValue('error', 'e'.repeat(500)).length).toBeLessThanOrEqual(162);
    expect(fieldValue('reason', 'two words')).toBe('"two words"');
  });

  it('offers counts and hashes instead of text', () => {
    expect(wordCount(SAMPLE.transcript)).toBe(8);
    expect(textHash(SAMPLE.transcript)).toMatch(/^[0-9a-f]{8}$/);
    expect(textHash(SAMPLE.transcript)).toBe(textHash(SAMPLE.transcript));
    expect(newRunId('u')).toMatch(/^u-[0-9a-z]{4}$/);
    expect(safeError(new TypeError('boom'))).toBe('TypeError: boom');
  });

  it('drops query values and shortens opaque path parts from routes', () => {
    expect(routeOf(`https://api.openwhispr.com/api/notes/12?email=${SAMPLE.email}`)).toBe('/api/notes/12');
    expect(routeOf(`https://api.openwhispr.com/api/files/${'a'.repeat(64)}`)).toBe('/api/files/<64>');
  });

  it('uses the same key list as the native formatter', () => {
    const kotlin = fs.readFileSync(KOTLIN, 'utf8');
    const block = /debug-log-keys:start([\s\S]*?)debug-log-keys:end/.exec(kotlin)?.[1] ?? '';
    const native = new Set([...block.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]));
    expect([...native].sort()).toEqual([...DEBUG_LOG_KEYS].sort());
  });

  it('allows no key that names user content', () => {
    const content = /^(text|transcript|cleaned|original|prompt|selection|words?_list|note|title|body|email|name|file_?name|uri|url|token|key|cookie|word|snippet|snippets|trigger|words|history|screen)$/;
    expect([...DEBUG_LOG_KEYS].filter((key) => content.test(key))).toEqual([]);
  });
});

/** Every debug-log call in Android code, as `area event { fields }` source text. */
function logCalls(): { file: string; call: string }[] {
  const dirs = ['src/android', 'src/screens', 'src/services', 'modules/android-dictation', 'modules/live-pcm-streaming/src'];
  const out: { file: string; call: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === '__tests__' || entry.name === 'test') continue;
        walk(full);
      } else if (/\.(ts|tsx|kt)$/.test(entry.name)) {
        if (!/android|\.kt$/.test(full)) continue;
        const source = fs.readFileSync(full, 'utf8');
        const pattern = /(?:dlog\.(?:info|warn|error|failure)|debugLog|DebugLog\.event)\(([\s\S]*?)\)\s*;?\s*\n/g;
        for (const match of source.matchAll(pattern)) out.push({ file: path.relative(ROOT, full), call: match[1] });
      }
    }
  };
  for (const dir of dirs) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) walk(full);
  }
  return out;
}

describe('debug log calls in the code', () => {
  it('never pass text, a prompt, a selection, a name, an email or a key as a field value', () => {
    const risky =
      /\b(?:[a-z]+_)?(?:text|transcript|originalText|cleanedText|prompt|systemPrompt|selection|email|fileName|filename|apiKey|token|cookie|title|body|content|words)\s*(?:[,})]|$)/;
    const problems = logCalls()
      .filter(({ call }) => {
        // Look at what's passed as values: `key: value` and `"key" to value`.
        const values = [...call.matchAll(/(?::|\bto)\s*([A-Za-z_$][\w$.?!]*)\s*(?=[,})\n]|$)/g)].map((m) => m[1]);
        return values.some((value) => {
          const last = value.split(/[.?!]+/).filter(Boolean).pop() ?? '';
          return risky.test(`${last},`) && !/length$|Count$|count$|size$|chars$/.test(value);
        });
      })
      .map(({ file, call }) => `${file}: ${call.replace(/\s+/g, ' ').slice(0, 160)}`);
    expect(problems).toEqual([]);
  });
});

describe('debug log share header', () => {
  const snapshot: DebugLogSnapshot = {
    generatedAt: new Date('2026-11-27T11:52:00Z'),
    app: {
      version: '1.2.6',
      build: '61',
      packageName: 'com.gizmolabs.openwhispr',
      environment: 'production',
      apiBaseUrl: 'https://api.openwhispr.com',
    },
    device: { manufacturer: 'samsung', model: 'SM-A736B', release: '16', sdk: 36 },
    batteryOptimizationIgnored: false,
    permissions: { microphone: true, overlay: true, accessibility: true, notifications: false },
    account: { signedIn: true, plan: 'pro', workspaceIds: ['3f2a6c1e-0000-4000-8000-000000000001'] },
    defaultMode: 'cloud',
    scopes: [
      { scope: 'dictation', mode: 'openwhispr' },
      { scope: 'cleanup', mode: 'providers', provider: 'groq', model: 'llama-3.3-70b' },
    ],
    models: [{ id: 'parakeet-v3', ready: true }],
    services: { bubble: true, meeting: true },
    debugLogging: { on: true, since: Date.parse('2026-11-27T11:40:11Z'), onAtLaunch: false, processAgeMs: 600000 },
    microphone: { owner: 'meeting', module: 'm2', heldMs: 402115 },
  };

  it('names the app, phone, permissions, account, providers, models and the mic holder', () => {
    const header = buildDebugLogHeader(snapshot);
    expect(header).toContain('1.2.6 (61) com.gizmolabs.openwhispr production api=https://api.openwhispr.com');
    expect(header).toContain('samsung SM-A736B, Android 16 (API 36)');
    expect(header).toContain('ignoring=false');
    expect(header).toContain('mic=granted overlay=granted accessibility=on notifications=denied');
    expect(header).toContain('signed_in=true plan=pro workspace=3f2a6c1e-0000-4000-8000-000000000001');
    expect(header).toContain('cleanup=providers groq/llama-3.3-70b');
    expect(header).toContain('parakeet-v3 (ready)');
    expect(header).toContain('on since 2026-11-27T11:40:11.000Z');
    expect(header).toContain('on at this launch: no');
    expect(header).toContain('held by meeting, module m2, 402 s');
  });

  it('has no email and keeps every value to one line', () => {
    const header = buildDebugLogHeader({
      ...snapshot,
      device: { ...snapshot.device, model: `Pixel\n${SAMPLE.email}` },
    });
    expect(header.split('\n').every((line) => line.length < 400)).toBe(true);
    expect(header).not.toMatch(/\n[^\n]*@example\.com[^\n]*\n[^\n]*@/);
    expect(buildDebugLogHeader(snapshot)).not.toContain('@');
  });
});
