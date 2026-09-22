# Mobile BYOK implementation plan

**Goal:** Deliver desktop-style personal bring-your-own-key support across existing mobile workflows, starting with iOS.

**Architecture:** Desktop and mobile consume a small, dependency-free shared AI core. Each application owns its credentials, network transports, lifecycle, and UI. Mobile calls providers directly and keeps credentials in Keychain.

**Tech stack:** Existing Electron/TypeScript desktop application; Expo SDK 55, React Native, TypeScript, Zustand, SecureStore, and native Swift mobile modules. Keep separate application dependencies, lockfiles, and release processes.

**Spec:** The agreed product behavior and constraints are recorded below; this document replaces the earlier standalone-mobile plan in this task.

**Execution:** Use the executing-plans skill for implementation and code-quality for review. Check existing tests before editing code. Do not commit, push, modify `.env`, or install dependencies without explaining what is being installed and why.

## Repository baseline and changes to the original plan

- Repository: `OpenWhispr/openwhispr`. Mobile is the nested `openwhispr-mobile/` application, imported in PR #2279. Do not implement this feature in the former standalone mobile repository.
- Planning worktree: `/Users/chadpiha/Development/openWhispr/worktrees/mobile-byok`, branch `feat/mobile-byok`, created from freshly fetched `origin/main` at `ea122650006f13b4438ffeb382ebecc53493765e`.
- Use desktop and mobile from this same revision as the reference. The previous standalone-mobile baseline `fa37e781` and desktop snapshot `f21c4911` are superseded.
- Share portable provider definitions and behavior instead of copying them into mobile. Do not introduce npm workspaces, merge lockfiles, or restructure unrelated desktop code.
- Shared changes must trigger both applications' validation. The current CI classifier treats an arbitrary root `shared/` path as desktop-only; fix that before introducing shared runtime imports.
- The import does not remove the need for native iOS credentials, keyboard recovery, provider streaming implementations, or Tinfoil attestation.

## Agreed product behavior

- Add **Providers** alongside OpenWhispr Cloud and On-Device. BYOK requires neither an OpenWhispr account nor Pro and does not consume OpenWhispr Cloud allowance. Cloud inference and sync keep their existing requirements.
- Provide independent selections for dictation/keyboard, uploads, meeting transcription, cleanup, note formatting, and agent/chat intelligence. Route title generation with note formatting.
- Match desktop provider IDs, model defaults, remembered selections, and per-workflow capabilities. Provider credentials may be reused across scopes; custom credentials belong to their configured endpoint.
- Support masked credential entry, replacement, removal, connection testing, provider key-creation links, and actionable validation errors. Explain that the provider bills usage separately.
- Support custom OpenAI-compatible endpoints, optional credentials, model discovery, and manual model IDs. Preserve the existing desktop URL normalization and private-host rules: HTTPS for any host, HTTP only for recognized private-network hosts, including LAN addresses, loopback, `.local`, and Tailscale hosts. Public HTTP is rejected.
- Explain that `localhost` on an iPhone refers to the iPhone. Handle local-network permission denial explicitly.
- Snapshot routes at job start. Never silently change provider, endpoint, or model during execution, retry, or recovery. Removing a credential blocks reuse of its reference rather than falling back to another provider.
- Private mode and private-note protections override remote selections. Sending protected content remotely requires the existing explicit consent flow. BYOK is remote inference, not on-device processing.
- Successful raw transcription survives cleanup failure. Report the skipped or failed cleanup; missing configuration must never silently send text to OpenWhispr Cloud.
- Keep personal BYOK settings and credentials through sign-out. Explicit credential removal and full app-data reset erase credentials and invalidate cached tokens/clients. Do not sync credentials.
- Launch on iOS first while preserving existing Android behavior. Enterprise provider setup, additional local engines, and desktop-only features are outside this plan.

