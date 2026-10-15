# Dynamic Model Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Josh has authorized implementation, PR creation, and merge; execution is native with one code writer and a fresh independent read-only reviewer.

**Goal:** Move the desktop catalog into a public Git-managed registry and merge a verified live-update consumer for the next desktop release.

**Architecture:** A separate catalog repository publishes signed, versioned data while desktop retains a reproducible bundled floor. One main-process loader verifies updates and synchronizes a pure data store to renderer stores over IPC. Existing provider/engine contracts remain fixed; only supported catalog data changes live.

**Tech Stack:** Node 24, Electron 41, existing Zod 4, Node `crypto` Ed25519, React `useSyncExternalStore`, GitHub Actions, existing Node/tsx test harness.

**Spec:** `docs/superpowers/specs/2026-10-14-dynamic-model-registry.md`

## Global Constraints

- Desktop baseline `2516e6e00`; audit API `48ad289` and admin `e60aff8`, refreshing exact heads before merge.
- `deep_research: yes`; `codex_review: yes`; native execution with one code writer and an independent read-only reviewer.
- `schemaVersion: 1`; positive safe-integer `manifestVersion`; Ed25519 over exact decoded payload bytes.
- 2 MiB maximum envelope; 15-second request timeout; 5-second startup refresh; 15-minute refresh interval; single-flight, cookie-free requests.
- `OPENWHISPR_MODEL_REGISTRY_MODE=bundled` skips cache activation and remote requests.
- Preserve all existing and previously published model IDs, provider IDs, saved selections, policy restrictions, download identities, native engines, and public response shapes.
- No dynamic credentials, endpoints, provider adapters, executable URLs, automatic selection migration, API policy expansion, or mobile catalog rewrite.
- New download artifacts require SHA-256; legacy artifact identities remain fixed. Verify resumed/reused files before installation.
- The next native release ships this consumer; a merged PR is not evidence of native release or physical-device acceptance.

## Review Focus

- A remotely added model is selected and the next publication omits it: reject that publication, preserving the selection and catalog (Tasks 1 and 4).
- A new registry event arrives while a renderer's initial snapshot request is pending: an older response cannot overwrite it (Task 4).
- The app upgrades while an older verified cache exists: the bundled version remains the floor; a newer compatible verified cache still works offline (Task 4).
- An update occurs during a download, or a resumed/reused file has incorrect bytes: the operation keeps its original configuration and never promotes an unverified artifact (Task 2).
- A user is under provider restrictions or has a fresh Tinfoil overlay: catalog updates neither widen policy access nor overwrite that overlay (Tasks 3 and 5).

---

## File structure

New registry repository paths below are relative to `OpenWhispr/model-registry`, initialized locally at `/Users/joshuadavidpadoa/dev/openwhispr-model-registry` on `codex/catalog-migration`; desktop paths are relative to this worktree.

| Unit                                                                                                                       | Responsibility                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Registry `registry/*.json`, `lib/schema.cjs`                                                                               | Canonical catalog and pure validation/compatibility rules.                                 |
| Registry `scripts/{validate,check-previous,publish}.cjs`, `test/*.test.cjs`                                                | Reproducible build, signed publication, provenance, and CI verification.                   |
| Registry `.github/workflows/{validate,publish}.yml`, `README.md`, `.github/CODEOWNERS`                                     | Reviewed edit-to-publish workflow and actual custody/rollback instructions.                |
| Desktop `src/models/{registrySchema.cjs,registryData.js,registryData.d.ts,registryMetadata.json,registryTrustedKeys.json}` | Vendored schema, pure atomic store/types, bundled provenance, compiled public trust roots. |
| Desktop `src/helpers/registryLoader.js`                                                                                    | Signature/cache/network state machine; no React dependencies.                              |
| Desktop `src/models/registrySync.js`, `src/hooks/useRegistryVersion.ts`                                                    | IPC synchronization and renderer subscriptions.                                            |
| Desktop `scripts/sync-model-registry.mjs`                                                                                  | Explicit verified snapshot/schema vendoring from an exact revision.                        |
| Desktop `src/models/modelRegistryData.json`                                                                                | Generated bundled snapshot; keep the existing filename and shape.                          |

