# Mobile BYOK Cut-Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship personal BYOK on iOS for the OpenAI-compatible providers only (OpenAI, Groq, OpenRouter, Custom) for dictation, uploads and text AI, and fix the routing, keyboard-handoff and text-AI regressions found in the 2026-09-22 review of `feat/mobile-byok`.

**Architecture:** One provider transport (the OpenAI-compatible batch and chat adapter over the native redirect-refusing URLSession) replaces the twelve-provider matrix. The shared `shared/ai` catalog stays intact; mobile filters it through an allowlist in one place. Live Meetings leave the Providers feature (the meeting service returns to its `origin/main` shape). Streaming-file transcription, the Tinfoil native module, and the provider-specific adapters are deleted, not disabled.

**Tech Stack:** Expo SDK 55 / React Native / TypeScript / Zustand / Jest in `openwhispr-mobile/`; Swift Expo modules in `openwhispr-mobile/modules/`; shared TypeScript in `shared/ai/`.

**Spec:** The review findings and the agreed cut are recorded in the conversation of 2026-09-22 and summarized in `openwhispr-mobile/docs/BYOK_SMOKE_TESTS.md` after Task 9. The original feature plan is `docs/superpowers/plans/2026-09-21-mobile-byok.md`; where the two disagree, this plan wins.

## Global Constraints

- Work in the existing worktree `/Users/chadpiha/Development/openWhispr/worktrees/mobile-byok` on branch `feat/mobile-byok`. Verify `git branch --show-current` prints `feat/mobile-byok` before editing.
- **Do not commit and do not push.** The user commits. Do not run `npm install`, do not touch `.env` files.
- Use Node 24 for every command: `source ~/.nvm/nvm.sh && nvm use 24`.
- Mobile commands run from `openwhispr-mobile/`: `npx jest --runInBand <pattern>`, `npm run typecheck`, `npm run lint`, `npm run format` (check only), `npm run format:write` (fix).
- Supported provider ids on mobile: exactly `openai`, `groq`, `openrouter`, `custom`. Supported scopes on mobile: `dictation`, `upload`, `cleanup`, `notes`, `agent`. `meeting` is not a Providers scope.
- Provider upload limit: 25 MB (`25 * 1024 * 1024` bytes), matching desktop `BYOK_FILE_SIZE_LIMIT` in `src/helpers/transcriptionRoute.ts`.
- Native provider request timeout: 300 seconds (the Swift transport clamps to 300).
- The mobile app has no i18n layer; user-facing strings are plain literals, as in the surrounding code.
- Every function gets an explicit return type. No `any`. No new abstractions beyond the ones named here.
- `shared/ai/**` is not modified by this plan. Desktop code under `src/` is not modified by this plan.
- After each task: the named jest suites pass, and `npm run typecheck` passes in `openwhispr-mobile/`.

---

### Task 1: Mobile provider allowlist and scope cut

**Files:**
- Create: `openwhispr-mobile/src/lib/mobileProviders.ts`
- Create: `openwhispr-mobile/src/lib/__tests__/mobileProviders.test.ts`
- Modify: `openwhispr-mobile/src/lib/inferenceRouting.ts`
- Modify: `openwhispr-mobile/src/lib/keyboardInferenceRoute.ts` (`decodeProviderRoute`, lines 15-50)
- Modify: `openwhispr-mobile/src/lib/cleanupTranscript.ts:104-113`
- Modify: `openwhispr-mobile/src/lib/transcribeAndCleanup.ts:383-388`
- Test: `openwhispr-mobile/src/lib/__tests__/inferenceRouting.test.ts`, `openwhispr-mobile/src/lib/__tests__/keyboardInferenceRoute.test.ts`

**Interfaces:**
- Produces: `MOBILE_PROVIDER_IDS: readonly string[]`, `MobileInferenceScope` type, `getMobileProvidersForScope(scope: MobileInferenceScope): ProviderDefinition[]`, `resolveMobileInferenceRoute(input): RouteResolution` (same input as shared `resolveInferenceRoute`). Later tasks import these from `@/lib/mobileProviders` (Task 3 ProviderExecution, Task 3 ProviderSettingsScreen).

- [ ] **Step 1: Write the failing allowlist tests**

```ts
// openwhispr-mobile/src/lib/__tests__/mobileProviders.test.ts
import {
  MOBILE_PROVIDER_IDS,
  getMobileProvidersForScope,
  resolveMobileInferenceRoute,
} from '../mobileProviders';

it('offers only the OpenAI-compatible providers for each scope', () => {
  expect(getMobileProvidersForScope('dictation').map((provider) => provider.id)).toEqual([
    'openai',
    'groq',
    'custom',
  ]);
  expect(getMobileProvidersForScope('upload').map((provider) => provider.id)).toEqual([
    'openai',
    'groq',
    'custom',
  ]);
  expect(getMobileProvidersForScope('cleanup').map((provider) => provider.id)).toEqual([
    'openai',
    'groq',
    'openrouter',
    'custom',
  ]);
  expect(MOBILE_PROVIDER_IDS).toEqual(['openai', 'groq', 'openrouter', 'custom']);
});

it('refuses providers outside the mobile allowlist even when the shared catalog knows them', () => {
  expect(
    resolveMobileInferenceRoute({
      scope: 'dictation',
      selection: {
        mode: 'providers',
        providerId: 'xai',
        modelId: 'grok-stt',
        credentialRef: 'provider.xai',
      },
      policy: { status: 'unmanaged' },
    }),
  ).toEqual({ ok: false, code: 'PROVIDER_UNSUPPORTED' });
});

it('refuses the meeting scope for providers', () => {
  expect(
    resolveMobileInferenceRoute({
      scope: 'meeting',
      selection: {
        mode: 'providers',
        providerId: 'openai',
        modelId: 'gpt-4o-transcribe',
        credentialRef: 'provider.openai',
      },
      policy: { status: 'unmanaged' },
    }),
  ).toEqual({ ok: false, code: 'PROVIDER_UNSUPPORTED' });
});

it('delegates supported selections to the shared resolver unchanged', () => {
  const result = resolveMobileInferenceRoute({
    scope: 'upload',
    selection: {
      mode: 'providers',
      providerId: 'groq',
      modelId: 'whisper-large-v3-turbo',
      credentialRef: 'provider.groq',
    },
    policy: { status: 'unmanaged' },
  });
  expect(result).toMatchObject({
    ok: true,
    route: { providerId: 'groq', endpoint: 'https://api.groq.com/openai/v1' },
  });
  expect(
    resolveMobileInferenceRoute({
      scope: 'meeting',
      selection: { mode: 'openwhispr' },
      policy: { status: 'unmanaged' },
    }),
  ).toEqual({ ok: true, route: { mode: 'openwhispr', scope: 'meeting' } });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `openwhispr-mobile/`): `npx jest --runInBand src/lib/__tests__/mobileProviders.test.ts`
Expected: FAIL with "Cannot find module '../mobileProviders'".

- [ ] **Step 3: Create the allowlist module**

```ts
// openwhispr-mobile/src/lib/mobileProviders.ts
import {
  getProvidersForScope,
  resolveInferenceRoute,
  type InferenceScope,
  type ProviderDefinition,
  type RouteResolution,
} from '@shared/ai/routing';

// The iOS-first release ships the single OpenAI-compatible transport. Other
// catalog providers need their own adapters and device verification first.
export const MOBILE_PROVIDER_IDS: readonly string[] = ['openai', 'groq', 'openrouter', 'custom'];

export type MobileInferenceScope = Exclude<InferenceScope, 'meeting'>;

export function getMobileProvidersForScope(scope: MobileInferenceScope): ProviderDefinition[] {
  return getProvidersForScope(scope).filter((provider) =>
    MOBILE_PROVIDER_IDS.includes(provider.id),
  );
}

export function resolveMobileInferenceRoute(
  input: Parameters<typeof resolveInferenceRoute>[0],
): RouteResolution {
  const { scope, selection } = input;
  if (
    selection.mode === 'providers' &&
    (scope === 'meeting' || !MOBILE_PROVIDER_IDS.includes(selection.providerId ?? ''))
  ) {
    return { ok: false, code: 'PROVIDER_UNSUPPORTED' };
  }
  return resolveInferenceRoute(input);
}
```

- [ ] **Step 4: Run the allowlist tests**

Run: `npx jest --runInBand src/lib/__tests__/mobileProviders.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing routing tests**

Append to `openwhispr-mobile/src/lib/__tests__/inferenceRouting.test.ts`:

```ts
it('refuses a persisted selection for a provider the mobile build does not ship', async () => {
  mockGetPolicy.mockResolvedValue({ status: 'unmanaged' });
  await expect(
    resolveMobileProviderRoute('dictation', {
      mode: 'providers',
      providerId: 'deepgram',
      modelId: 'nova-3',
      credentialRef: 'provider.deepgram',
    }),
  ).rejects.toThrow('This provider does not support the selected workflow.');
});

it('marks text stages unavailable for an unsupported provider instead of falling back', () => {
  mockProcessing.activeMode = 'cloud';
  mockState.config.inference = {
    dictation: {
      mode: 'providers',
      providerId: 'groq',
      modelId: 'whisper-large-v3-turbo',
      credentialRef: 'provider.groq',
    },
    cleanup: {
      mode: 'providers',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      credentialRef: 'provider.anthropic',
    },
  };
  const snapshot = snapshotTranscriptionJob('dictation');
  expect(snapshot.cleanupRoute).toBeUndefined();
  expect(snapshot.cleanupUnavailable).toBe(
    'Complete cleanup provider setup in AI Models. Your raw transcript is saved.',
  );
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx jest --runInBand src/lib/__tests__/inferenceRouting.test.ts`
Expected: FAIL — the first new test resolves a deepgram route; the second gets a `cleanupRoute`.

- [ ] **Step 7: Route every mobile resolution through the allowlist**

In `openwhispr-mobile/src/lib/inferenceRouting.ts`:

1. Replace the `@shared/ai/routing` import block with:

```ts
import type {
  InferenceScope,
  InferenceSelection,
  InferenceRoute,
  RouteErrorCode,
} from '@shared/ai/routing';
import { resolveMobileInferenceRoute } from '@/lib/mobileProviders';
```

2. In `resolveMobileProviderRoute`, replace `const result = resolveInferenceRoute({` with `const result = resolveMobileInferenceRoute({` and type the message map as `const messages: Record<RouteErrorCode, string> = {` (same entries).
3. In `snapshotTextInference`, replace `resolveInferenceRoute({ scope, selection, policy: { status: 'unmanaged' } })` with `resolveMobileInferenceRoute({ scope, selection, policy: { status: 'unmanaged' } })`.
4. In `snapshotTranscriptionJob`, replace `const result = resolveInferenceRoute({` with `const result = resolveMobileInferenceRoute({`.

In `openwhispr-mobile/src/lib/keyboardInferenceRoute.ts`:

1. Replace `import { resolveInferenceRoute, type InferenceSelection } from '@shared/ai/routing';` with `import type { InferenceSelection } from '@shared/ai/routing';` and add `import { resolveMobileInferenceRoute } from '@/lib/mobileProviders';`.
2. In `decodeProviderRoute`, delete the two `if (fields.cortiEnvironment !== undefined) {...}` and `if (fields.cortiTenant !== undefined) {...}` blocks, and replace `const result = resolveInferenceRoute({` with `const result = resolveMobileInferenceRoute({`.

In `openwhispr-mobile/src/lib/cleanupTranscript.ts`: replace the `resolveInferenceRoute` import from `@shared/ai/routing` with `import { resolveMobileInferenceRoute } from '@/lib/mobileProviders';` and change the call at line 104 to `resolveMobileInferenceRoute({`.

In `openwhispr-mobile/src/lib/transcribeAndCleanup.ts` replace lines 383-388:

```ts
  if (request.provider === 'byok' && !request.inferenceRoute) {
    throw new Error('The original provider route is unavailable. Start a new transcription.');
  }
```

If `resolveMobileProviderRoute` is now unused in that file, remove it from its import.

Run `grep -rn "resolveInferenceRoute(" openwhispr-mobile/src --include='*.ts' --include='*.tsx' | grep -v __tests__` — the only remaining hit must be `ProviderSettingsScreen.tsx` (handled in Task 3).

