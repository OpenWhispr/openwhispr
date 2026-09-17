# Bedrock Error-Handling Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all six review findings on the Bedrock error-handling branch with cancellable requests, production-shaped AWS diagnostics, accurate region guidance, and truthful paste fallback state.

**Architecture:** Reuse the existing sender/request registry for single-shot enterprise cleanup, make Bedrock retry waits abort-aware, and apply a per-attempt application timeout. Resolve credential providers before the AI SDK wraps their errors, pass the resolved runtime region to error mapping, and replace the paste IPC's implicit success contract with an explicit `pasted` outcome.

**Tech Stack:** Electron IPC, TypeScript, JavaScript, Vercel AI SDK 6, `@ai-sdk/amazon-bedrock` 4, AWS SDK v3, Node test runner, React renderer.

**Spec:** `docs/superpowers/specs/2026-09-01-bedrock-error-handling-review-fixes-design.md`

## Global Constraints

- Bedrock retry policy remains six total attempts with exponential backoff and random jitter for 503, 429, timeout, and audited safe-network failures only.
- Authentication, permission, invalid-model, configuration, and user-cancellation failures are never automatically retried.
- AWS requests remain in the resolved/requested region; no region failover is permitted.
- `RetryError.lastError`, HTTP status, AWS exception type, AWS request ID, and underlying error fidelity must remain intact.
- The exact existing 503, 429, and timeout primary message strings must remain byte-for-byte unchanged.
- “Original dictation pasted without AI cleanup.” appears only after the original text was actually pasted following cleanup failure.
- The fallback status remains visually quieter and separate from the primary AWS error, and never appears for connection tests, eventual cleanup success, disabled auto-paste, failed/no-op paste, translation, Agent, or selection-edit failure.
- Technical details remain expandable/copyable.
- Preserve Azure, Vertex, Agent streaming, translation, selection-edit, and non-cleanup dictation behavior.
- Follow strict TDD: add each regression test, observe its expected failure, then make the smallest production change that passes it.

---

### Task 1: Abortable Bedrock request lifecycle

**Files:**
- Modify: `src/helpers/enterpriseProviderErrors.js`
- Modify: `src/helpers/ipcHandlers.js`
- Modify: `src/services/ReasoningService.ts`
- Modify: `preload.js`
- Modify: `src/types/electron.ts`
- Modify: `test/helpers/bedrockRequestPolicy.test.js`
- Modify: `test/helpers/bedrockEnterpriseIpc.test.js`
- Modify: `test/helpers/preloadAuthBridge.test.js`

**Interfaces:**
- Consumes: `AgentStreamRequestRegistry.begin(senderId, requestId)`, `.complete(...)`, and `.cancelSender(senderId)`.
- Produces: `runBedrockRequest(operation, { signal, ...retryOptions })`, where `signal` aborts before an attempt and during backoff.
- Produces: `window.electronAPI.cancelEnterpriseReasoning(): void`, forwarded as `enterprise-reasoning-cancel`.
- Preserves: `processEnterpriseReasoning(...)` result shape and every non-Bedrock request path.

- [ ] **Step 1: Add failing retry-policy cancellation tests**

Add a test that starts `runBedrockRequest` with a retryable 503, waits until its injected sleep begins, aborts the supplied controller, and asserts rejection with the abort reason, one operation attempt, and no later retry. The production mutation this catches is a retry delay that ignores cancellation.

```js
const controller = new AbortController();
let attempts = 0;
let releaseSleep;
const sleeping = new Promise((resolve) => (releaseSleep = resolve));
const request = runBedrockRequest(
  async () => {
    attempts += 1;
    throw awsError({ name: "ServiceUnavailableException", status: 503 });
  },
  {
    signal: controller.signal,
    random: () => 0.5,
    sleep: async (_delay, signal) => {
      releaseSleep();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  }
);
await sleeping;
controller.abort();
await assert.rejects(request, (error) => error?.name === "AbortError");
assert.equal(attempts, 1);
```

- [ ] **Step 2: Run the focused retry test and observe RED**

Run: `node --import tsx --test test/helpers/bedrockRequestPolicy.test.js`

Expected: the cancellation test fails because `runBedrockRequest` neither accepts nor checks `signal`, and its delay cannot be interrupted.

- [ ] **Step 3: Make the Bedrock retry loop abort-aware**