## Task 1: Extract and validate the canonical catalog

**Files:** Registry `registry/*.json`, `lib/schema.cjs`, `scripts/validate.mjs`, `test/registry.test.mjs`, `package.json`, `README.md`; desktop `src/models/registrySchema.cjs` and `test/helpers/registrySchema.test.js`.

**Interfaces:** `validateRegistry(data, { baseline, previous, appVersion }) -> validatedData`; `validateManifest(manifest, options) -> validatedManifest`. Inputs use the existing catalog shape plus optional `minAppVersion`, `sha256`, and `draftSha256`; malformed data throws. Existing version comparison semantics are reused rather than adding competing semver logic.

- [ ] Write failing contract tests: the extracted baseline deep-equals the current JSON; duplicate IDs, unknown provider/transport changes, removal of a bundled or previously published ID, changed download identity, and malformed capability/path data are rejected. A supported added cloud model succeeds; a newer-version new entry is filtered without hiding an existing entry.
- [ ] Run `npm test` in the registry repository and the focused desktop schema test; record the expected missing-implementation failures.
- [ ] Copy the full current catalog, implement strict shared validation, and pin immutable provider/engine/download identity fields. Preserve extra existing sections. Require checksums for every new downloadable blob, including optional GGUF draft artifacts.
- [ ] Run the contract tests and validate the complete extracted catalog. Add README instructions distinguishing supported-model additions from provider/engine code changes.
- [ ] Commit this independently reviewable extraction and validation change. Record the original desktop source SHA.

## Task 2: Verify model artifacts before installation

**Files:** Modify `src/helpers/downloadUtils.js`, `src/helpers/whisper.js`, `src/helpers/parakeet.js`, `src/helpers/modelManagerBridge.js`, and relevant model interfaces in `src/models/ModelRegistry.ts`; test `test/helpers/downloadIntegrity.test.js` and existing download/manager tests.

**Interfaces:** Extend `downloadFile(url, destPath, options)` with optional `expectedSha256`; add reusable `verifyFileSha256(filePath, expectedSha256) -> Promise<void>`. Preserve current return values, progress callback, cancellation, retries, and optional-drafter semantics. Download operations capture the model entry at start.

- [ ] Write failing tests: wrong digest cannot create/replace destination; digest covers existing resumed bytes; valid digest promotes the complete file; bad reused archive is rejected before extraction; a registry update during a download cannot change its expected digest/path; optional drafter failure retains a valid main GGUF. Add safe archive path/link rejection coverage for new remote archives.
- [ ] Run `node --import tsx --test test/helpers/downloadIntegrity.test.js` and retain the expected red evidence.
- [ ] Hash the completed temporary file before rename and existing archives before reuse. Propagate primary/draft hashes through managers. Validate new remote archive entries before extraction and keep legitimate existing URL/CDN behavior working. Restrict these data-driven paths without breaking unrelated executable download helpers.
- [ ] Run the new tests plus the existing download, Whisper, Parakeet, model-manager, and cancellation tests selected from the current test tree; all relevant assertions pass.
- [ ] Commit artifact verification as a standalone hardening change before enabling remote catalogs.

## Task 3: Unify the runtime store and migrate every reader

**Files:** Create `src/models/registryData.js`, `src/models/registryData.d.ts`, `src/hooks/useRegistryVersion.ts`; modify all 15 JSON import sites: `src/models/ModelRegistry.ts`; `src/stores/settingsStore.ts`, `policyRules.ts`; `src/helpers/whisper.js`, `parakeet.js`, `modelManagerBridge.js`, `tinfoilTranscription.js`, `localTranscriptionModels.js`, `parakeetModelInfo.js`, `policyValidation.js`, `dictationStreamingRouting.js`, `localASROrganization.ts`, `ipcHandlers.js` (two sites). Audit `streamingProvidersStore.ts`, `audioManager.js`, `geminiLiveStreaming.js`, `realtimeTokenProviders.js`, and every consumer of `REASONING_PROVIDERS`, `WHISPER_MODEL_INFO`, and `PARAKEET_MODEL_INFO`.

