# Local model allow list desktop implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` after approval. Implement task by task and track the checkboxes. Do not commit or push unless separately authorized.

**Execution status (2026-11-02):** Implementation is present on `feat/local-model-allow-list`. Task 4 and the final Desktop/API review passed after all findings were corrected. Main-process, CLI, preview and meeting regression checks pass. See the spec’s implementation record for the complete runtime-specific full-suite results. Native macOS/Windows/Linux managed-device qualification remains outstanding.

**Goal:** Make local-model approvals consistent across desktop choices, downloads, native execution and CLI.

**Architecture:** Extend existing renderer policy rules, reuse those decisions in a main-process lifecycle gate, and gate actual native operations as well as IPC entry points. Preserve personal settings and completed model files when policy changes.

**Tech stack:** Electron, existing CommonJS main helpers, TypeScript/React/Zustand renderer, Node test runner with tsx, existing native ASR and llama servers.

**Spec:** [Approved local models](../specs/2026-11-02-local-model-allow-list-design.md). Paths are relative to desktop. Verified base: `7155b905dddd593e4577cf254eefb64ec7cc55d0`.

## Global constraints

- Fields: `transcription.allowedLocalModels`, `llm.allowedLocalModels`; absent/null is unrestricted, effective `[]` denies all local models in that scope.
- Scope approval does not override disabled Local mode, the app-version floor, or hardware support.
- Main must prove guest/unmanaged status; renderer `idle` alone cannot authorize execution.
- No automatic deletion of completed files, policy-driven saved-preference changes, large downloads, or remote fallback.
- Preserve BYOK/LAN behavior and all existing audio feature gates.
- No package installation, environment-file edits, commits, pushes or new branches in this plan.
- Native behavior must be qualified on macOS, Windows and Linux; unit tests alone do not establish native compatibility.

## Review focus

1. An already-running native server must not bypass a newer restriction (Tasks 2–3).
2. Credential changes and offline startup must not borrow another identity's approvals (Task 2).
3. Blank and inherited model settings must not fall through to engine defaults (Tasks 1 and 3).
4. Hidden families and legacy models must not hide installed files' Delete action (Task 4).
5. Policy errors must survive retries, streaming, IPC serialization and CLI mapping (Tasks 3 and 5).

## Task 1: Policy rules and final model selections

**Files:** Modify `src/types/policy.ts`, `src/helpers/policyValidation.js`, `src/stores/{policyRules,settingsStore}.ts`, `src/services/{reasoningPolicy,ReasoningService}.ts`, `src/components/chat/useChatStreaming.ts`, and local-selection callers found by `rg`. Review `src/stores/enterpriseIdentityStore.ts` callers without changing enterprise behavior.

**Tests:** Extend `test/helpers/{policyValidation,policyRules,policyEffectiveSettings,policyPreferencePreservation}.test.js`, `test/stores/policyEffectiveVisionOverride.test.js`, and `test/services/reasoningPolicyRestriction.test.js` where applicable.

**Interfaces:**

- `allowedLocalModelIds(state: PolicyDecisionSnapshot, scope: PolicyScope): string[] | null` filters unknown IDs without broadening to null.
- `isLocalModelAllowedByPolicy(state: PolicyDecisionSnapshot, scope: PolicyScope, modelId: string): boolean` checks known nonempty ID, current policy state, version, Local mode and approval.
- `filterLocalModelOptionsByPolicy<T extends { id: string }>(options: T[], scope: PolicyScope, state: PolicyDecisionSnapshot): T[]` supplies eligible choices, not the installed-file inventory.
- Add `model?: string` to existing selection types for compatibility; for `mode === "local"`, missing/blank `model` is always denied.
- Extend `assertReasoningAllowedByPolicy(provider: string, mode: InferenceMode, model?: string): void` and pass the resolved model from every local dispatch caller.

- [ ] Add decision tests for guest/unmanaged/idle/loading/error/managed/version states; both scopes; null, empty, known and unknown-only lists; disabled Local; missing/blank ID; and wrong-scope ID. Verify one-time unknown-ID warnings and required-list pruning.
- [ ] Add settings tests for dictation/meeting/upload local model keys, follow-default contexts, all LLM scopes, optional overrides and inherited config. Assert the effective denied model is inert, raw preferences unchanged, and the final dispatch guard catches fallback resolution.
- [ ] Add a reasoning test that passes a real blocked model through the service, rather than only calling the predicate. Assert no IPC or network dispatch and no conversion to a different provider.
- [ ] Run targeted tests and establish their failures, then add fields/default-compatible validation and rule helpers using the registry JSON already imported by `policyRules.ts`.
- [ ] Update `getTranscriptionSelection` to carry the model each context will actually dispatch. Read its local provider/model fields, not the cloud-model field in `TRANSCRIPTION_CONTEXT_KEYS`. Add policy clamping for those local fields and each resolved LLM scope after existing mode/provider resolution.
- [ ] Thread actual models through reasoning/chat guards. Retain existing nonlocal behavior. Treat an empty local model as denied before manager defaults or inherited fallback can run.
- [ ] Run targeted suites with `node --import tsx --test <test paths above>` and `npm run typecheck`; all changed local-selection call sites must compile and behavior tests must pass.