Extend `runBedrockRequest` with an optional `signal`. Check `signal?.throwIfAborted()` before every operation, check again in the catch before classification, and pass the signal into the delay. The default delay must remove its abort listener on both resolution and rejection and reject with `signal.reason` when cancelled.

```js
async function runBedrockRequest(operation, options = {}) {
  const { signal, sleep = sleepWithAbort, ...retryOptions } = options;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      signal?.throwIfAborted();
      // existing classification and six-attempt ceiling
      await sleep(delay, signal);
    }
  }
}
```

- [ ] **Step 4: Add failing IPC timeout and cancellation tests**

Extend the IPC harness so `ipcMain.on` listeners are captured and sender fakes expose an integer `id`, `once`, `removeListener`, and `isDestroyed`. Add:

1. A “Check connection” test with a small `timeoutMs` whose fake `generateText` waits for `options.abortSignal` and rejects with that signal's timeout reason. Assert six attempts and the exact existing timeout message.
2. A cleanup test that starts a Bedrock request, fires `enterprise-reasoning-cancel` for the same sender while the first attempt is pending or in backoff, and asserts its signal aborts without a second attempt.
3. A preload bridge test asserting `cancelEnterpriseReasoning()` sends `enterprise-reasoning-cancel`.

The production mutations caught are omission of the application timeout, omission of main-process cancellation, sender-crossing cancellation, and cancellation that still retries.

- [ ] **Step 5: Run the IPC/preload tests and observe RED**

Run: `node --import tsx --test test/helpers/bedrockEnterpriseIpc.test.js test/helpers/preloadAuthBridge.test.js`

Expected: timeout signal/cancellation bridge assertions fail because neither exists.

- [ ] **Step 6: Register and propagate enterprise cancellation**

Instantiate a dedicated `AgentStreamRequestRegistry` for single-shot enterprise reasoning. For Bedrock cleanup, begin a request with the renderer sender ID and a generated UUID, attach sender destruction to `cancelSender`, and combine its controller signal with a fresh per-attempt timeout signal. Pass the request controller signal to `runBedrockRequest`, and complete only that controller in `finally`.

Register `ipcMain.on("enterprise-reasoning-cancel", ...)` to cancel only the sending renderer's enterprise requests. Forward it from preload and declare `cancelEnterpriseReasoning?: () => void` in `src/types/electron.ts`. Call it from `ReasoningService.cancelAllRequests()` beside `cancelCloudReason()`.

For “Check connection,” give every Bedrock attempt a fresh bounded `AbortSignal.timeout(config?.timeoutMs || 30_000)` while preserving `maxRetries: 0` and the outer six-attempt policy. Do not change Azure or Vertex connection behavior.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `node --import tsx --test test/helpers/bedrockRequestPolicy.test.js test/helpers/bedrockEnterpriseIpc.test.js test/helpers/preloadAuthBridge.test.js test/helpers/audioManagerCancelLifecycle.test.js test/services/enterpriseInferenceErrors.test.js`

Expected: all pass with no new warnings.

- [ ] **Step 8: Run static checks and commit**

Run: `npm run typecheck && npm run lint`

Commit only the named task files:

```bash
git add src/helpers/enterpriseProviderErrors.js src/helpers/ipcHandlers.js src/services/ReasoningService.ts preload.js src/types/electron.ts test/helpers/bedrockRequestPolicy.test.js test/helpers/bedrockEnterpriseIpc.test.js test/helpers/preloadAuthBridge.test.js
git commit -m "fix(enterprise): cancel Bedrock cleanup requests"
```

---

### Task 2: Preserve real AWS credential errors and resolved region

**Files:**
- Modify: `src/helpers/enterpriseAiProviders.js`
- Modify: `src/helpers/enterpriseProviderErrors.js`
- Modify: `src/helpers/ipcHandlers.js`
- Modify: `test/helpers/enterpriseAiProviders.test.js`
- Modify: `test/helpers/bedrockRequestPolicy.test.js`
- Modify: `test/helpers/bedrockEnterpriseIpc.test.js`

**Interfaces:**
- Consumes: resolved enterprise runtime `{ provider, model, apiKey, enterprise }`.
- Produces: asynchronous `getEnterpriseAIModel(provider, model, apiKey, enterprise): Promise<LanguageModel>`.
- Produces: Bedrock models built from already-resolved access key, secret, and optional session token when a profile or managed credential provider is used.
- Preserves: manual static-key behavior and Azure/Vertex model construction semantics.