| Capability    | Coverage                                                                         |
| ------------- | -------------------------------------------------------------------------------- |
| Transcription | OpenAI, Groq, xAI, Mistral, Gemini, Corti, Tinfoil, Deepgram, AssemblyAI, Custom |
| Live meetings | OpenAI, AssemblyAI, Deepgram, Corti, Tinfoil                                     |
| Text AI       | OpenAI, Anthropic, Gemini, Groq, OpenRouter, Tinfoil, Corti, Custom              |

Apply desktop's actual capability restrictions: Deepgram and AssemblyAI are streaming-only in its implementation; Gemini Live supports dictation, not meetings. Upload pickers exclude unsupported combinations. Custom support means the existing OpenAI-compatible batch/text protocols, not arbitrary realtime protocols.

## Implementation sequence

### 1. Establish the shared AI core and build coverage

**Location:** `shared/ai/` at the repository root. Use plain TypeScript and JSON without React, Electron, Node built-ins, React Native, stores, filesystem access, or network side effects. No new package manager or published package.

**Interfaces:** Export provider IDs and capability types, static catalogs, model default selection, endpoint validation, and pure route-selection functions. Resolvers accept explicit scope, selection, capability, privacy, and policy inputs; they return a selected route or a typed refusal. Routes carry credential references, never credentials.

- [x] Add CI-classification tests proving `shared/ai/**` selects desktop, mobile, and desktop build checks. Preserve mobile-only and desktop-only routing for unrelated paths. Update `.github/scripts/ci-scope.cjs` accordingly.
- [x] Extract static BYOK catalog data from `src/models/modelRegistryData.json`, model-default rules from `src/models/providerDefaultModel.ts`, and reusable endpoint rules from `src/utils/urlUtils.ts`. Preserve existing desktop import surfaces with thin adapters where needed.
- [x] Extract only portable capability/routing decisions from the transcription and meeting helpers. Do not import `ModelRegistry.ts`, `settingsStore`, or Electron helpers into mobile: those modules contain application dependencies and initialization behavior.
- [x] Keep dynamic catalog refresh, settings persistence, and platform availability in application adapters. Preserve desktop model defaults, ordering, and custom-model behavior through characterization tests.
- [x] Configure mobile Metro to watch the explicit shared directory while continuing to resolve React/React Native from mobile's dependency tree. Configure Jest transformation and TypeScript resolution for the same source. Do not expose the desktop dependency tree as a general mobile search path.
- [x] Include shared source in desktop typechecking/lint coverage and in Electron packaging where main-process runtime imports require it. Validate renderer bundling and packaged main-process resolution.
- [x] Ensure shared code is covered by the existing CodeQL configuration and both application CI paths. Verify EAS build archives include shared source, and Expo export resolves it from a clean checkout.

**Acceptance:** Existing desktop consumers retain behavior; both test runners can import the core without native dependencies; shared-only changes run both CI paths; mobile bundling and desktop packaging resolve shared files. Use one canonical set of fixture cases across both consumers.

### 2. Migrate mobile settings and implement route resolution

**Primary integration points:** `openwhispr-mobile/src/types/index.ts`, configuration/processing-mode stores, `src/lib/inferenceModes.ts`, and existing workflow callers.

- [x] Extend inference selections with Providers, typed workflow scope, provider/model selection, custom endpoint configuration, and credential reference. Keep secrets out of ordinary state persistence.
- [x] Separate workflow inference selection from privacy enforcement. Preserve current Cloud/On-Device behavior when migrating existing configuration; do not opt existing users into a new remote route.
- [x] Resolve and snapshot a route at operation start. Store sufficient non-secret metadata for retry and recovery; reject unsupported combinations before capturing or transmitting content.
- [x] Update guest-mode guards and account/usage gates so configured BYOK works without a user session. Continue gating OpenWhispr Cloud requests and sync as before.
- [x] Apply existing workspace policy before authenticated users make direct requests. Use account-scoped last-good policy and desktop's fail-closed unresolved-policy behavior. Signed-out personal use requires no policy request. Providers absent from a managed allowlist remain denied.