## Task 2: Main policy identity and revocation lifecycle

**Files:** Create `src/helpers/localModelPolicyGate.js`, `test/helpers/localModelPolicyGate.test.js`. Modify `src/helpers/ipcHandlers.js` at manager setup, policy broadcasts, policy fetch IPC, token changes and account-scope transitions. Extend `test/helpers/workspacePolicyManager.test.js` only if its existing contract needs additional coverage; do not invent another cache.

**Interfaces:** New `createLocalModelPolicyGate({ getPolicy, peekPolicy, getAppVersion, getIdentity, onRevoked })` returns:

- `authorize(scope, modelId, { memoryOnly = false } = {}): Promise<LocalModelPolicyLease>`; typed denial otherwise. A lease has captured identity/epoch and `signal: AbortSignal`.
- `assertCurrent(lease): void`; rejects if a newer denial or identity change invalidates the lease.
- `release(lease): void`; removes completed work from tracking.
- `update(snapshot): void`; accepts current-identity, non-regressing revisions and aborts prohibited leases.
- `invalidate(): void`; blocks new work until current identity resolves; account transition wiring explicitly cancels old jobs.

Define/document these contracts with JSDoc and reuse the dynamically imported `policyRules.ts` decision as existing main enterprise enforcement does. Main-owned identity resolution distinguishes guest, signed-in unsettled, and resolved policy; do not expose this decision as a renderer argument. `memoryOnly` authorization never fetches.

- [ ] Test the identity matrix with mocked lookup: proven guest; unmanaged; managed allow/deny; Local off; below floor; lookup failure; matching cache; signed-in with no cache; bearer and cookie identity; unresolved offline binding.
- [ ] Test delayed responses, token rotation/account switch, wrong-generation broadcast, stale revision, lease revocation, safe release, and memory-only warm-up with no snapshot. Assert a denied action invokes no operation callback.
- [ ] Test refresh behavior through `workspacePolicyManager`: no extra per-chunk network fetch, existing five-minute freshness and last-good matching cache retained. Do not interpret an exception as guest.
- [ ] Implement the adapter and bind broadcasts/cached `get-workspace-policy` results alongside `_audioFeaturePolicy`. Install the default-deny unresolved gate before any model warm-up can execute. Reuse existing main auth/account helpers instead of adding a new credential store.
- [ ] Wire revocation callbacks to affected jobs and manager shutdown. On account change, abort old work before applying a guest/new-account snapshot. On rotation, deny new work until resolved and revalidate old work at subsequent boundaries; never authorize with a different identity's snapshot.
- [ ] Run `node --import tsx --test test/helpers/localModelPolicyGate.test.js test/helpers/workspacePolicyManager.test.js test/helpers/audioFeaturePolicy.test.js` and require zero failures.

## Task 3: Guard download, native load and native reuse boundaries

**Files:** Modify `src/helpers/{whisper,whisperServer,parakeet,parakeetServer,parakeetWsServer,modelManagerBridge,llamaServer,ipcHandlers}.js` and `main.js`. Add `test/helpers/localModelPolicyEnforcement.test.js`; extend the existing streaming/wake/server tests only where those paths change.

**Interfaces:** Inject the Task 2 gate into the existing managers. Internal local operations carry a canonical `{ scope, modelId }` plus a lease; path-based native entry points verify the registry-derived path belongs to that identity. Native inference/stream work must check the lease even when start returns early for an already-ready server. External IPC signatures remain compatible; error results gain the spec's stable codes.

- [ ] Add integration tests with mocked download/network/spawn functions. Denied Whisper/Parakeet/GGUF operations must make **zero** download and native-dispatch calls. Repeat with servers already marked ready.
- [ ] Add specific regressions for Whisper `_runServerTranscription`, startup direct start, wake/GPU restart; Parakeet `transcribe`, online stream, download-completion warm-up; GGUF prewarm, inference/context retries, and companion draft transfer. Test canonical path/model mismatches and preserve explicit LAN execution.
- [ ] Add mid-flight revocation tests at download, extraction/load, server-ready, inference, streaming frame and result/activation boundaries. Assert cancellation, no next chunk/draft request, no late result, loaded prohibited server stopped, and completed files still exist. Incomplete artifacts use existing cancellation cleanup only.
- [ ] Run tests to observe failures before wiring gates. Inventory all `.start`, `.startServer`, native inference and stream paths with `rg`; record each caller covered by a test rather than assuming the high-level start methods dominate the graph.
- [ ] Gate at manager download entry points and before actual native load/reuse. Add explicit nonempty-model guards before implicit `base`/Parakeet defaults can apply to managed requests. Scope local-only enforcement so native LAN transport does not inherit a local catalog check.
- [ ] Propagate signals/current-lease checks through existing segmentation, inference and streaming. On revocation stop the affected native process, end the stream and suppress results. Connect policy-stopped meetings to existing stop/recovery behavior while retaining audio.
- [ ] Keep background warm-ups memory-only and best-effort. Foreground requests may resolve policy. Preserve typed refusal codes through catches instead of rewriting them as server failure; prevent GPU/provider fallback on these errors.
- [ ] Run the new enforcement suite plus `test/helpers/{parakeetOnlineStream,parakeetServer,whisperWakeRewarm,whisperCudaRequestFallback,llamaServerContext}.test.js` and applicable service routing tests. Require passing tests before broad UI changes.