- [ ] **Step 1: Add failing production-shaped credential tests**

In `enterpriseAiProviders.test.js`, create an AWS-shaped error carrying `name`, `$metadata.httpStatusCode`, `$metadata.requestId`, and `cause`. Supply a `managedCredentialProvider` that throws that exact object and assert `await getEnterpriseAIModel(...)` rejects with the same object identity. Add a successful credential-provider case and assert the resulting real Bedrock model can reach its fetch boundary without invoking the credential provider again.

Update existing Azure tests to `await getEnterpriseAIModel(...)`; assert their request URLs and authorization headers remain unchanged.

The production mutation caught is passing the provider into `@ai-sdk/amazon-bedrock`, whose installed implementation replaces the original error with a plain `Error`.

- [ ] **Step 2: Run the provider tests and observe RED**

Run: `node --import tsx --test test/helpers/enterpriseAiProviders.test.js`

Expected: original error identity/metadata are lost at the installed AI SDK credential-provider boundary.

- [ ] **Step 3: Resolve Bedrock credentials before AI SDK construction**

Make `getEnterpriseAIModel` and `createBedrockModel` async. Await managed/profile credential providers before calling `createAmazonBedrock`, then pass the resolved `accessKeyId`, `secretAccessKey`, and optional `sessionToken` as static provider options. Keep manual static keys and environment fallback unchanged. Update all three `ipcHandlers.js` call sites to await model creation.

```js
async function createBedrockModel(model, enterprise) {
  const region = enterprise?.bedrockRegion || "us-east-1";
  const credentials = enterprise?.managedCredentialProvider
    ? await enterprise.managedCredentialProvider()
    : enterprise?.bedrockProfile
      ? await fromNodeProviderChain({ profile: enterprise.bedrockProfile })()
      : null;
  return createAmazonBedrock({
    region,
    ...(credentials
      ? {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
        }
      : existingManualCredentialOptions),
  })(model);
}
```

- [ ] **Step 4: Add failing managed-region and managed-expiry IPC tests**

Have the IPC harness resolve a managed Bedrock runtime in `us-west-2` while the renderer config contains another/no region. Throw permission/model/configuration failures and assert mapped copy names `us-west-2`. Throw an `ExpiredTokenException` from the managed credential provider and assert the response preserves status/type/request ID, gives managed sign-in guidance, and does not return an `aws sso login --profile default` command.

The production mutations caught are mapping against stale renderer configuration and treating managed temporary credentials as a manual AWS profile.

- [ ] **Step 5: Add failing safe-network shape tests**

Add table cases for `ENETDOWN`, `EHOSTDOWN`, `UND_ERR_HEADERS_TIMEOUT`, and `UND_ERR_BODY_TIMEOUT` through an `AI_APICallError` cause chain. Assert each retries; assert the two Undici timeout codes map to the exact timeout message while host/network-down codes map to the network message.

- [ ] **Step 6: Run mapping/IPC tests and observe RED**

Run: `node --import tsx --test test/helpers/bedrockRequestPolicy.test.js test/helpers/bedrockEnterpriseIpc.test.js`

Expected: missing codes fail retry/timeout classification, and managed errors name the renderer/default region or profile.

- [ ] **Step 7: Carry runtime context and complete classifications**

Retain each resolved runtime outside its handler `try` so the catch can merge only the actual `bedrockRegion` into mapping context. In `mapBedrockError`, branch expired-token guidance on `config.managedContext`: managed access tells the user to sign out and sign back in to refresh company access and exposes no CLI command; manual profile access retains the existing `aws sso login --profile <profile>` guidance.

Add `ENETDOWN` and `EHOSTDOWN` to safe network failures. Add `UND_ERR_HEADERS_TIMEOUT` and `UND_ERR_BODY_TIMEOUT` to both the safe audited transport list and timeout classification so they retain the exact timeout message.

- [ ] **Step 8: Run focused regression tests and verify GREEN**

Run: `node --import tsx --test test/helpers/enterpriseAiProviders.test.js test/helpers/bedrockRequestPolicy.test.js test/helpers/bedrockEnterpriseIpc.test.js test/services/enterpriseInferenceErrors.test.js test/services/managedEnterpriseRouting.test.js`

Expected: all pass with the original exact 503/429/timeout strings and unchanged Azure tests.

- [ ] **Step 9: Run static checks and commit**