**Acceptance:** Migration, independent scope selection, private-note protection, signed-out BYOK, managed restrictions, and configuration changes during active jobs are covered by tests. Existing Cloud and local tests still pass.

### 3. Implement credentials and provider execution

**Location:** Mobile-owned credential and provider service modules under `openwhispr-mobile/src/services/`; native support under `openwhispr-mobile/modules/` where required.

- [x] Use the existing SecureStore dependency for device-local keys. On iOS, configure Keychain access for background operation after first unlock and disable migration of credential items to another device. Do not require an interactive biometric prompt for each background request.
- [x] Implement save, lookup, replace, remove, and reset operations. Expose presence/status to UI state, keep runtime secrets short-lived, and invalidate cached tokens/clients after credential changes.
- [x] Implement provider HTTP and streaming adapters with existing transport primitives. Reuse shared request-independent rules, but keep authentication, request execution, native lifecycle handling, and response parsing platform-specific.
- [x] Preserve provider-specific request formats, audio limits, model options, and Corti credential/token lifecycle from desktop. Request only the scopes needed for the relevant Corti operation.
- [ ] Add the Tinfoil Swift verification SDK through a native module, explaining the dependency before installation. Use its verified connection primitives for HTTP and a certificate-pinned WebSocket transport tied to attestation. Prove both transports on-device before treating Tinfoil as supported. Attestation failures block transmission; ordinary HTTPS is not a fallback.
- [x] Apply endpoint validation at request execution as well as in UI. Built-in providers never inherit a custom endpoint. Reject redirects that would send credentials to another origin and apply the same policy to discovered/model-list endpoints.
- [x] Keep keys, tokens, sensitive URLs, and provider response bodies out of logs, Sentry, exported settings, and persisted job metadata. Normalize provider failures into actionable errors without exposing raw responses.

**Acceptance:** Fixture tests cover every adapter, credential rotation/removal, token expiry, invalid keys, quota/rate limits, missing models, malformed responses, cancellation, and timeout. Native tests cover locked-device access and attestation failure.

### 4. Integrate transcription, keyboard recovery, and live meetings

**Primary integration points:** Mobile transcription services, audio-recording and keyboard-handoff hooks, meeting workflow, and `modules/background-uploader`.

- [x] Route recordings, imports, explicit retries, and keyboard jobs through the resolver. Reuse audio conversion/chunking with limits supplied by the selected provider adapter.
- [x] Extend native background jobs with versioned, secret-free route metadata and provider-aware normalization of results. Preserve existing managed-job compatibility.
- [x] Maintain cancellation, stale-job checks, raw-transcript recovery, and exactly-once keyboard insertion. On resume, recover interrupted multi-step work with its original route and retained audio.
- [x] Separate the existing meeting session lifecycle from OpenAI's event protocol. Add provider implementations that normalize partial/final transcript events, timestamps, supported speaker information, reconnects, and cancellation.
- [x] Restrict fallback/retry choices to supported capabilities and require explicit selection when changing providers. Do not send retained audio to another provider automatically.
- [x] Treat OS suspension and termination separately from user force-quit. Force-quit must leave recoverable local state, without promising continued background execution.

**Acceptance:** Real-device checks cover every supported keyboard transport, suspension, termination/resume, stale completions, interrupted uploads, meeting reconnect, and speaker/timestamp continuity. A retry cannot change destination or insert duplicate text.

### 5. Integrate text AI and local prompt construction

**Primary integration points:** Mobile reasoning services, `src/lib/cleanupTranscript.ts`, `src/lib/transcribeAndCleanup.ts`, agent services, and note-generation/chat callers.

- [x] Route cleanup, spoken agent commands, keyboard composition/regeneration, note formatting, title generation, and note chat through their selected scope.
- [x] Build BYOK prompts locally, preserving default/custom prompts, dictionary, language, tone, and agent-name behavior currently added by the backend. Share portable prompt-building rules with desktop when equivalent; retain mobile-specific tone and context adapters.
- [x] Keep fused transcription-plus-cleanup exclusive to managed Cloud. BYOK runs separately selected stages and preserves raw transcription on cleanup failure.
- [x] Apply privacy, policy, account, and usage decisions to every stage independently. Missing text-provider configuration produces a setup error or skipped cleanup, never an implicit Cloud call.