**Interfaces:** `getRegistryData() -> RegistryData`; `getRegistryVersion() -> number`; `subscribeRegistry(listener: () => void) -> () => void`; `replaceRegistryData(snapshot: { data, manifestVersion }) -> boolean`; `useRegistryVersion() -> number`. The store has no browser/React/Electron/settings imports; main requires the ESM module synchronously. All public model lookup signatures remain compatible.

- [ ] Write failing tests in `test/helpers/registryData.test.js`: CJS and ESM readers in one process observe the same replacement; getters, local HTTP catalog, policy-required-ID resolution, reasoning exports, and local ASR metadata see additions; existing provider denies and saved IDs stay unchanged; one replacement produces one notification; rejected/older replacement produces none.
- [ ] Run the focused test and prove the stale-import/derived-state assertions fail against the baseline.
- [ ] Implement the atomic store and replace static imports. Rebuild derived provider/maps on each accepted replacement or convert consumers to getters; keep fixed provider-policy constants explicit. Preserve the independent Tinfoil discovery overlay when rebuilding and do not mutate canonical signed data through it.
- [ ] Replace hardcoded OpenAI realtime membership and Gemini BYOK live-model selection with registry-derived supported IDs; pass the selected compatible BYOK model to the existing Gemini streaming adapter. Add assertions that newly added streaming models actually route, stale IDs from another provider do not cross-route, and managed server-token/default-model paths are unchanged.
- [ ] Subscribe registry-dependent pickers, onboarding, settings, and notes editors using the hook. Include the version in registry-derived `useMemo` dependencies. Audit `ReasoningModelSelector`, `TranscriptionModelPicker`, `EnterpriseProviderConfig`, `EnterpriseSection`, `LocalModelPicker`, `LocalWhisperPicker`, `settings/InferenceConfigEditor`, `notes/UploadAudioView`, and current onboarding consumers; do not rely on the July list.
- [ ] Run the focused store tests and relevant existing policy, Tinfoil, model selection, onboarding, local HTTP, and streaming tests. Use `rg` to confirm only the approved bootstrap/schema/vendor tooling reads the JSON directly and no stale derived registry values remain.
- [ ] Commit the runtime-store refactor. Offline behavior must already work before remote fetching exists.

## Task 4: Implement verified cache, background refresh, and IPC

**Files:** Create `src/helpers/registryLoader.js`, `src/models/registrySync.js`, `src/models/registryMetadata.json`, `src/models/registryTrustedKeys.json`; modify `main.js`, `preload.js`, `src/helpers/ipcHandlers.js`, `src/types/electron.ts`, `src/main.jsx`; test `test/helpers/registryLoader.test.js` and `test/helpers/registrySync.test.js`.

**Interfaces:** `createRegistryLoader({ cachePath, bundledSnapshot, trustedKeys, fetch, appVersion, applySnapshot, ...clockOptions }) -> { start(), refresh(): Promise<void>, stop(), getSnapshot() }`. Preload exposes `initialModelRegistrySnapshot: { data, manifestVersion }` synchronously, obtained from the already verified main store. `getModelRegistry()` IPC returns the same shape; `onModelRegistryUpdated(callback)` returns unsubscribe. Renderer bootstrap applies the synchronous initial snapshot before settings modules evaluate, then `startRegistrySync(electronAPI) -> () => void` subscribes before reconciliation snapshot retrieval and applies only the newest version. Production defaults are fixed in the spec; injected dependencies make tests deterministic.

- [ ] Write failing loader tests using generated test-only Ed25519 keys: valid update, invalid key/signature/schema, rollback/equivocation, removed remote-added model, newer-bundle precedence, newer verified offline cache, tampered/oversized/partial cache, response streaming limit, timeout, retry, single-flight, disk-write failure, bundled mode, and timer cleanup. Assert no startup path awaits the network.
- [ ] Write failing IPC tests: restarting with a saved remote-added model and valid cache preserves that selection through settings initialization; an event at version 3 followed by delayed request response version 2 retains 3; multiple windows receive a valid replacement; double initialization/cleanup does not leak listeners; fresh Tinfoil overlay survives canonical update.
- [ ] Run both focused test files and retain failures showing the missing behavior.
- [ ] Implement exact-byte signature verification, bounded read/fetch, atomic cache write, floor/version checks, refresh scheduling, and graceful fallback. Finish cache verification before creating renderer windows, while always providing synchronous bundled data. Install the verified preload snapshot before settings-store migrations run. Wire IPC and every renderer bootstrap path; stop timers on app quit.
- [ ] Run focused tests plus current typecheck. Verify unknown/tampered input never reaches runtime readers and bundled mode performs zero cache/network activation.
- [ ] Commit verified live synchronization.