Run: `npm run typecheck && npm run lint`

Commit only the named task files:

```bash
git add src/helpers/enterpriseAiProviders.js src/helpers/enterpriseProviderErrors.js src/helpers/ipcHandlers.js test/helpers/enterpriseAiProviders.test.js test/helpers/bedrockRequestPolicy.test.js test/helpers/bedrockEnterpriseIpc.test.js
git commit -m "fix(enterprise): preserve Bedrock credential diagnostics"
```

---

### Task 3: Report cleanup fallback only after a real paste

**Files:**
- Modify: `src/helpers/ipcHandlers.js`
- Modify: `src/helpers/audioManager.js`
- Modify: `preload.js`
- Modify: `src/types/electron.ts`
- Create: `test/helpers/ipcPasteOutcome.test.js`
- Modify: `test/helpers/audioManagerCleanupFallback.test.js`
- Modify: `test/helpers/useAudioRecordingCleanupFallback.test.js`

**Interfaces:**
- Produces: `paste-text` / `window.electronAPI.pasteText(...) => Promise<{ success: true; pasted: boolean }>`.
- Produces: `AudioManager.safePaste(...) => Promise<boolean>`, true only when `pasted === true`.
- Preserves: callers that intentionally ignore the paste result and the selection-edit replacement contract.

- [ ] **Step 1: Add failing main-process paste outcome tests**

Build a focused IPC handler harness that invokes the real `paste-text` handler. Assert an active onboarding demo returns `{ success: true, pasted: false }` without calling `clipboardManager.pasteText`, while a normal successful paste returns `{ success: true, pasted: true }` after exactly one clipboard paste.

The production mutation caught is treating a no-op handler resolution as proof text reached another application.

- [ ] **Step 2: Add failing renderer paste/fallback tests**

In the AudioManager test, return `{ success: true, pasted: false }` from the real preload-shaped `pasteText` mock and assert `safePaste` returns false. Keep the hook-level assertion that a false paste does not record cleanup failure, and add a structured-result success case so `{ success: true, pasted: true }` remains the only path that records the fallback after paste.

- [ ] **Step 3: Run focused tests and observe RED**

Run: `node --import tsx --test test/helpers/ipcPasteOutcome.test.js test/helpers/audioManagerCleanupFallback.test.js test/helpers/useAudioRecordingCleanupFallback.test.js`

Expected: onboarding reports implicit success and `safePaste` returns true for the no-op result.

- [ ] **Step 4: Implement the explicit paste contract**

Return `{ success: true, pasted: false }` from the onboarding branch and `{ success: true, pasted: true }` only after `clipboardManager.pasteText` resolves. Update the TypeScript declaration from `Promise<void>` to the structured result. Keep preload as a transparent forwarder.

Update `safePaste` to require the affirmative result:

```js
const result = await window.electronAPI.pasteText(text, options);
return result?.pasted === true;
```

Do not change selection-edit behavior or toast rendering.

- [ ] **Step 5: Run focused regression tests and verify GREEN**

Run: `node --import tsx --test test/helpers/ipcPasteOutcome.test.js test/helpers/audioManagerCleanupFallback.test.js test/helpers/useAudioRecordingCleanupFallback.test.js test/helpers/cleanupFailureToast.test.js test/helpers/audioManagerCancelLifecycle.test.js`

Expected: all pass; no fallback is recorded for onboarding no-op, disabled auto-paste, or failed paste.

- [ ] **Step 6: Run static checks and commit**

Run: `npm run typecheck && npm run lint`

Commit only the named task files:

```bash
git add src/helpers/ipcHandlers.js src/helpers/audioManager.js preload.js src/types/electron.ts test/helpers/ipcPasteOutcome.test.js test/helpers/audioManagerCleanupFallback.test.js test/helpers/useAudioRecordingCleanupFallback.test.js
git commit -m "fix(dictation): report only completed fallback pastes"
```

---

### Final verification

- [ ] Run all focused Bedrock, enterprise, cancellation, paste, fallback-toast, and managed-routing tests.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run format:check`.
- [ ] Run `npm run build:renderer`.
- [ ] Run `npm test`; compare any failure to the baseline ledger and rerun the complete affected file separately.
- [ ] Dispatch one fresh whole-branch code reviewer against `abfaf2ba010a7a122a70eb7ec4541324eebaf33d..HEAD` and the complete requirements.