**Acceptance:** Prompt fixtures cover custom/default prompts, dictionary, language, tone, and agent-name semantics. Tests verify scope routing, partial success, cancel/regenerate races, and absence of unauthorized Cloud calls.

### 6. Finish mobile settings and contributor documentation

- [x] Apply the mobile design-quality skill and reuse current settings components. Expose Providers settings to signed-out users, filter models by scope capability, and remember selections per provider and scope.
- [x] Implement credential controls, provider setup links, connection checks, model discovery/manual entry, and clear provider-billing copy. Connection testing reports what was verified and does not claim inference access from a public model list alone.
- [ ] Add local-network permission configuration in the existing Expo configuration/plugin flow. Test public HTTPS, LAN HTTP, `.local`, Tailscale, denial, unreachable hosts, and malformed endpoints without weakening certificate validation.
- [x] Update `openwhispr-mobile/README.md` and `openwhispr-mobile/CONTRIBUTING.md` with BYOK setup, supported capabilities, platform limitations, custom-server addressing, and local test commands.
- [x] Document how a contributor builds and uses BYOK without OpenWhispr production credentials. Keep optional telemetry and hosted-service setup separate from BYOK requirements. Never embed provider keys in fixtures or `EXPO_PUBLIC_` variables.
- [x] Add a maintainer smoke-test matrix listing each provider/capability, required credential type, expected result, and device/build used. CI uses mocks and fixtures; credentialed validation is a maintainer release step.

**Acceptance:** A clean fork can build the app and complete BYOK transcription and text AI without signing into OpenWhispr or possessing production service credentials. Android's existing behavior is unchanged.

## Validation and release gates

Run checks in each application's directory; root commands are desktop commands. In particular, root `npm run format` modifies files, while mobile `npm run format` checks formatting.

```bash
# Repository root: shared routing plus desktop regressions
node --test .github/scripts/ci-scope.test.cjs
npm test
npm run typecheck
npm run format:check
npm run build:renderer

# Nested mobile application
cd openwhispr-mobile
npm test -- --runInBand
npm run format
npm run lint
npm run typecheck
npm run doctor
```

Also run the existing Mobile CI production Expo configuration/export checks, inspect an EAS archive for shared sources, and build iOS natively. Validate packaged desktop shared imports using the existing packaging workflow; renderer success alone does not validate Electron main-process imports.

Preserve the existing lockfile-source/integrity validation, dependency audit, controlled installation, CodeQL checks, and credential-free PR execution. New native dependencies must be pinned and covered by the documented build procedure.

Required scenarios include migration; independent routing; signed-out usage; Cloud allowance independence; private-note and organization-policy enforcement; key replacement/deletion/reset; background Keychain access; redirect protection; telemetry redaction; provider errors; keyboard recovery; meeting reconnect; and cleanup partial success.

Release full personal BYOK parity only after every supported provider/capability has fixture coverage and a credentialed smoke test, plus real-device keyboard/background and Tinfoil transport verification. If credentials or hardware are unavailable, record the corresponding check as unverified and do not claim full parity.

## Implementation status

Implementation is present on `feat/mobile-byok` in this worktree. The two unchecked items have code and automated coverage, but their physical-device verification remains open. See `openwhispr-mobile/docs/BYOK_SMOKE_TESTS.md` for credentialed provider and device release gates. No commits or pushes have been made, and no environment files were changed.

Native iOS compilation passed for both simulator architectures with code signing disabled and the app's iOS 17 deployment target. Production Expo export, EAS shared-source archive inspection, Expo Doctor, and packaged Electron main-process shared imports passed. The ASAR smoke used the production electron-builder file filter and Electron runtime; it did not produce a release installer.