## Task 5: Publish the catalog and pin the desktop snapshot

**Files:** Registry `scripts/{compile,publish}.mjs`, `.github/workflows/{validate,publish}.yml`, `.github/CODEOWNERS`, README/runbook, publication-history metadata; desktop `scripts/sync-model-registry.mjs`, `package.json`, generated registry files, current CI workflow/scope files as required.

**Interfaces:** Registry compile emits exact manifest bytes; publish wraps and signs those bytes and writes `published/manifest.json`. `sync-model-registry.mjs --revision <exact-published-commit>` verifies and vendors the snapshot/schema/provenance; ordinary builds do not fetch. Source paths and hashes are recorded so regeneration is deterministic.

- [ ] Write failing publication tests: two successive publications have increasing versions, a rerun cannot reuse a version for different content, stale source cannot publish after a newer merge, omission of a previous identity fails, and the exact published source regenerates identical desktop files. PR validation cannot access signing inputs.
- [ ] Run registry tests and desktop sync tests to capture the failures.
- [ ] Create the public repository and trusted default branch through the authorized GitHub workflow. Configure signing custody without printing private material. Implement serialized non-cancelling publication with a last-head check, exact-source provenance, history, and additive rollback. Configure actual supported protections and document any provider limits honestly.
- [ ] Open and attach the registry PR, run checks/review, and merge under the user's existing authorization. Observe a successful publication, fetch its exact bytes, and verify signature/provenance independently with the public key. No disabled signing/publish prerequisite may be left behind.
- [ ] Vendor that exact signed publication into desktop using the sync command. Run generated-file parity verification, a no-network build, and a test signed compatible update showing new entries reach both main and renderer without restart; preserve selections, API/admin policy fixtures, Tinfoil, and local HTTP response shape.
- [ ] Commit desktop integration and publication evidence. Record which native/manual checks ran and which remain release-time acceptance.

## Task 6: Regression review, authorized merge, and handoff

**Files:** This spec/plan, narrowly relevant architecture docs, test evidence, PR descriptions; no unrelated API/admin/mobile rewrites.

- [ ] Run the completed focused suites, relevant existing suites, `npm run typecheck`, `npm run lint`, `npm run i18n:check`, and `npm run build:renderer`. Run the full desktop suite once if the environment supports it; rebuild ABI-dependent dependencies for Node 24 before interpreting DB failures. Record any baseline failures separately.
- [ ] Refresh API/admin/mobile/CLI repository heads and confirm no newly introduced cross-repository contract drift. Preserve the audited provider-policy/required-local-model contracts in explicit parity assertions or documented compared fixtures; do not claim separate API/admin tests from desktop tests alone.
- [ ] Have a fresh independent reviewer inspect the complete desktop and registry diffs and the cross-repository audit. Fix actionable findings, then repeat only affected tests and required CI.
- [ ] Open/attach the desktop PR with the actual final scope and evidence, wait for required checks, review the exact final head, and merge under Josh's explicit authorization. Verify default-branch merge SHAs and that the registry publication still verifies.
- [ ] Remove generated renderer output after verification. Remove only session-owned clean, pushed, idle worktrees; explicitly retain any required checkout with a handover reason. Preserve other sessions' work.
- [ ] Report both PR URLs, merge SHAs, verified publication version/source, supported live changes, exclusions, and the separate next-release requirement. Update the active goal to complete only when the migration and publication are merged and no required implementation/review work remains.

## Self-review

All five Review Focus cases have owning tests above. The spec's additive compatibility, artifact trust, stale-derived-state, publication ordering, provenance, cache, IPC, and cross-repository conditions map to Tasks 1–6. The July stretch phases are intentionally absent from this first migration; implementation must not silently imply they shipped.