- [ ] **Step 8: Replace the Corti keyboard-route test**

In `openwhispr-mobile/src/lib/__tests__/keyboardInferenceRoute.test.ts`, replace the whole test `preserves Corti region and tenant in original job metadata` (lines 155-177) with:

```ts
it('refuses a stored route for a provider the mobile build no longer ships', () => {
  const route = {
    provider: 'byok',
    inferenceRoute: {
      mode: 'providers',
      scope: 'dictation',
      providerId: 'corti',
      modelId: 'corti-transcribe',
      endpoint: 'https://api.eu.corti.app/v2',
      credentialRef: 'provider.corti',
    },
  };
  AppGroupStorage.setItem(
    'keyboard_upload_route.corti',
    JSON.stringify({ version: 1, jobId: 'corti', route }),
  );
  expect(() => readKeyboardInferenceRoute('corti')).toThrow(
    'The original keyboard provider route is unavailable. Record again.',
  );
});
```

(Keep whatever `AppGroupStorage` mock/import the file already uses for the other tests.)

- [ ] **Step 9: Run the routing suites**

Run: `npx jest --runInBand src/lib/__tests__/inferenceRouting.test.ts src/lib/__tests__/keyboardInferenceRoute.test.ts src/lib/__tests__/mobileProviders.test.ts src/lib/__tests__/cleanupTranscript src/lib/__tests__/transcribeAndCleanup`
Expected: PASS. Then `npm run typecheck` — expect errors only in files Tasks 2-3 delete or rewrite (`ProviderExecution.ts`, `RealtimeProviderProtocol.ts`, `StreamingFileTranscription.ts`, `ProviderSettingsScreen.tsx`); note them and continue.

---

### Task 2: Revert live-meeting BYOK and delete the streaming and Tinfoil stacks

**Files:**
- Restore from `origin/main`: `openwhispr-mobile/src/services/transcription/RealtimeMeetingWsService.ts`, `openwhispr-mobile/src/services/transcription/__tests__/RealtimeMeetingWsService.test.ts`, `openwhispr-mobile/src/hooks/useCloudMeeting.ts`, `openwhispr-mobile/src/screens/MeetingRecordScreen.tsx`
- Delete: `openwhispr-mobile/src/services/transcription/RealtimeProviderProtocol.ts`, `openwhispr-mobile/src/services/transcription/__tests__/RealtimeProviderProtocol.test.ts`, `openwhispr-mobile/src/services/transcription/StreamingFileTranscription.ts`, `openwhispr-mobile/src/services/transcription/__tests__/StreamingFileTranscription.test.ts`, `openwhispr-mobile/modules/tinfoil-transport/` (whole directory), `openwhispr-mobile/plugins/tinfoil-transport/` (whole directory)
- Modify: `openwhispr-mobile/app.base.json` (plugins array), `openwhispr-mobile/src/services/transcription/TranscriptionService.ts:961-1028` (the `case 'byok'` block), `openwhispr-mobile/src/services/transcription/__tests__/TranscriptionService.byok.test.ts`

**Interfaces:**
- Consumes: `resolveMobileProviderRoute` from Task 1.
- Produces: `transcribeWithProvider` is called with a new optional `prompt?: string` (Task 3 adds the field to `ProviderTranscriptionInput`).

- [ ] **Step 1: Restore the meeting path and delete the stacks**

Run from the worktree root:

```bash
git checkout origin/main -- openwhispr-mobile/src/services/transcription/RealtimeMeetingWsService.ts openwhispr-mobile/src/services/transcription/__tests__/RealtimeMeetingWsService.test.ts openwhispr-mobile/src/hooks/useCloudMeeting.ts openwhispr-mobile/src/screens/MeetingRecordScreen.tsx
git rm -q openwhispr-mobile/src/services/transcription/RealtimeProviderProtocol.ts openwhispr-mobile/src/services/transcription/__tests__/RealtimeProviderProtocol.test.ts openwhispr-mobile/src/services/transcription/StreamingFileTranscription.ts openwhispr-mobile/src/services/transcription/__tests__/StreamingFileTranscription.test.ts
git rm -rq openwhispr-mobile/modules/tinfoil-transport openwhispr-mobile/plugins/tinfoil-transport
```

In `openwhispr-mobile/app.base.json` delete the line `"./plugins/tinfoil-transport/withTinfoilTransport",`. Keep `"./plugins/provider-networking/withProviderNetworking",`.

- [ ] **Step 2: Rewrite the BYOK transcription test for batch-only providers**

Replace the whole of `openwhispr-mobile/src/services/transcription/__tests__/TranscriptionService.byok.test.ts` with:

```ts
import * as FileSystem from 'expo-file-system/legacy';
import { BackgroundUploader } from '../../../../modules/background-uploader/src';
import { transcribeWithProvider } from '@/services/providers/ProviderExecution';
import { TranscriptionService } from '../TranscriptionService';
import type { TranscriptionRequest } from '../../../types';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.2.1' } },
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ sessionCookie: 'test-session-cookie' }) },
}));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(),
  uploadAsync: jest.fn(),
  FileSystemUploadType: { MULTIPART: 1 },
  FileSystemSessionType: { FOREGROUND: 0 },
}));
jest.mock('../LocalWhisperService', () => ({ LocalWhisperService: {} }));
jest.mock('../LocalTranscriptionService', () => ({ LocalTranscriptionService: {} }));
const mockHints = jest.fn((): string[] => []);
jest.mock('@/lib/dictationHints', () => ({
  buildDictationHints: () => mockHints(),
  isDictationContext: () => true,
}));
jest.mock('@/lib/cleanupTranscript', () => ({ CLEANUP_TIMEOUT_MS: 30000 }));
jest.mock('../../../../modules/background-uploader/src', () => ({
  BackgroundUploader: { isAvailable: () => true, upload: jest.fn() },
}));
jest.mock('../../../../modules/audio-tools/src', () => ({
  AudioTools: { isAvailable: () => true, splitToChunks: jest.fn(), cleanup: jest.fn() },
}));
jest.mock('../../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { setItem: jest.fn() },
  APP_GROUP_KEYS: {},
}));

const mockProviderRoute = {
  mode: 'providers',
  scope: 'dictation',
  providerId: 'groq',
  modelId: 'whisper-large-v3-turbo',
  endpoint: 'https://api.groq.com/openai/v1',
  credentialRef: 'provider.groq',
} as const;
let mockResolvedProviderRoute: NonNullable<TranscriptionRequest['inferenceRoute']> =
  mockProviderRoute;

const mockCleanupRoute = {
  mode: 'providers',
  scope: 'cleanup',
  providerId: 'openai',
  modelId: 'gpt-4o-mini',
  endpoint: 'https://api.openai.com/v1',
  credentialRef: 'provider.openai',
} as const;

jest.mock('@/lib/inferenceRouting', () => ({
  resolveMobileProviderRoute: jest.fn(async () => mockResolvedProviderRoute),
  getInferenceSelection: () => undefined,
}));
jest.mock(
  '@/services/providers/ProviderExecution',
  () => ({
    transcribeWithProvider: jest.fn(async () => ({
      text: 'Direct provider transcript',
      duration: 2,
    })),
  }),
  { virtual: true },
);

const mockTranscribeWithProvider = transcribeWithProvider as jest.MockedFunction<
  typeof transcribeWithProvider
>;

beforeEach(() => {
  jest.clearAllMocks();
  mockHints.mockReturnValue([]);
  mockResolvedProviderRoute = mockProviderRoute;
});

test('BYOK returns provider metadata without an OpenWhispr session or upload', async (): Promise<void> => {
  const response = await TranscriptionService.transcribe({
    audioUri: 'file:///recording.wav',
    provider: 'byok',
    requestContext: 'recording',
    inferenceRoute: mockProviderRoute,
  });

  expect(response).toMatchObject({
    text: 'Direct provider transcript',
    provider: 'byok',
    inferenceRoute: mockProviderRoute,
  });
  expect(BackgroundUploader.upload).not.toHaveBeenCalled();
  expect(FileSystem.uploadAsync).not.toHaveBeenCalled();
});

test('BYOK recovery snapshot preserves the pinned text stages and client job ID', async (): Promise<void> => {
  await TranscriptionService.transcribe({
    audioUri: 'file:///recording.wav',
    provider: 'byok',
    requestContext: 'keyboard',
    clientTranscriptionId: 'client-job-42',
    inferenceRoute: mockProviderRoute,
    cleanupRoute: mockCleanupRoute,
    agentRoute: mockCleanupRoute,
    cleanupUnavailable: 'cleanup unavailable',
    agentUnavailable: 'agent unavailable',
  });

  const providerInput = mockTranscribeWithProvider.mock.calls[0]?.[0];
  expect(providerInput?.jobId).toBe('client-job-42');
  expect(JSON.parse(providerInput?.routeSnapshot ?? '')).toEqual({
    version: 1,
    jobId: 'client-job-42',
    requestContext: 'keyboard',
    route: {
      provider: 'byok',
      inferenceRoute: mockProviderRoute,
      cleanupRoute: mockCleanupRoute,
      agentRoute: mockCleanupRoute,
      cleanupUnavailable: 'cleanup unavailable',
      agentUnavailable: 'agent unavailable',
    },
  });
});

test('BYOK sends the custom dictionary as the transcription prompt', async (): Promise<void> => {
  mockHints.mockReturnValue(['OpenWhispr', 'Gizmo']);
  await TranscriptionService.transcribe({
    audioUri: 'file:///recording.wav',
    provider: 'byok',
    requestContext: 'recording',
    inferenceRoute: mockProviderRoute,
  });
  expect(mockTranscribeWithProvider).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: 'OpenWhispr, Gizmo' }),
  );
});

test('BYOK omits the prompt when the dictionary is empty', async (): Promise<void> => {
  await TranscriptionService.transcribe({
    audioUri: 'file:///recording.wav',
    provider: 'byok',
    requestContext: 'recording',
    inferenceRoute: mockProviderRoute,
  });
  expect(mockTranscribeWithProvider.mock.calls[0]?.[0]?.prompt).toBeUndefined();
});
```

- [ ] **Step 3: Run to verify the prompt tests fail**

Run: `npx jest --runInBand src/services/transcription/__tests__/TranscriptionService.byok.test.ts`
Expected: the two prompt tests FAIL (no `prompt` passed); the first two pass.

- [ ] **Step 4: Cut the streaming branch out of TranscriptionService**

Replace the whole `case 'byok': { ... }` block in `openwhispr-mobile/src/services/transcription/TranscriptionService.ts` (currently lines 961-1028) with:

```ts
      case 'byok': {
        const { resolveMobileProviderRoute } =
          require('@/lib/inferenceRouting') as typeof import('@/lib/inferenceRouting');
        const { transcribeWithProvider } =
          require('@/services/providers/ProviderExecution') as typeof import('@/services/providers/ProviderExecution');
        const scope = request.requestContext === 'file' ? 'upload' : 'dictation';
        const route = await resolveMobileProviderRoute(scope, request.inferenceRoute);
        const recoveryJobId = request.jobId ?? request.clientTranscriptionId;
        const routeSnapshot = recoveryJobId
          ? JSON.stringify({
              version: 1,
              jobId: recoveryJobId,
              requestContext: request.requestContext,
              route: {
                provider: 'byok',
                inferenceRoute: route,
                cleanupRoute: request.cleanupRoute,
                agentRoute: request.agentRoute,
                cleanupUnavailable: request.cleanupUnavailable,
                agentUnavailable: request.agentUnavailable,
              },
            })
          : undefined;
        const promptHints = buildDictationHints(isDictationContext(request.requestContext));
        const result = await transcribeWithProvider({
          route,
          audioUri,
          fileName: request.fileName,
          mimeType: request.mimeType,
          language,
          prompt: promptHints.length > 0 ? promptHints.join(', ') : undefined,
          routeSnapshot,
          jobId: recoveryJobId,
        });
        return { ...result, provider: 'byok', inferenceRoute: route, endpoint: route.providerId };
      }
```

`buildDictationHints` and `isDictationContext` are already imported at line 14. If `AppGroupStorage` is no longer referenced anywhere in the file, remove its import (lint will report it).