## Task 4: Pickers, setup and pending downloads

**Files:** Modify `src/components/{TranscriptionModelPicker,ReasoningModelSelector,LocalModelPicker}.tsx`, `src/components/ui/ModelCardList.tsx` if needed for Delete-only rows, `src/components/onboarding/{ProviderSetupStep,BackgroundModelDownloadTray}.tsx`, `src/components/onboarding/{setupEligibility,pendingLocalModels}.ts`, `src/hooks/useModelDownload.ts`, `src/hooks/useRequiredLocalModels.ts` only if needed beyond rule pruning, and all 11 `src/locales` directories.

**Tests:** Extend `test/components/{localModelSetupStep,onboardingFlow,setupEligibility,localModelPickerLegacy,transcriptionModelPickerCheck,reasoningModelSelectorCheck}.test.js`, `test/helpers/pendingLocalModels.test.js`; add behavior coverage using the existing renderer harness where source-contract tests are insufficient.

**Interfaces:** Eligible option lists use Task 1 helpers. Installed-model inventory remains unfiltered so disallowed files are deletable. Setup availability additionally consumes device-supported local speech and LLM option sets. Pending activation consumes current policy at completion, not the policy at enqueue time.

- [ ] Add behavior tests for approved/not-downloaded, approved/downloaded, disallowed/not-downloaded, disallowed/downloaded, legacy/downloaded, no approved model, and a family containing only disallowed installed models.
- [ ] Test onboarding speech-only versus speech-plus-AI needs, unsupported device models, blocked Orukeet default, policy changes during download, and required model pruning. Assert no implicit download and no raw preference writes after policy restriction.
- [ ] Implement filtered selectable options plus Delete-only installed rows. Preserve usable family navigation. Add explicit no-approved/resolve-policy states and approved-model guidance.
- [ ] Update initial onboarding selection using existing recommendation order intersected with approvals and capabilities. Do not reselect blocked saved preferences automatically; offer an explicit approved selection. Recheck pending activation and surface download policy errors without generic retries.
- [ ] Add translated copy for approved guidance, not approved, no supported approvals, empty workspace intersection, blocked download/model/mode, and unresolved/version states. Reuse existing policy copy where accurate.
- [ ] Run affected tests, `npm run typecheck`, and `npm run i18n:check`; verify required-download and preference-preservation suites still pass.

## Task 5: CLI, cross-repository contract and release QA

**Files:** Modify `src/helpers/cliBridge.js` and its use of `src/helpers/localTranscriptionModels.js`; extend `test/helpers/cliBridgeTranscribe.test.js` and `test/helpers/localTranscriptionModels.test.js`. Keep raw inventory available to Settings; filter only the CLI's exposed list with a resolved snapshot.

**Interfaces:** `GET /v1/transcribe/models` becomes async and exposes only allowed catalog entries, retaining provider/downloaded/default fields. `POST /v1/transcribe` authorizes requested/default model before dispatch and retains upload-feature gating. Policy denial maps to the existing HTTP 403 `forbidden` envelope.

- [ ] Test list filtering, Local off, empty intersection, unresolved signed-in state, explicit blocked ID, blocked configured default, missing installed model, allowed explicit choice, and simultaneous upload-feature denial. Do not report blocked known IDs merely as unknown input or switch defaults silently.
- [ ] Implement CLI authorization using the same main gate and extend its error classifier without weakening existing audio denials. Test handler and HTTP serialization behavior.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run i18n:check` in the authorized execution checkout. The planning baseline is not a substitute for these post-change checks.
- [ ] With API Task 1–3 complete, QA fresh setup and existing user on a managed workspace: Settings, meeting/upload controls, note/agent scopes, direct DevTools downloads, all three server starts, CLI, offline restart, revocation during downloads and active stream, token/account changes, and reapproval. Repeat native paths on each supported OS; retain completed files.
- [ ] Verify a supported desktop against an older API remains unrestricted, and a current API's unknown-only list grants no model. Verify old desktop behavior to document the actual minimum-version limitations.
- [ ] Record the qualifying desktop release number for API/admin `LOCAL_MODEL_POLICY_MIN_VERSION`. Publish/rollout only with separate authorization.