- [ ] **Step 5: Run the transcription and meeting suites**

Run: `npx jest --runInBand src/services/transcription src/hooks/__tests__/useCloudMeeting src/screens/__tests__/MeetingRecordScreen`
Expected: PASS (the byok prompt tests still fail typecheck until Task 3 adds `prompt` to the input type; jest with babel does not typecheck, so they pass here). Confirm `git status --short` shows the four restored files as unmodified relative to `origin/main`: `git diff origin/main --stat -- openwhispr-mobile/src/services/transcription/RealtimeMeetingWsService.ts openwhispr-mobile/src/hooks/useCloudMeeting.ts openwhispr-mobile/src/screens/MeetingRecordScreen.tsx` prints nothing.

---

### Task 3: Trim ProviderExecution to the OpenAI-compatible adapter, simplify credentials, trim the settings screen

**Files:**
- Rewrite: `openwhispr-mobile/src/services/providers/ProviderExecution.ts`
- Modify: `openwhispr-mobile/src/services/providers/__tests__/ProviderExecution.test.ts`
- Modify: `openwhispr-mobile/src/services/providers/ProviderCredentials.ts:5-9` (`ProviderCredential`) and `:81-98` (`parseCredential`)
- Modify: `openwhispr-mobile/src/services/providers/__tests__/ProviderCredentials.test.ts:56-73` and `:228`
- Modify: `openwhispr-mobile/src/screens/ProviderSettingsScreen.tsx`
- Modify: `openwhispr-mobile/src/screens/__tests__/ProviderSettingsScreen.test.tsx:145-163`

**Interfaces:**
- Consumes: `MOBILE_PROVIDER_IDS`, `getMobileProvidersForScope`, `resolveMobileInferenceRoute`, `MobileInferenceScope` (Task 1).
- Produces: `ProviderTranscriptionInput.prompt?: string`; `ProviderExecutionDependencies { getCredential, fileSize, request, requestFile }` (no `readAudio`, no `requestAttested`; `requestFile` required); `PROVIDER_AUDIO_LIMIT_BYTES`; error codes `AUDIO_TOO_LARGE`, `PROVIDER_QUOTA_EXCEEDED`, `MODEL_NOT_FOUND`; `ProviderCredential = { apiKey: string }`.

- [ ] **Step 1: Write the failing ProviderExecution tests**

In `openwhispr-mobile/src/services/providers/__tests__/ProviderExecution.test.ts`:

1. Delete these tests entirely: `Anthropic and Gemini use their native protocols` (line 111), `xAI omits model and Mistral uses x-api-key` (225), `Gemini embeds audio in an Interactions request and accepts step fallback text` (261), `Tinfoil rejects plain HTTPS before credentials or audio are accessed` (322), `Tinfoil uses only attested transport for inference and never regular HTTP` (490).
2. Replace `makeDependencies` with:

```ts
type FileRequest = Parameters<ProviderExecutionDependencies['requestFile']>[0];

function makeDependencies(
  responses: Response[],
  requests: Array<{ url: string; init: RequestInit }>,
  fileRequests: FileRequest[] = [],
  fileSize = 1024,
): ProviderExecutionDependencies {
  const next = (): Response => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request');
    return response;
  };
  return {
    getCredential: async () => ({ apiKey: 'fixture-key' }),
    fileSize: async () => fileSize,
    request: async (url, init) => {
      requests.push({ url, init });
      return next();
    },
    requestFile: async (input) => {
      fileRequests.push(input);
      return next();
    },
  };
}
```

3. Update the remaining batch-transcription test in the `ProviderExecution batch transcription adapters` describe (line 190) so it reads `fileRequests[0]` instead of a `FormData` body: assert `fileRequests[0].url === 'https://api.groq.com/openai/v1/audio/transcriptions'`, `fileRequests[0].parameters` equals `{ model: <modelId>, language: <language> }` (whatever that test already passes), and `fileRequests[0].headers.Authorization === 'Bearer fixture-key'`. Keep its result assertion.
4. Add these tests at the end of the same describe:

```ts
  test('refuses a provider outside the mobile allowlist before touching credentials', async () => {
    const getCredential = jest.fn();
    const execution = createProviderExecution({
      ...makeDependencies([], []),
      getCredential,
    });
    await expect(
      execution.transcribeWithProvider({
        route: route({ providerId: 'xai', endpoint: 'https://api.x.ai/v1', scope: 'dictation' }),
        audioUri: 'file:///audio.m4a',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
    await expect(
      execution.processProviderText({
        route: route({ providerId: 'anthropic', endpoint: 'https://api.anthropic.com/v1' }),
        text: 'hi',
        systemPrompt: 'test',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
    expect(getCredential).not.toHaveBeenCalled();
  });

  test('refuses audio over the provider limit before uploading', async () => {
    const fileRequests: FileRequest[] = [];
    const execution = createProviderExecution(
      makeDependencies([], [], fileRequests, 25 * 1024 * 1024 + 1),
    );
    await expect(
      execution.transcribeWithProvider({
        route: route({ scope: 'dictation' }),
        audioUri: 'file:///audio.m4a',
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE' });
    expect(fileRequests).toHaveLength(0);
  });

  test('sends the dictionary prompt and omits it when absent', async () => {
    const fileRequests: FileRequest[] = [];
    const execution = createProviderExecution(
      makeDependencies(
        [jsonResponse({ text: 'a' }), jsonResponse({ text: 'b' })],
        [],
        fileRequests,
      ),
    );
    await execution.transcribeWithProvider({
      route: route({ scope: 'dictation' }),
      audioUri: 'file:///audio.m4a',
      prompt: 'OpenWhispr, Gizmo',
    });
    await execution.transcribeWithProvider({
      route: route({ scope: 'dictation' }),
      audioUri: 'file:///audio.m4a',
    });
    expect(fileRequests[0]?.parameters.prompt).toBe('OpenWhispr, Gizmo');
    expect(fileRequests[1]?.parameters.prompt).toBeUndefined();
  });

  test('a redirect returned by the native transport is reported as blocked', async () => {
    const execution = createProviderExecution(
      makeDependencies(
        [new Response('', { status: 307, headers: { Location: 'https://elsewhere.example' } })],
        [],
      ),
    );
    await expect(
      execution.transcribeWithProvider({
        route: route({ scope: 'dictation' }),
        audioUri: 'file:///audio.m4a',
      }),
    ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
  });

  test('maps quota and missing-model statuses to actionable codes', async () => {
    const execution = createProviderExecution(
      makeDependencies([jsonResponse({}, 402), jsonResponse({}, 404)], []),
    );
    await expect(
      execution.processProviderText({ route: route(), text: 'hi', systemPrompt: 'test' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_QUOTA_EXCEEDED' });
    await expect(
      execution.processProviderText({ route: route(), text: 'hi', systemPrompt: 'test' }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest --runInBand src/services/providers/__tests__/ProviderExecution.test.ts`
Expected: FAIL (type/shape mismatches: `readAudio` required, `fileSize` unknown, new codes missing).

- [ ] **Step 3: Rewrite ProviderExecution.ts**

Replace the whole file with:

```ts
import * as FileSystem from 'expo-file-system/legacy';
import { createProviderCredentialScope } from './ProviderCredentialScope';
import type { InferenceRoute } from '@shared/ai/routing';
import { isTranscriptionScope } from '@shared/ai/routing';
import { buildApiUrl, isSecureHttpEndpoint, normalizeBaseUrl } from '@shared/ai/endpoints';
import modelCatalog from '@shared/ai/modelRegistryData.json';
import { MOBILE_PROVIDER_IDS } from '@/lib/mobileProviders';
import {
  getProviderCredential,
  getProviderCredentialReference,
  type ProviderCredential,
} from './ProviderCredentials';
import { requestProviderFileNative, requestProviderNative } from './NativeProviderTransport';

type ProviderRoute = Extract<InferenceRoute, { mode: 'providers' }>;

export const PROVIDER_AUDIO_LIMIT_BYTES = 25 * 1024 * 1024;

export interface ProviderTextInput {
  route: ProviderRoute;
  text: string;
  systemPrompt: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderTranscriptionInput {
  route: ProviderRoute;
  audioUri: string;
  fileName?: string;
  mimeType?: string;
  language?: string;
  prompt?: string;
  routeSnapshot?: string;
  jobId?: string;
  signal?: AbortSignal;
}

export interface ProviderFileRequest {
  url: string;
  fileUri: string;
  fileFieldName: string;
  fileMimeType: string;
  fileName: string;
  parameters: Record<string, string>;
  headers: Record<string, string>;
  routeSnapshot?: string;
  recoveryAudioUri?: string;
  signal?: AbortSignal;
}

export interface ProviderExecutionDependencies {
  getCredential(reference: string): Promise<ProviderCredential | null>;
  fileSize(uri: string): Promise<number | undefined>;
  request(
    url: string,
    init: RequestInit,
    recovery?: { routeSnapshot?: string; recoveryAudioUri?: string },
  ): Promise<Response>;
  requestFile(input: ProviderFileRequest): Promise<Response>;
}

export interface ProviderExecution {
  processProviderText(input: ProviderTextInput): Promise<{ text: string; model: string }>;
  transcribeWithProvider(
    input: ProviderTranscriptionInput,
  ): Promise<{ text: string; duration: number }>;
  discoverProviderModels(input: ProviderSetupInput): Promise<ProviderModelDiscovery>;
  testProviderConnection(input: ProviderSetupInput): Promise<ProviderConnectionResult>;
}

export interface ProviderSetupInput {
  route: ProviderRoute;
  signal?: AbortSignal;
}

export interface ProviderModelDiscovery {
  models: Array<{ id: string; name: string }>;
  verification: 'catalog-only';
}

export interface ProviderConnectionResult {
  ok: true;
  verification: 'inference' | 'catalog-only';
  providerId: string;
  modelId: string;
  scope: ProviderRoute['scope'];
}

export class ProviderExecutionError extends Error {
  public readonly code: string;
  public readonly status?: number;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'ProviderExecutionError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

function errorForStatus(providerId: string, status: number): ProviderExecutionError {
  if (status === 401 || status === 403) {
    return new ProviderExecutionError(
      'INVALID_CREDENTIAL',
      `${providerId} rejected the configured credential.`,
      { status },
    );
  }
  if (status === 402) {
    return new ProviderExecutionError(
      'PROVIDER_QUOTA_EXCEEDED',
      `${providerId} reports a billing or quota problem for this key.`,
      { status },
    );
  }
  if (status === 404) {
    return new ProviderExecutionError(
      'MODEL_NOT_FOUND',
      `${providerId} did not find the selected model or endpoint.`,
      { status },
    );
  }
  if (status === 429) {
    return new ProviderExecutionError(
      'PROVIDER_RATE_LIMITED',
      `${providerId} is rate limited. Try again later.`,
      { status },
    );
  }
  if (status >= 500) {
    return new ProviderExecutionError(
      'PROVIDER_UNAVAILABLE',
      `${providerId} is temporarily unavailable.`,
      { status, retryable: true },
    );
  }
  return new ProviderExecutionError(
    'PROVIDER_REQUEST_FAILED',
    `${providerId} rejected the request (${status}).`,
    { status },
  );
}

function assertSupportedProvider(route: ProviderRoute): void {
  if (!MOBILE_PROVIDER_IDS.includes(route.providerId)) {
    throw new ProviderExecutionError(
      'PROVIDER_UNSUPPORTED',
      `${route.providerId} is not available on this device.`,
    );
  }
}

function assertEndpoint(route: ProviderRoute): string {
  const endpoint = normalizeBaseUrl(route.endpoint);
  if (!endpoint || !isSecureHttpEndpoint(endpoint)) {
    throw new ProviderExecutionError('ENDPOINT_INVALID', 'The provider endpoint is invalid.');
  }
  const parsed = new URL(endpoint);
  if (parsed.username || parsed.password || parsed.hash) {
    throw new ProviderExecutionError('ENDPOINT_INVALID', 'The provider endpoint is invalid.');
  }
  return endpoint;
}

async function apiKeyForRoute(
  route: ProviderRoute,
  getCredential: ProviderExecutionDependencies['getCredential'],
): Promise<string | null> {
  if (!route.credentialRef) {
    if (route.providerId === 'custom') return null;
    throw new ProviderExecutionError(
      'CREDENTIAL_MISSING',
      `Configure credentials for ${route.providerId}.`,
    );
  }
  const expectedReference = await getProviderCredentialReference(route.providerId, route.endpoint);
  if (route.credentialRef !== expectedReference) {
    throw new ProviderExecutionError(
      'CREDENTIAL_MISMATCH',
      'The credential does not belong to this provider endpoint.',
    );
  }
  const credential = await getCredential(route.credentialRef);
  if (!credential) {
    throw new ProviderExecutionError(
      'CREDENTIAL_MISSING',
      `Configure credentials for ${route.providerId}.`,
    );
  }
  return credential.apiKey;
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function checkResponse(route: ProviderRoute, requestUrl: string, response: Response): Response {
  const requestOrigin = new URL(requestUrl).origin;
  const responseOrigin = response.url ? new URL(response.url).origin : requestOrigin;
  if (
    response.redirected ||
    (response.status >= 300 && response.status < 400) ||
    responseOrigin !== requestOrigin
  ) {
    throw new ProviderExecutionError(
      'REDIRECT_BLOCKED',
      'The provider redirected the request to another endpoint.',
    );
  }
  if (!response.ok) throw errorForStatus(route.providerId, response.status);
  return response;
}

async function safeRequest(
  dependencies: ProviderExecutionDependencies,
  route: ProviderRoute,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await dependencies.request(url, { ...init, redirect: 'manual' });
  } catch (error) {
    throw normalizeTransportFailure(error, route.providerId);
  }
  return checkResponse(route, url, response);
}

function normalizeTransportFailure(error: unknown, providerId: string): Error {
  if (error instanceof ProviderExecutionError) return error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  const nativeCode = objectValue(error)?.code;
  if (nativeCode === 'PROVIDER_CANCELLED') return new DOMException('Aborted', 'AbortError');
  if (nativeCode === 'PROVIDER_LOCAL_NETWORK_ERROR') {
    return new ProviderExecutionError(
      'PROVIDER_LOCAL_NETWORK_ERROR',
      'Check Local Network permission and the server address.',
    );
  }
  if (nativeCode === 'PROVIDER_INVALID_URL' || nativeCode === 'PROVIDER_INVALID_REQUEST') {
    return new ProviderExecutionError('ENDPOINT_INVALID', 'The provider endpoint is invalid.');
  }
  return new ProviderExecutionError('PROVIDER_NETWORK_ERROR', `Unable to reach ${providerId}.`, {
    retryable: true,
  });
}

async function parseJson(response: Response, providerId: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderExecutionError(
      'PROVIDER_RESPONSE_INVALID',
      `${providerId} returned an invalid response.`,
    );
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireText(text: string | null, providerId: string): string {
  if (text) return text;
  throw new ProviderExecutionError(
    'PROVIDER_RESPONSE_INVALID',
    `${providerId} returned an empty or malformed response.`,
  );
}

function catalogModelConfig(
  providerId: string,
  modelId: string,
): { supportsTemperature: boolean; tokenParam: string } {
  const providers = modelCatalog.cloudProviders as Array<{
    id: string;
    models: Array<{ id: string; supportsTemperature?: boolean; tokenParam?: string }>;
  }>;
  const model = providers
    .find((provider) => provider.id === providerId)
    ?.models.find((candidate) => candidate.id === modelId);
  return {
    supportsTemperature: model?.supportsTemperature ?? true,
    tokenParam: model?.tokenParam ?? 'max_tokens',
  };
}

function responseTextFromChat(payload: unknown): string | null {
  const choices = objectValue(payload)?.choices;
  if (!Array.isArray(choices)) return null;
  return nonEmptyText(objectValue(objectValue(choices[0])?.message)?.content);
}

function transcriptionDuration(payload: unknown): number {
  const duration = objectValue(payload)?.duration;
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

async function processText(
  dependencies: ProviderExecutionDependencies,
  input: ProviderTextInput,
): Promise<{ text: string; model: string }> {
  const { route } = input;
  assertSupportedProvider(route);
  const endpoint = assertEndpoint(route);
  const apiKey = await apiKeyForRoute(route, dependencies.getCredential);
  const modelConfig = catalogModelConfig(route.providerId, route.modelId);
  const conversation = [...(input.messages ?? []), { role: 'user' as const, content: input.text }];
  const response = await safeRequest(
    dependencies,
    route,
    buildApiUrl(endpoint, '/chat/completions'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model: route.modelId,
        messages: [{ role: 'system', content: input.systemPrompt }, ...conversation],
        ...(input.temperature !== undefined && modelConfig.supportsTemperature
          ? { temperature: input.temperature }
          : {}),
        ...(input.maxTokens !== undefined ? { [modelConfig.tokenParam]: input.maxTokens } : {}),
      }),
      signal: input.signal,
    },
  );
  const payload = await parseJson(response, route.providerId);
  return { text: requireText(responseTextFromChat(payload), route.providerId), model: route.modelId };
}

async function transcribe(
  dependencies: ProviderExecutionDependencies,
  input: ProviderTranscriptionInput,
): Promise<{ text: string; duration: number }> {
  const { route } = input;
  assertSupportedProvider(route);
  const endpoint = assertEndpoint(route);
  const apiKey = await apiKeyForRoute(route, dependencies.getCredential);
  const size = await dependencies.fileSize(input.audioUri);
  if (size !== undefined && size > PROVIDER_AUDIO_LIMIT_BYTES) {
    throw new ProviderExecutionError(
      'AUDIO_TOO_LARGE',
      'This audio is larger than the 25 MB provider limit. Record a shorter clip or choose a smaller file.',
    );
  }
  const parameters: Record<string, string> = { model: route.modelId };
  if (input.language && input.language !== 'auto') parameters.language = input.language;
  if (input.prompt) parameters.prompt = input.prompt;
  const url = buildApiUrl(endpoint, '/audio/transcriptions');
  let response: Response;
  try {
    response = await dependencies.requestFile({
      url,
      fileUri: input.audioUri,
      fileFieldName: 'file',
      fileMimeType: input.mimeType || 'audio/m4a',
      fileName: input.fileName || input.audioUri.split('/').pop() || 'recording.m4a',
      parameters,
      headers: authHeaders(apiKey),
      routeSnapshot: input.routeSnapshot,
      recoveryAudioUri: input.audioUri,
      signal: input.signal,
    });
  } catch (error) {
    throw normalizeTransportFailure(error, route.providerId);
  }
  const payload = await parseJson(checkResponse(route, url, response), route.providerId);
  return {
    text: requireText(nonEmptyText(objectValue(payload)?.text), route.providerId),
    duration: transcriptionDuration(payload),
  };
}

async function discoverModels(
  dependencies: ProviderExecutionDependencies,
  input: ProviderSetupInput,
): Promise<ProviderModelDiscovery> {
  const { route } = input;
  assertSupportedProvider(route);
  const endpoint = assertEndpoint(route);
  const apiKey = await apiKeyForRoute(route, dependencies.getCredential);
  const response = await safeRequest(dependencies, route, buildApiUrl(endpoint, '/models'), {
    method: 'GET',
    headers: authHeaders(apiKey),
    signal: input.signal,
  });
  const payload = objectValue(await parseJson(response, route.providerId));
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const models = entries
    .map((entry): { id: string; name: string } | null => {
      const model = objectValue(entry);
      const id = nonEmptyText(model?.id);
      return id ? { id, name: nonEmptyText(model?.name) || id } : null;
    })
    .filter((model): model is { id: string; name: string } => model !== null)
    .sort((first, second) => first.name.localeCompare(second.name));
  if (!models.length) {
    throw new ProviderExecutionError(
      'PROVIDER_RESPONSE_INVALID',
      `${route.providerId} returned no usable models.`,
    );
  }
  return { models, verification: 'catalog-only' };
}

async function testConnection(
  dependencies: ProviderExecutionDependencies,
  input: ProviderSetupInput,
): Promise<ProviderConnectionResult> {
  const { route } = input;
  if (!isTranscriptionScope(route.scope)) {
    await processText(dependencies, {
      route,
      text: 'Reply with OK.',
      systemPrompt: 'This is a provider connection test. Reply only with OK.',
      maxTokens: 8,
      signal: input.signal,
    });
    return {
      ok: true,
      verification: 'inference',
      providerId: route.providerId,
      modelId: route.modelId,
      scope: route.scope,
    };
  }
  await discoverModels(dependencies, input);
  return {
    ok: true,
    verification: 'catalog-only',
    providerId: route.providerId,
    modelId: route.modelId,
    scope: route.scope,
  };
}

const defaultDependencies: ProviderExecutionDependencies = {
  getCredential: getProviderCredential,
  fileSize: async (uri) => {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && typeof info.size === 'number' ? info.size : undefined;
  },
  request: requestProviderNative,
  requestFile: requestProviderFileNative,
};

export function createProviderExecution(
  dependencies: ProviderExecutionDependencies,
): ProviderExecution {
  const execute = <T>(
    input: ProviderSetupInput,
    operation: (scoped: ProviderExecutionDependencies, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const scope = createProviderCredentialScope(input.route.credentialRef, input.signal);
    const scoped: ProviderExecutionDependencies = {
      ...dependencies,
      request: (url, init, recovery) => {
        scope.assertActive();
        return dependencies.request(url, { ...init, signal: scope.signal }, recovery);
      },
      requestFile: (request) => {
        scope.assertActive();
        return dependencies.requestFile({ ...request, signal: scope.signal });
      },
    };
    return scope.run(() => operation(scoped, scope.signal)).finally(scope.dispose);
  };
  return {
    processProviderText: (input) =>
      execute(input, (scoped, signal) => processText(scoped, { ...input, signal })),
    transcribeWithProvider: (input) =>
      execute(input, (scoped, signal) => transcribe(scoped, { ...input, signal })),
    discoverProviderModels: (input) =>
      execute(input, (scoped, signal) => discoverModels(scoped, { ...input, signal })),
    testProviderConnection: (input) =>
      execute(input, (scoped, signal) => testConnection(scoped, { ...input, signal })),
  };
}

const defaultExecution = createProviderExecution(defaultDependencies);

export const processProviderText = defaultExecution.processProviderText;
export const transcribeWithProvider = defaultExecution.transcribeWithProvider;
export const discoverProviderModels = defaultExecution.discoverProviderModels;
export const testProviderConnection = defaultExecution.testProviderConnection;
```

Check `expo-file-system/legacy`'s `getInfoAsync` return type in `openwhispr-mobile/node_modules/expo-file-system/build/legacy/FileSystem.types.d.ts`: `FileInfo` is a union where `exists: true` carries `size: number`. If the union narrows on `exists`, the `typeof info.size === 'number'` check is still valid TypeScript; keep it.

- [ ] **Step 4: Simplify the credential shape**

In `openwhispr-mobile/src/services/providers/ProviderCredentials.ts`:

```ts
export interface ProviderCredential {
  apiKey: string;
}
```

and replace `parseCredential` with:

```ts
function parseCredential(value: unknown): ProviderCredential {
  const apiKey = objectValue(value)?.apiKey;
  if (typeof apiKey === 'string' && apiKey.trim()) return { apiKey: apiKey.trim() };
  throw new Error('Invalid provider credential');
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
```

In `openwhispr-mobile/src/services/providers/__tests__/ProviderCredentials.test.ts`: change the Corti pair test (lines 56-73) to save `{ apiKey: 'fixture-key' }` under `provider.groq` and expect `{ apiKey: 'fixture-key' }` back (rename the test to `stores and reads back an API key`), and change the `it.each([{}, { apiKey: ' ' }, { clientId: 'fixture-id' }])` case list at line 228 to `it.each([{}, { apiKey: ' ' }, { apiKey: 42 }])`.

- [ ] **Step 5: Trim the settings screen**

In `openwhispr-mobile/src/screens/ProviderSettingsScreen.tsx`:

1. Imports: replace `getProvidersForScope, resolveInferenceRoute,` in the `@shared/ai/routing` import with nothing (keep `type InferenceMode, type InferenceSelection`; drop `type InferenceScope`), and add `import { getMobileProvidersForScope, resolveMobileInferenceRoute, type MobileInferenceScope } from '@/lib/mobileProviders';`.
2. `SCOPES` becomes `Record<MobileInferenceScope, string>` without the `meeting` entry. `useState<InferenceScope>` becomes `useState<MobileInferenceScope>`; `chooseScope(next: MobileInferenceScope)`; the scope picker map uses `(Object.keys(SCOPES) as MobileInferenceScope[])`.
3. `PROVIDER_SETUP_URLS` keeps only `openai`, `groq`, `openrouter`.
4. Delete the `clientId` and `clientSecret` state, their `setClientId('')`/`setClientSecret('')` calls in `clearInputs`, every `provider.id === 'corti'` branch in `prepareSelection` (the `hasNewCredential` line becomes `const hasNewCredential = !!apiKey.trim();`, the `setProviderCredential` call passes `{ apiKey: apiKey.trim() }`, and the `...(provider.id === 'corti' ? {...} : {})` spread is removed from `saved`), and the whole `{provider.id === 'corti' ? (<>...</>) : (<Input label=... API key .../>)}` conditional so only the API-key `Input` remains.
5. `const providers = getProvidersForScope(scope);` becomes `const providers = getMobileProvidersForScope(scope);`. In `diagnose`, `resolveInferenceRoute({` becomes `resolveMobileInferenceRoute({`.
6. The "Verify access" copy: replace `transcription checks verify credentials or catalog access only.` with `transcription checks verify catalog access only.` and in `diagnose` drop the `result.verification === 'credentials'` ternary branch (two-way: `'inference'` or catalog-only message).

In `openwhispr-mobile/src/screens/__tests__/ProviderSettingsScreen.test.tsx` delete the test `stores Corti credentials as a pair in secure storage` (lines 145-163) and add:

```ts
it('lists only the supported providers and no Live Meetings workflow', () => {
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.press(screen.getByText('Provider'));
  expect(screen.getByText('OpenAI')).toBeTruthy();
  expect(screen.getByText('Groq')).toBeTruthy();
  expect(screen.getByText('Custom')).toBeTruthy();
  expect(screen.queryByText('Corti')).toBeNull();
  expect(screen.queryByText('Tinfoil')).toBeNull();
  fireEvent.press(screen.getByText('Workflow'));
  expect(screen.queryByText('Live Meetings')).toBeNull();
});
```

- [ ] **Step 6: Run the provider and settings suites, then typecheck**

Run: `npx jest --runInBand src/services/providers src/screens/__tests__/ProviderSettingsScreen.test.tsx src/services/transcription/__tests__/TranscriptionService.byok.test.ts`
Expected: PASS.
Run: `npm run typecheck` — Expected: exit 0. Then `npm run lint` — expect no new errors (the `no-bitwise` warnings from the deleted base64 helper are gone).

---

### Task 4: Native transport: timeout, dead background-session branches, metadata trim

**Files:**
- Modify: `openwhispr-mobile/src/services/providers/NativeProviderTransport.ts`
- Modify: `openwhispr-mobile/src/services/providers/__tests__/NativeProviderTransport.test.ts`
- Modify: `openwhispr-mobile/modules/background-uploader/src/index.ts`
- Modify: `openwhispr-mobile/modules/background-uploader/ios/BackgroundUploaderModule.swift`
- Modify: `openwhispr-mobile/modules/background-uploader/ios/ProviderJobMetadata.swift`
- Modify: `openwhispr-mobile/modules/background-uploader/tests/ProviderRequestTransportTests.swift:111-113`
- Modify: `openwhispr-mobile/src/lib/keyboardInferenceRoute.ts` (delete `readKeyboardOrphanInferenceRoute`)

**Interfaces:**
- Produces: every native provider request carries `timeoutSeconds: 300`. `BackgroundUploadOptions.routeSnapshot` no longer exists. `readKeyboardOrphanInferenceRoute` no longer exists (Task 5 switches the caller).

- [ ] **Step 1: Write the failing timeout test**

Append to `openwhispr-mobile/src/services/providers/__tests__/NativeProviderTransport.test.ts`:

```ts
it.each(['json', 'file'])('sends the 300 second provider timeout for %s requests', async (kind) => {
  mockRequest.mockResolvedValue({ status: 200, body: '{}', url: 'https://api.example.com', headers: {} });
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --runInBand src/services/providers/__tests__/NativeProviderTransport.test.ts`
Expected: FAIL (no `timeoutSeconds` in the call).

- [ ] **Step 3: Pass the timeout from JS**

In `openwhispr-mobile/src/services/providers/NativeProviderTransport.ts` add after the imports:

```ts
// The native transport's timeout is idle-based; whisper decodes of a 25 MB file
// and long chat completions can stay silent for minutes. Swift clamps to 300.
const PROVIDER_REQUEST_TIMEOUT_SECONDS = 300;
```

and add `timeoutSeconds: PROVIDER_REQUEST_TIMEOUT_SECONDS,` to both `uploader.requestProvider({ ... })` calls (after `headers`).

- [ ] **Step 4: Run the transport test**

Run: `npx jest --runInBand src/services/providers/__tests__/NativeProviderTransport.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove the dead background-session route handling in TypeScript**

In `openwhispr-mobile/modules/background-uploader/src/index.ts`: delete `routeSnapshot?: string;` from `BackgroundUploadOptions`, delete `routeSnapshot?: string;` from the `upload(options: {...})` parameter type of `NativeBackgroundUploader`, and delete `routeSnapshot: options.routeSnapshot,` from the `upload` implementation. Keep `ProviderRequestOptions.routeSnapshot` and `recoveryAudioUri`.

In `openwhispr-mobile/src/lib/keyboardInferenceRoute.ts` delete the function `readKeyboardOrphanInferenceRoute` entirely. (`useKeyboardHandoff.ts` still imports it; Task 5 fixes that. Typecheck will fail between these two tasks; that is expected.)

- [ ] **Step 6: Remove the dead background-session branches in Swift**

In `openwhispr-mobile/modules/background-uploader/ios/BackgroundUploaderModule.swift` (use `git show origin/main:openwhispr-mobile/modules/background-uploader/ios/BackgroundUploaderModule.swift` as the reference for every "restore" below):

1. `UploadRequest`: delete `@Field var routeSnapshot: String?`.
2. `BackgroundUploaderConstants`: delete `static let orphanedRouteKey = "keyboard_orphaned_inference_route"`.
3. In `urlSession(_:task:didCompleteWithError:)` restore the `origin/main` branch:

```swift
    if let upload {
      handleAlive(upload: upload, task: task, error: error)
    } else if error == nil {
      handleOrphaned(responseData: orphanData, jobId: task.taskDescription)
    }
```

4. Delete the whole `handleOrphanedFailure(metadata:)` function.
5. In `handleAlive`, restore:

```swift
    if let error {
      upload.promise.reject("BG_UPLOAD_ERROR", error.localizedDescription)
      return
    }
    let httpResponse = task.response as? HTTPURLResponse
    let body = String(data: upload.responseData, encoding: .utf8) ?? ""
```

6. `handleOrphaned` signature back to `private func handleOrphaned(responseData: Data, jobId: String?)`; delete the three lines that decode `metadata` and compute `jobId` from it; delete the `providerId`/`providerText` closure; `textCandidates` back to the plain array `[json["text"], json["cleanedText"], json["cleaned_text"], ...]` exactly as on `origin/main`; `cleanupApplied` back to `(json["cleanupApplied"] as? Bool) ?? (json["cleanup_applied"] as? Bool) ?? false`; delete the `if let metadata { defaults.set(metadata.encoded, forKey: orphanedRouteKey) } else { defaults.removeObject(...) }` pair.
7. In `startUpload`: delete the `let metadata = ProviderJobMetadata.decode(request.routeSnapshot)` block and the three guard blocks that follow it (invalid snapshot, jobId mismatch, byok destination), delete the whole `if let metadata, metadata.route.provider == "byok" { ... startProviderRequest(...); return }` block, restore `task.taskDescription = request.parameters["jobId"]`, and restore the NSLog argument to `resolvedFileName`.
8. Keep everything under `startProviderRequest`, the `providerTransport` property, the four new module functions, and the `completed`/`defer` cleanup in `buildMultipartBodyFile`.

Verify with `git diff origin/main -- openwhispr-mobile/modules/background-uploader/ios/BackgroundUploaderModule.swift`: the only remaining additions are `ProviderRequest`, `providerTransport`, the four `AsyncFunction`/`Function` registrations, `startProviderRequest`, and the `completed` defer.

In `openwhispr-mobile/modules/background-uploader/ios/ProviderJobMetadata.swift`: delete `var cortiEnvironment: String?` and `var cortiTenant: String?` and their two `validate()` checks and the `cortiEnvironment = nil; cortiTenant = nil` reset; in `transcript(from:)` replace the body with:

```swift
  func transcript(from body: String) -> String? {
    guard let data = body.data(using: .utf8),
          let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let trimmed = (payload["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty else { return nil }
    return trimmed
  }
```

In `openwhispr-mobile/modules/background-uploader/tests/ProviderRequestTransportTests.swift` delete lines 111-113 (the `cortiSnapshot` preconditions).

- [ ] **Step 7: Run the native harness and the JS suites**

Run: `python3 modules/background-uploader/tests/run-provider-transport-tests.py`
Expected: exit 0 with "Second origin received zero redirected requests; pre-start cancellation sent no request."
Run: `npx jest --runInBand src/services/providers src/lib/__tests__/keyboardInferenceRoute.test.ts modules/background-uploader`
Expected: PASS.

---

### Task 5: Keyboard handoff fixes

**Files:**
- Modify: `openwhispr-mobile/src/hooks/useKeyboardHandoff.ts` (`processOrphanedRawTranscript` 287-458, `runAgentJob` 731-800, `bgStartedSub` 1042-1052)
- Test: `openwhispr-mobile/src/hooks/__tests__/useKeyboardHandoff.fullAccessRoute.test.ts`

**Interfaces:**
- Consumes: `readKeyboardInferenceRoute`, `readKeyboardProviderResult`, `clearKeyboardProviderRecovery` (Task 4 shape), `readKeyboardAgentJob`, `clearKeyboardAgentJob` from `@/lib/keyboardAgentSync`.

- [ ] **Step 1: Update the module mocks and write the failing tests**

In `openwhispr-mobile/src/hooks/__tests__/useKeyboardHandoff.fullAccessRoute.test.ts`:

1. In the `jest.mock('@/lib/keyboardInferenceRoute', ...)` factory delete the `readKeyboardOrphanInferenceRoute` line.
2. Find the existing mock for `@/lib/keyboardAgentSync` (search the file for `keyboardAgentSync`). If it exists, make sure its factory exposes `readKeyboardAgentJob: jest.fn(() => null)` and `clearKeyboardAgentJob: jest.fn()` (add them if missing, keeping the other exports). If there is no mock for that module, add one next to the other `jest.mock` calls:

```ts
jest.mock('@/lib/keyboardAgentSync', () => ({
  ...jest.requireActual('@/lib/keyboardAgentSync'),
  readKeyboardAgentJob: jest.fn(() => null),
  clearKeyboardAgentJob: jest.fn(),
}));
```

3. Inside the `describe('useKeyboardHandoff — orphaned keyboard transcript', ...)` block, add, using the same `storage`, `renderHook`/`waitFor` setup the neighbouring test `saves native raw text and original provider route before clearing durable recovery` (line 304) uses:

```ts
  it('never inserts a provider result that belongs to an agent job', async () => {
    const { readKeyboardProviderResult, clearKeyboardProviderRecovery } =
      jest.requireMock('@/lib/keyboardInferenceRoute');
    const { readKeyboardAgentJob, clearKeyboardAgentJob } =
      jest.requireMock('@/lib/keyboardAgentSync');
    storage.getItem.mockImplementation((key: string) => {
      if (key === 'keyboard_recording_job_id') return '100-job';
      return null;
    });
    readKeyboardProviderResult.mockReturnValue({
      text: 'write a follow-up email to Bob',
      route: { provider: 'byok' },
    });
    readKeyboardAgentJob.mockReturnValue({ jobId: '100-job', instruction: '' });

    renderHook(() => useKeyboardHandoff());

    await waitFor(() => expect(clearKeyboardProviderRecovery).toHaveBeenCalledWith('100-job'));
    expect(clearKeyboardAgentJob).toHaveBeenCalled();
    expect(storage.setKeyboardStatus).toHaveBeenCalledWith(
      'agent_error',
      'The agent request was interrupted. Try again from the keyboard.',
    );
    expect(mockAddTranscript).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalledWith('keyboard_pending_transcript', expect.anything());
  });

  it('uses the per-job route snapshot to clean a Cloud orphan', async () => {
    const { readKeyboardInferenceRoute } = jest.requireMock('@/lib/keyboardInferenceRoute');
    readKeyboardInferenceRoute.mockReturnValue({
      provider: 'cloud',
      cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' },
    });
    storage.getItem.mockImplementation((key: string) => {
      if (key === 'keyboard_orphaned_raw_transcript') return 'raw transcript';
      if (key === 'keyboard_orphaned_raw_transcript_job_id') return '100-job';
      if (key === 'keyboard_recording_job_id') return '100-job';
      return null;
    });
    mockCleanupTranscript.mockResolvedValue('Cleaned transcript.');

    renderHook(() => useKeyboardHandoff());

    await waitFor(() => expect(mockCleanupTranscript).toHaveBeenCalled());
    expect(readKeyboardInferenceRoute).toHaveBeenCalledWith('100-job');
    await waitFor(() =>
      expect(mockAddTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Cleaned transcript.', cleanupWarning: undefined }),
      ),
    );
  });

  it('drops a stale orphan once and clears its recovery keys', async () => {
    const { clearKeyboardProviderRecovery } = jest.requireMock('@/lib/keyboardInferenceRoute');
    storage.getItem.mockImplementation((key: string) => {
      if (key === 'keyboard_orphaned_raw_transcript') return 'raw transcript';
      if (key === 'keyboard_orphaned_raw_transcript_job_id') return '100-job';
      if (key === 'keyboard_recording_job_id') return '200-job';
      return null;
    });

    renderHook(() => useKeyboardHandoff());

    await waitFor(() =>
      expect(storage.removeItem).toHaveBeenCalledWith('keyboard_orphaned_raw_transcript_job_id'),
    );
    expect(mockCleanupTranscript).not.toHaveBeenCalled();
    expect(clearKeyboardProviderRecovery).toHaveBeenCalledWith('100-job');
  });
```

If the existing tests reference the storage mock under a different name than `storage`, use that name. The `'keyboard_recording_job_id'` key must match what `readActiveJobId()` reads; confirm with `grep -n "const readActiveJobId" -A 3 src/hooks/useKeyboardHandoff.ts`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest --runInBand src/hooks/__tests__/useKeyboardHandoff.fullAccessRoute.test.ts`
Expected: the three new tests FAIL (first: pending transcript written / status not agent_error; second: `readKeyboardOrphanInferenceRoute` import error or cleanup skipped; third: `clearKeyboardProviderRecovery` not called).

- [ ] **Step 3: Fix the orphan path**

In `openwhispr-mobile/src/hooks/useKeyboardHandoff.ts`:

1. Remove `readKeyboardOrphanInferenceRoute` from the `@/lib/keyboardInferenceRoute` import.
2. At the top of `processOrphanedRawTranscript`, replace the block that reads the provider result (from `const providerJobId = readActiveJobId();` through the closing `}` of `if (providerJobId) {`) with:

```ts
      const providerJobId = readActiveJobId();
      let providerResult: ReturnType<typeof readKeyboardProviderResult>;
      if (providerJobId) {
        if (readKeyboardAgentJob(providerJobId)) {
          // An agent job's provider result is the spoken instruction, never text
          // to insert. The composer did not finish; clear both and let the user retry.
          clearKeyboardProviderRecovery(providerJobId);
          clearKeyboardAgentJob();
          setKeyboardStatus(
            'agent_error',
            'The agent request was interrupted. Try again from the keyboard.',
          );
          return;
        }
        try {
          providerResult = readKeyboardProviderResult(providerJobId);
        } catch {
          clearKeyboardProviderRecovery(providerJobId);
          setKeyboardStatus(
            'error',
            'The original provider result is unavailable. Retry the recording.',
          );
          return;
        }
      }
```

3. In the first stale check (`if (!isCurrentJob(rawJobId)) {` right after `const activeJobId = readActiveJobId();`), add `clearKeyboardProviderRecovery(rawJobId);` before the two `removeItem` calls.
4. Replace `recoveredRoute = providerResult?.route ?? readKeyboardOrphanInferenceRoute(rawJobId);` with `recoveredRoute = providerResult?.route ?? readKeyboardInferenceRoute(rawJobId);`.
5. In the second stale check inside the `try` (`if (!isCurrentJob(rawJobId)) { ... return; }` after `cleanup_done`), add `recoverySaved = true; clearKeyboardProviderRecovery(rawJobId);` before `return;`.
6. In the `finally`, delete `AppGroupStorage.removeItem('keyboard_orphaned_inference_route');`.

- [ ] **Step 4: Clear provider recovery on the agent path and guard the warm-mic snapshot**

In `runAgentJob`, immediately after `markTiming('agent_transcribe_done');` add `clearKeyboardProviderRecovery(jobId);`. In its `catch (error)`, add `clearKeyboardProviderRecovery(jobId);` as the first statement.

In `bgStartedSub`, replace `if (!readKeyboardInferenceRoute(bgJobId)) snapshotKeyboardInferenceRoute(bgJobId);` with:

```ts
        try {
          if (!readKeyboardInferenceRoute(bgJobId)) snapshotKeyboardInferenceRoute(bgJobId);
        } catch {
          setKeyboardStatus('error', 'Complete provider setup in AI Models.');
          cleanup({ resetStatus: false });
          return;
        }
```

- [ ] **Step 5: Run the keyboard suite and typecheck**

Run: `npx jest --runInBand src/hooks/__tests__/useKeyboardHandoff`
Expected: PASS. Run `npm run typecheck` — exit 0.

---

### Task 6: Mode coupling: Home toggle, unselected scopes, recording lock, consent fallback

**Files:**
- Modify: `openwhispr-mobile/src/lib/inferenceModes.ts` (add `dictationModeConfig`)
- Test: `openwhispr-mobile/src/lib/__tests__/inferenceModes.test.ts` (create if absent; otherwise append)
- Modify: `openwhispr-mobile/src/screens/HomeScreen.tsx:343-392` and the toggle `Pressable` at `:546-570`
- Modify: `openwhispr-mobile/src/screens/SpeechToTextScreen.tsx:61-65`
- Modify: `openwhispr-mobile/src/screens/ProviderSettingsScreen.tsx` (`chooseScope`, `save`)
- Modify: `openwhispr-mobile/src/screens/DictationAgentScreen.tsx:22`, `openwhispr-mobile/src/screens/CleanupPromptScreen.tsx:38`
- Modify: `openwhispr-mobile/src/hooks/useAudioRecording.ts` (`retryWithCloud`), `openwhispr-mobile/src/hooks/useFileUpload.ts` (`retryWithCloud`)
- Test: `openwhispr-mobile/src/screens/__tests__/ProviderSettingsScreen.test.tsx`, `openwhispr-mobile/src/lib/__tests__/inferenceRouting.test.ts`

**Interfaces:**
- Produces: `dictationModeConfig(config: UserConfig | null, mode: 'cloud' | 'private'): Pick<UserConfig, 'defaultMode' | 'inference'>`; `snapshotTextInference` gains an export already present (`snapshotTextInference(provider)`).

- [ ] **Step 1: Write the failing helper test**

Create or append `openwhispr-mobile/src/lib/__tests__/inferenceModes.test.ts`:

```ts
import { dictationModeConfig } from '../inferenceModes';

it('keeps the dictation selection in step with the Cloud toggle', () => {
  const config = {
    defaultMode: 'private' as const,
    inference: {
      dictation: { mode: 'local' as const },
      upload: { mode: 'providers' as const, providerId: 'groq' },
    },
  };
  expect(dictationModeConfig(config, 'cloud')).toEqual({
    defaultMode: 'cloud',
    inference: { dictation: { mode: 'openwhispr' }, upload: config.inference.upload },
  });
  expect(dictationModeConfig(null, 'private')).toEqual({
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' } },
  });
});
```

(`inferenceModes.ts` imports `react-native`'s `Platform`; if the test needs it, `jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }))` at the top of the file is enough.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --runInBand src/lib/__tests__/inferenceModes.test.ts`
Expected: FAIL, `dictationModeConfig` is not exported.

- [ ] **Step 3: Add the helper and use it from both screens**

Append to `openwhispr-mobile/src/lib/inferenceModes.ts` (add `UserConfig` to the existing `@/types` import):

```ts
// The Home toggle and the Speech-to-Text picker both own the dictation mode;
// writing the scope selection alongside defaultMode keeps routing and UI in step.
export function dictationModeConfig(
  config: UserConfig | null,
  mode: 'cloud' | 'private',
): Pick<UserConfig, 'defaultMode' | 'inference'> {
  return {
    defaultMode: mode,
    inference: {
      ...config?.inference,
      dictation: { mode: mode === 'private' ? 'local' : 'openwhispr' },
    },
  };
}
```

In `openwhispr-mobile/src/screens/HomeScreen.tsx` `handleTogglePrivateMode`:
- Add at the top, right after `safeHaptics('light');`: `if (isRecording) return;`
- Replace `updateConfig({ defaultMode: 'cloud' });` with `updateConfig(dictationModeConfig(useConfigStore.getState().config, 'cloud'));`
- Replace `updateConfig({ defaultMode: 'private' });` with `updateConfig(dictationModeConfig(useConfigStore.getState().config, 'private'));`
- Import `dictationModeConfig` from `@/lib/inferenceModes`.
- On the toggle `Pressable` (line ~546) add `disabled={isRecording}` and extend `accessibilityState={{ checked: !isPrivateMode, disabled: isRecording }}`.

In `openwhispr-mobile/src/screens/SpeechToTextScreen.tsx` replace

```ts
      updateConfig({
        defaultMode: nextProcessing,
        inference: { ...config?.inference, dictation: { mode } },
      });
```

with `updateConfig(dictationModeConfig(config ?? null, nextProcessing));` (import it; `nextProcessing` is `'cloud' | 'private'` on this path because `providers` returned early — if TypeScript disagrees, narrow with `nextProcessing === 'private' ? 'private' : 'cloud'`). Drop `config?.inference` from the `useCallback` deps if it is now unused, keeping `config`.

- [ ] **Step 4: Run the helper test**

Run: `npx jest --runInBand src/lib/__tests__/inferenceModes.test.ts src/screens/__tests__/SpeechToText src/screens/__tests__/HomeScreen`
Expected: PASS (whichever of those screen suites exist).

- [ ] **Step 5: Write the failing settings-screen tests**

Append to `openwhispr-mobile/src/screens/__tests__/ProviderSettingsScreen.test.tsx`:

```ts
it('defaults an unselected workflow to On-Device for a private-mode user', () => {
  mockConfig = { defaultMode: 'private' };
  mockActiveMode = 'private';
  render(<ProviderSettingsScreen />);
  fireEvent.press(screen.getByText('Workflow'));
  fireEvent.press(screen.getByText('Uploads'));
  expect(screen.getByText('On-Device')).toBeTruthy();
});

it('keeps uploads on the previous mode when dictation switches to Providers', async () => {
  mockConfig = { defaultMode: 'private' };
  mockActiveMode = 'private';
  mockCredentialStatus.mockResolvedValue({ isConfigured: true });
  render(<ProviderSettingsScreen />);
  enableProviders();
  fireEvent.press(screen.getByText('Save selection'));
  await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
  const saved = mockUpdateConfig.mock.calls[0][0] as { inference: Record<string, { mode: string }> };
  expect(saved.inference.dictation.mode).toBe('providers');
  expect(saved.inference.upload).toEqual({ mode: 'local' });
});
```

(`mockActiveMode` is assigned by `useProcessingModeStore` in this file's mocks; `enableProviders()` and `mockCredentialStatus` already exist at the top of the file.)

- [ ] **Step 6: Run to verify they fail**

Run: `npx jest --runInBand src/screens/__tests__/ProviderSettingsScreen.test.tsx`
Expected: the two new tests FAIL ("OpenWhispr Cloud" shown; no `upload` in the saved config).

- [ ] **Step 7: Inherit the legacy mode for unselected scopes**

In `openwhispr-mobile/src/screens/ProviderSettingsScreen.tsx`:

1. Add above the component:

```ts
function legacyMode(config: UserConfig | null | undefined): InferenceSelection {
  return { mode: config?.defaultMode === 'private' ? 'local' : 'openwhispr' };
}
```

(import `type UserConfig` from `@/types`.)

2. In the `useState<InferenceSelection>` initializer replace the nested ternary object with `config?.inference?.dictation ?? (config?.defaultMode === 'providers' ? { mode: 'providers' } : legacyMode(config))`.
3. In `chooseScope` replace `{ mode: 'openwhispr' }` with `legacyMode(config)`.
4. In `save()`, inside the `updateConfig({...})` argument, replace `inference: { ...useConfigStore.getState().config?.inference, [scope]: saved },` with:

```ts
        inference: {
          ...currentConfig?.inference,
          ...(scope === 'dictation' &&
          saved.mode === 'providers' &&
          !currentConfig?.inference?.upload
            ? { upload: currentConfig?.inference?.dictation ?? legacyMode(currentConfig) }
            : {}),
          [scope]: saved,
        },
```

(`currentConfig` is already defined two lines above. When the previous dictation selection was itself `providers`, `currentConfig.inference.dictation` is spread into `upload`, which is what "keep the previous mode" means for a user who re-saves; the test above starts from a legacy private config so the inherited value is `{ mode: 'local' }`.)

- [ ] **Step 8: Treat Providers as a remote mode on the agent and cleanup-prompt screens**

`openwhispr-mobile/src/screens/DictationAgentScreen.tsx:22`: `const isCloudMode = activeMode !== 'private';`
`openwhispr-mobile/src/screens/CleanupPromptScreen.tsx:38`: `const isActive = activeMode !== 'private' && cleanupEnabled;`
Leave the copy strings alone except the word "Requires Cloud mode." in `DictationAgentScreen.tsx:48`, which becomes "Requires Cloud or Providers mode."

- [ ] **Step 9: Re-snapshot text stages on the consented Cloud fallback**

In `openwhispr-mobile/src/hooks/useAudioRecording.ts`, import `snapshotTextInference` alongside `snapshotTranscriptionJob`, and in `retryWithCloud` insert before `await finalizeRecording(retained, 'cloud', clientTranscriptionId);`:

```ts
      // The private-mode snapshot pinned local text stages; a consented Cloud
      // upload should clean the way a Cloud recording would.
      jobRouteRef.current = { provider: 'cloud', ...snapshotTextInference('cloud') };
```

In `openwhispr-mobile/src/hooks/useFileUpload.ts`, `jobRoute` is a `const` captured by `runTranscription`. Change `const jobRoute = snapshotTranscriptionJob('upload');` to `let jobRoute = snapshotTranscriptionJob('upload');` and in `retryWithCloud` insert before `await runTranscription('cloud');`:

```ts
          jobRoute = { provider: 'cloud', ...snapshotTextInference('cloud') };
```

(import `snapshotTextInference` from `../lib/inferenceRouting`).

Append to `openwhispr-mobile/src/lib/__tests__/inferenceRouting.test.ts`:

```ts
it('re-snapshots Cloud text stages for a consented cloud fallback', () => {
  mockProcessing.activeMode = 'private';
  mockState.config.inference = {};
  const { snapshotTextInference } = require('../inferenceRouting') as typeof import('../inferenceRouting');
  expect(snapshotTextInference('cloud')).toEqual({
    cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' },
    agentRoute: { mode: 'openwhispr', scope: 'agent' },
  });
});
```

- [ ] **Step 10: Run the affected suites and typecheck**

Run: `npx jest --runInBand src/screens/__tests__/ProviderSettingsScreen.test.tsx src/lib/__tests__/inferenceRouting.test.ts src/lib/__tests__/inferenceModes.test.ts src/hooks/__tests__/useAudioRecording src/hooks/__tests__/useFileUpload src/screens/__tests__/DictationAgent src/screens/__tests__/CleanupPrompt`
Expected: PASS. `npm run typecheck` exit 0.

---

### Task 7: Text AI: no Cloud fallthrough for On-Device, note chat parity, single set of local instructions

**Files:**
- Modify: `openwhispr-mobile/src/services/reasoning/ReasoningService.ts:136-243`
- Modify: `openwhispr-mobile/src/services/agent/AgentStreamClient.ts:1-2,161-195`
- Test: `openwhispr-mobile/src/services/reasoning/__tests__/ReasoningService.byok.test.ts`, `openwhispr-mobile/src/services/agent/__tests__/AgentStreamClient.byok.test.ts`

- [ ] **Step 1: Write the failing ReasoningService tests**

Append to `openwhispr-mobile/src/services/reasoning/__tests__/ReasoningService.byok.test.ts`:

```ts
it('never sends an On-Device text scope to OpenWhispr Cloud, even with fallback consent', async () => {
  jest.mocked(getInferenceSelection).mockReturnValue({ mode: 'local' });
  await expect(
    ReasoningService.processText({
      text: 'private note question',
      systemPrompt: 'answer',
      inferenceScope: 'agent',
      routing: { isPrivateNote: true, allowCloudFallback: true },
    }),
  ).rejects.toThrow('On-device AI is unavailable for this request');
  expect(api.post).not.toHaveBeenCalled();
  expect(processProviderText).not.toHaveBeenCalled();
});

it('keeps note chat on OpenWhispr Cloud when no provider or On-Device selection exists', async () => {
  jest.mocked(getInferenceSelection).mockReturnValue(undefined);
  jest.mocked(api.post).mockResolvedValue({ text: 'cloud answer', model: 'cloud' });
  await expect(
    ReasoningService.chatOverNote({
      context: 'note body',
      question: 'what?',
      history: [],
      routing: { isPrivateNote: true, allowCloudFallback: true },
    }),
  ).resolves.toMatchObject({ text: 'cloud answer' });
  expect(api.post).toHaveBeenCalledTimes(1);
});
```

Check how `api.post` resolves in the existing tests of this file (the mocked return shape) and match it; if `callApi` unwraps `response.data`, resolve `{ data: { text: 'cloud answer', model: 'cloud' } }` instead.

Then create `openwhispr-mobile/src/services/reasoning/__tests__/ReasoningService.localInstructions.test.ts`:

```ts
import { ReasoningService } from '../ReasoningService';
import { LocalReasoningService } from '../LocalReasoningService';
import { getInferenceSelection } from '@/lib/inferenceRouting';

jest.mock('@/lib/apiClient', () => ({ api: { post: jest.fn() } }));
jest.mock('@/lib/inferenceRouting', () => ({
  getInferenceSelection: jest.fn(),
  resolveMobileProviderRoute: jest.fn(),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));
jest.mock('@/lib/localReasoning', () => ({
  isLocalReasoningRequired: (): boolean => false,
  getLocalReasoningReadiness: async (): Promise<{ status: string }> => ({ status: 'ready' }),
  fitsLocalReasoningBudget: async (): Promise<boolean> => true,
  getLocalReasoningUnavailableMessage: (): string => 'Local unavailable',
  LocalReasoningError: class extends Error {
    constructor(_code: string, message: string) {
      super(message);
    }
  },
}));
jest.mock('../LocalReasoningService', () => ({
  ...jest.requireActual('../LocalReasoningService'),
  LocalReasoningService: { processText: jest.fn() },
}));

const { buildLocalReasoningInstructions } = jest.requireActual(
  '../LocalReasoningService',
) as typeof import('../LocalReasoningService');

it('adds language, tone and dictionary instructions exactly once on the On-Device path', async () => {
  jest.mocked(getInferenceSelection).mockReturnValue({ mode: 'local' });
  const processText = jest.mocked(LocalReasoningService.processText);
  processText.mockImplementation(async (request) => ({
    text: buildLocalReasoningInstructions(request),
    model: 'local',
  }));
  const result = await ReasoningService.processText({
    text: 'um hello',
    tone: 'formal',
    language: 'fr',
    customDictionary: ['OpenWhispr'],
    inferenceScope: 'cleanup',
  });
  const count = (needle: string): number => result.text.split(needle).length - 1;
  expect(count('Prefer fr language conventions')).toBe(1);
  expect(count('Custom Dictionary')).toBe(1);
});
```

Confirm the real names of the readiness/budget helpers by reading `openwhispr-mobile/src/lib/localReasoning.ts` exports and the imports at the top of `ReasoningService.ts`; mock every name `ReasoningService.ts` imports from `@/lib/localReasoning`. The `text` field of `ReasoningResponse` is what `processText` returns from `LocalReasoningService.processText`; confirm the response shape in `openwhispr-mobile/src/types/index.ts` (`ReasoningResponse`) and adjust the mock's return if it has more required fields.

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest --runInBand src/services/reasoning/__tests__/ReasoningService.byok.test.ts src/services/reasoning/__tests__/ReasoningService.localInstructions.test.ts`
Expected: FAIL — first test calls `api.post`; second test resolves via `processText` local path or throws; third test counts 2.

- [ ] **Step 3: Fix ReasoningService**

In `openwhispr-mobile/src/services/reasoning/ReasoningService.ts`:

1. Replace

```ts
    const localRequest =
      (usesProviders || localSelected) && !systemPrompt
        ? { ...request, ...buildProviderPrompt(request) }
        : request;
```

with

```ts
    // buildProviderPrompt already folds language, tone and dictionary into the
    // system prompt; drop the raw fields so the local path does not append them again.
    const localRequest =
      (usesProviders || localSelected) && !systemPrompt
        ? {
            ...request,
            ...buildProviderPrompt(request),
            language: undefined,
            locale: undefined,
            tone: undefined,
            customDictionary: undefined,
          }
        : request;
```

2. Immediately before `if (usesProviders) {` insert:

```ts
    if (localSelected) {
      throw new LocalReasoningError(
        'LOCAL_REASONING_UNAVAILABLE',
        'On-device AI is unavailable for this request. Choose a provider or OpenWhispr Cloud in AI Models.',
      );
    }
```

3. In `processText`'s providers branch, replace `const prompt = buildProviderPrompt(request);` with `const prompt = { systemPrompt: localRequest.systemPrompt as string, text: localRequest.text };` so the prompt is built once (`localRequest` always carries the provider prompt on this branch because `usesProviders` is true; when a caller supplied `systemPrompt`, `localRequest === request` and both fields are already set).

4. Replace `chatOverNote` with:

```ts
  static async chatOverNote(request: ChatOverNoteRequest): Promise<ReasoningResponse> {
    const payload = buildChatOverNotePayload(request);
    const { getInferenceSelection } =
      require('@/lib/inferenceRouting') as typeof import('@/lib/inferenceRouting');
    const selection = request.inferenceRoute ?? getInferenceSelection('agent');
    if (selection?.mode === 'providers' || selection?.mode === 'local') {
      return this.processText({
        text: payload.text,
        systemPrompt: payload.systemPrompt,
        signal: request.signal,
        inferenceScope: 'agent',
        inferenceRoute: request.inferenceRoute,
        routing: request.routing,
      });
    }
    // Cloud note chat keeps its pre-BYOK behavior: the consent dialog in the
    // editor is the privacy gate, and the answer always comes from the hosted model.
    return this.callApi(payload.text, {
      systemPrompt: payload.systemPrompt,
      signal: request.signal,
    });
  }
```

- [ ] **Step 4: Run the reasoning suites**

Run: `npx jest --runInBand src/services/reasoning src/lib/__tests__/cleanupTranscript src/lib/__tests__/transcribeAndCleanup src/screens/__tests__/NoteEditorScreen`
Expected: PASS.

- [ ] **Step 5: Require a system prompt on the provider composition path**

In `openwhispr-mobile/src/services/agent/AgentStreamClient.ts`: delete `import sharedPrompts from '@shared/ai/prompts.json';` and replace

```ts
        systemPrompt:
          systemPrompt ?? sharedPrompts.actionPrompt.replace(/\{\{agentName\}\}/g, 'OpenWhispr'),
```

with `systemPrompt,` after adding, right after the `if (!latest || latest.role !== 'user')` check:

```ts
    if (!systemPrompt) throw new Error('Keyboard composition requires a system prompt.');
```

Append to `openwhispr-mobile/src/services/agent/__tests__/AgentStreamClient.byok.test.ts` a test that calls `streamAgentText` with a `providers` route and no `systemPrompt` and expects rejection with `'Keyboard composition requires a system prompt.'` and no `processProviderText` call (reuse that file's existing mocks and route fixture).

- [ ] **Step 6: Run the agent suites and typecheck**

Run: `npx jest --runInBand src/services/agent`
Expected: PASS. `npm run typecheck` exit 0.

---

### Task 8: Credential registry hardening and reset ordering

**Files:**
- Modify: `openwhispr-mobile/src/services/providers/ProviderCredentials.ts:61-75` (`readRegistry`)
- Modify: `openwhispr-mobile/src/services/storage/StorageService.ts:102-106` (`clearAll`)
- Test: `openwhispr-mobile/src/services/providers/__tests__/ProviderCredentials.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `openwhispr-mobile/src/services/providers/__tests__/ProviderCredentials.test.ts`, using the file's existing SecureStore mock (search for how the other tests seed the registry, usually by calling `SecureStore.setItemAsync` on `'openwhispr.provider-credentials.registry.v1'`):

```ts
it('treats an unreadable registry as empty so save and reset still work', async () => {
  await SecureStore.setItemAsync('openwhispr.provider-credentials.registry.v1', '{not json');
  await expect(getProviderCredential('provider.openai')).resolves.toBeNull();
  await expect(
    setProviderCredential('provider.openai', { apiKey: 'fresh-key' }),
  ).resolves.toBeUndefined();
  await expect(getProviderCredential('provider.openai')).resolves.toEqual({ apiKey: 'fresh-key' });
  await SecureStore.setItemAsync('openwhispr.provider-credentials.registry.v1', '{not json');
  await expect(clearProviderCredentials()).resolves.toBeUndefined();
  await expect(
    SecureStore.getItemAsync('openwhispr.provider-credentials.registry.v1'),
  ).resolves.toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --runInBand src/services/providers/__tests__/ProviderCredentials.test.ts`
Expected: FAIL with "Unable to read provider credential".

- [ ] **Step 3: Make the registry self-healing and reorder reset**

Replace `readRegistry` in `ProviderCredentials.ts` with:

```ts
async function readRegistry(): Promise<CredentialRegistry> {
  const raw = await SecureStore.getItemAsync(REGISTRY_KEY, SECURE_OPTIONS);
  if (raw === null) return {};
  // A registry we cannot trust must not lock the user out of saving or
  // resetting; entries it referenced are simply re-entered by the user.
  try {
    const parsed: unknown = JSON.parse(raw);
    const registry = objectValue(parsed);
    if (!registry) return {};
    for (const [reference, state] of Object.entries(registry)) {
      validateReference(reference);
      if (state !== 'pending' && state !== 'active' && state !== 'removed') return {};
    }
    return registry as CredentialRegistry;
  } catch {
    return {};
  }
}
```

(`objectValue` was added to this file in Task 3.) In `clearProviderCredentials`, after the `Promise.allSettled` check, the final `await SecureStore.deleteItemAsync(REGISTRY_KEY, SECURE_OPTIONS);` already runs for an empty registry; no change needed.

In `openwhispr-mobile/src/services/storage/StorageService.ts` reorder `clearAll` so credential clearing is last and cannot block the rest:

```ts
  static async clearAll(): Promise<void> {
    localStorage.clear();
    await SecureStorageService.clearAuthToken();
    await clearProviderCredentials();
  }
```

- [ ] **Step 4: Run the credential suites**

Run: `npx jest --runInBand src/services/providers src/services/storage`
Expected: PASS.

---

### Task 9: Documentation

**Files:**
- Modify: `openwhispr-mobile/README.md` ("Personal provider setup (iOS)" section)
- Modify: `openwhispr-mobile/CONTRIBUTING.md` ("Shared provider development" section)
- Rewrite: `openwhispr-mobile/docs/BYOK_SMOKE_TESTS.md`
- Modify: `docs/superpowers/plans/2026-09-21-mobile-byok.md` (add a pointer at the top)

- [ ] **Step 1: README**

In the "Personal provider setup (iOS)" section: change the first paragraph's list to "Dictation/keyboard, uploads, cleanup, note formatting/titles, and chat/agents keep separate selections." (drop live meetings), and add after it: "This release supports OpenAI, Groq, OpenRouter (text), and any OpenAI-compatible Custom server. Other providers in the shared catalog are not offered on mobile yet." Replace "Enter a provider API key, or a Corti client ID and secret, and save." with "Enter a provider API key and save." Replace "Transcription checks verify credentials or a model catalog; they do not prove transcription access." with "Transcription checks verify the model catalog; they do not prove transcription access." Add to the credentials paragraph: "Deleting the app does not remove Keychain items; use Remove credential before uninstalling if you want the key gone."

- [ ] **Step 2: CONTRIBUTING**

In "Shared provider development" delete the line `python3 modules/background-uploader/tests/run-provider-transport-tests.py` from nothing (keep it; the harness still exists) but change "Complete the maintainer smoke-test matrix using your own provider accounts and a physical device." to "Complete the maintainer smoke-test matrix (four providers) using your own provider accounts and a physical device."

- [ ] **Step 3: Smoke-test matrix**

Replace `openwhispr-mobile/docs/BYOK_SMOKE_TESTS.md` with:

```markdown
# Personal BYOK release checks

The shared catalog describes more providers than the mobile app ships. This release offers exactly four: OpenAI, Groq, OpenRouter (text only) and Custom (any OpenAI-compatible server). All real-provider and physical-device results below are **unverified** until a maintainer records the device, OS, build commit, date, and sanitized result. Do not release based only on mocked tests or a successful model-list request.

| Provider   | Credential                      | Capability                          | Required result                                            | Device/build result |
| ---------- | ------------------------------- | ----------------------------------- | ---------------------------------------------------------- | ------------------- |
| OpenAI     | API key                         | Dictation, uploads, text            | Correct transcript/text with the selected model            | Unverified          |
| Groq       | API key                         | Dictation, uploads, text            | Correct transcript/text with the selected model            | Unverified          |
| OpenRouter | API key                         | Text                                | Discovery/manual model; inference reaches selected model   | Unverified          |
| Custom     | Optional endpoint-bound API key | OpenAI-compatible transcription/text | Discovery/manual model; expected server receives request  | Unverified          |

Not offered on mobile in this release: Anthropic, Gemini, xAI, Mistral, Corti, Tinfoil, Deepgram, AssemblyAI, and Live Meetings over a personal provider. Adding one is a data change in `src/lib/mobileProviders.ts` only when its request shape is the OpenAI-compatible batch/chat protocol; anything else needs its own adapter and device verification.

## Automated validation

Run from `openwhispr-mobile/`: `npm test -- --runInBand`, `npm run typecheck`, `npm run lint`, `npm run format`, the production Expo export, and `python3 modules/background-uploader/tests/run-provider-transport-tests.py`. Record the counts here when they change.

## Credentials and access

- Use Providers while signed out and without Pro. Confirm no OpenWhispr hosted inference or allowance consumption.
- Replace/remove credentials and retry a job. Removal must reject credential reuse; it must not switch provider or model.
- Sign-out keeps personal settings/credentials. Deleting the app does not remove Keychain items; "Remove credential" does.
- Reboot an iPhone, unlock once, lock again, and verify background credential access without a biometric prompt.
- Check valid/invalid keys, rate limits (429), quota (402), missing models (404), timeouts, cancellation, and malformed responses without exposing secrets or provider response bodies in UI/logs.
- Check organization allowlists, unresolved policy, and account changes. Provider requests must remain blocked when policy denies them.

## Privacy, keyboard, and recovery

- Start each workflow with one selection; change settings before completion/retry. The job must keep its original provider, model, endpoint, cleanup, and agent routes.
- Exercise private mode/private-note consent at each stage. No remote stage may bypass privacy because Providers is selected. An On-Device text selection must never reach OpenWhispr Cloud, even after the consent dialog.
- Make transcription succeed and cleanup fail. Retain raw text/audio and show the cleanup failure without calling hosted inference.
- Exercise keyboard recording, imports, explicit retry, suspension, OS termination/relaunch, and user force-quit separately.
- Start a newer keyboard job before an old native upload completes. The older completion must not overwrite current status or insert text twice.
- Force-quit during a keyboard agent command. On relaunch the keyboard must show an agent error, never the spoken instruction inserted as text.
- Toggle Cloud/On-Device on Home while not recording, then confirm dictation, Speech-to-Text and Providers screens agree; the toggle is disabled while recording.
- Record over 25 MB (or import a large file) and confirm the "25 MB provider limit" refusal happens before any upload.

## Network and native gates

- BYOK HTTP uses an ephemeral URLSession with finite UIKit background execution time and a 300 s idle timeout. Apple background URLSessions always follow redirects, so they are not used for direct provider credentials.
- Rebuild iOS after the native provider transport/config plugins change. A build without the native bridge must fail closed, with no JavaScript fetch fallback.
- Verify HTTP 301/302/307/308 responses never forward credentials or audio to another destination, including same-origin redirects. Keep normal TLS certificate validation enabled.
- Check public HTTPS; rejected public HTTP; LAN IP HTTP; `.local`; Tailscale IP and hostname; IPv6 loopback/link-local; unreachable hosts; and denied Local Network permission. Broad private-CIDR and `ts.net` ATS exceptions are not installed; use HTTPS where ATS blocks HTTP.

Record credential types and sanitized outcomes only. Do not attach keys, access tokens, sensitive URLs, transcript content, or raw responses.
```

- [ ] **Step 4: Point the old plan at this one**

At the top of `docs/superpowers/plans/2026-09-21-mobile-byok.md`, after the title line, insert:

```markdown
> **Superseded in part (2026-09-22):** the shipped scope was cut to the OpenAI-compatible providers (OpenAI, Groq, OpenRouter, Custom) without Live Meetings; see `2026-09-22-mobile-byok-cutdown.md`. The provider matrix, streaming protocols and Tinfoil transport described below were removed from the branch and remain future work.
```

- [ ] **Step 5: Format check**

Run from `openwhispr-mobile/`: `npm run format:write` then `npm run format`. Expected: exit 0.

---

### Task 10: Full verification

- [ ] **Step 1: Mobile gates**

From `openwhispr-mobile/`:

```bash
npm test -- --runInBand
npm run typecheck
npm run lint
npm run format
EXPO_NO_DOTENV=1 SENTRY_DISABLE_AUTO_UPLOAD=true OPENWHISPR_APP_ENV=production npx expo export --platform ios --output-dir /private/tmp/claude-501/-Users-chadpiha-Development-openWhispr-openwhispr/8c0329e1-6dfd-4c0c-8b28-9438ebde65d2/scratchpad/expo-export-cutdown
python3 modules/background-uploader/tests/run-provider-transport-tests.py
```

Expected: all exit 0; lint reports no errors (warnings allowed); the export succeeds. `strings` on the exported `.hbc` bundle must not contain `TinfoilTransport` or `inference.tinfoil.sh`.

- [ ] **Step 2: Desktop gates (shared untouched, sanity only)**

From the worktree root: `node --test .github/scripts/ci-scope.test.cjs` and `node --import tsx --test test/shared/ai.test.js`. Expected: pass.

- [ ] **Step 3: Confirm the removals**

```bash
git status --short | grep -c "^D" 
grep -rn "tinfoil\|corti\|deepgram\|assemblyai\|'xai'\|mistral\|anthropic\|gemini" openwhispr-mobile/src openwhispr-mobile/modules openwhispr-mobile/plugins --include='*.ts' --include='*.tsx' --include='*.swift' | grep -v __tests__
```

Expected for the grep: no hits. (The `shared/ai` catalog still lists those providers; that is intended.) Report the exact test counts and any warnings.
