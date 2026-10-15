# Dynamic model registry migration

Date: 2026-10-14. Desktop audit baseline: `2516e6e00`. API audit baseline: `48ad289`. Admin audit baseline: `e60aff8`.

Josh authorized analysis, implementation, PR creation, and merge in this chat. This specification narrows Gabe's July proposal to a complete, safe first migration. Execution is native with one code writer and a fresh independent read-only reviewer. `deep_research: yes`; `codex_review: yes`. The current source audits supersede the July file counts and architecture assumptions.

## Outcome

The public `OpenWhispr/model-registry` repository becomes the editable source of the desktop model catalog. Merging a valid catalog PR publishes a signed update. The next desktop release can discover supported models during an existing app session without another desktop release, while an offline installation continues to use its bundled catalog.

GitHub's editor, pull requests, validation, review, and history are the CMS in this migration. A separate admin editing screen is not required to achieve this outcome. Publishing a catalog cannot introduce a new provider adapter, change a credential destination, replace a model installation in place, or change a user's selected model.

## Corrections to the original proposal

| Original assumption                                       | Current finding and decision                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The source stays inside the desktop repository.           | Josh requested a separate repository. Retain a generated, provenance-pinned desktop snapshot and sync command to prevent drift.                                                                                                                                                      |
| Four main-process imports and no stale derived constants. | There are 15 direct JSON import sites, including settings, policy, streaming, local ASR organization, main helpers, and renderer consumers. Every site must be classified and migrated. OpenAI realtime model IDs and the Gemini live model are also hardcoded outside the registry. |
| There is no desktop version comparator.                   | `src/utils/version.ts` already provides `compareAppVersions`; reuse its semantics.                                                                                                                                                                                                   |
| Tests run in `tests.yml`.                                 | That workflow no longer exists. Current gates include `build-and-notarize.yml` and `ci-changes.yml`; integrate with the current CI scope.                                                                                                                                            |
| Mobile is already entirely server-driven.                 | The monorepo has `openwhispr-mobile/src/config/providerCatalog.json` and a distinct local model catalog/native engines. Desktop data cannot replace them wholesale.                                                                                                                  |
| API/admin catalogs can simply load the desktop registry.  | Provider IDs and required local model IDs are policy contracts. API inference routing remains authoritative; admin's local model catalog was omitted from the proposal.                                                                                                              |
| Retirement can automatically pick another model.          | Selection migration is outside this first migration. Preserve every existing and previously published model identity.                                                                                                                                                                |
| A new OpenAI-compatible provider is just data.            | Credentials, policy enums, network adapters, and UI entry points still require coordinated code. Keep provider membership and transport configuration fixed.                                                                                                                         |
| OIDC by itself protects an Actions signing secret.        | Repository permissions, workflow review, environment access, and key custody provide the actual controls. Do not claim an OIDC security property that is not configured.                                                                                                             |

## Repository coverage and preserved contracts

| Surface                          | Treatment                                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop `OpenWhispr/openwhispr`  | Implement the loader, generated snapshot, shared runtime store, renderer subscription, and artifact verification. Keep all public interfaces and saved IDs working.                          |
| New `OpenWhispr/model-registry`  | Own split `registry/*.json`, validation schema, publication tooling, signed artifacts, publication history, and maintenance instructions.                                                    |
| API                              | No runtime dependency on the public catalog. Preserve provider-policy IDs, `requiredLocalModels`, hosted inference routing, note-recording behavior, and current policy versioning.          |
| OpenWhispr admin                 | Preserve provider and local-model policy catalogs. A remotely added local model may be individually selectable in desktop but is not automatically a new organization-required-model option. |
| Mobile in the monorepo           | Preserve `providerCatalog.json`, `localModelCatalog.ts`, and native engines. A future mobile projection needs its own consumer contract and minimum-version gates.                           |
| CLI/local HTTP API               | Preserve the `/v1/transcribe/models` response shape and existing IDs; new supported entries may be additive.                                                                                 |
| Website/docs and release tooling | Audit references and packaging so the generated snapshot and keys ship. No unrelated website deployment or native release is part of merging this migration.                                 |

## Data and trust contract

1. Preserve the existing JSON shape and all existing sections on extraction. Avoid deleting purportedly dead sections as part of the migration.
2. A signed envelope has `algorithm: "Ed25519"`, `keyId`, `payload`, and `signature`. `payload` is base64 of the exact UTF-8 manifest bytes; `signature` is base64 of the Ed25519 signature over those bytes. Verify before parsing the manifest. Do not reserialize JSON for verification.
3. The manifest contains `schemaVersion: 1`, a positive safe-integer `manifestVersion`, ISO `publishedAt`, a 40-character Git `sourceCommit`, signed `contractHashes` for the shared code, and `data`. Catalog validation is shared between CI and desktop from the same pinned source revision.
4. Desktop accepts only compiled-in public keys and schema version 1. No key material, authorization headers, arbitrary executable configuration, or credential routing is accepted from catalog data. A second pinned recovery public key is useful only if its private key has genuinely separate custody.
5. Provider IDs, transport endpoints, default-selection behavior, engine identities, and credential bindings come from the bundled compatibility contract. A remote catalog cannot add providers or move a model between providers. Existing download identities and runtime/decoder types cannot change in place.
6. New models may use only already-supported providers, engines, types, and capability fields. Optional `minAppVersion` filters new entries requiring a newer desktop; it never hides an existing usable identity. Unknown shape/adapter changes require a new supported schema or desktop release.
7. Reject a publication that removes an identity from the baseline or previous publication. Desktop also rejects removal from its last accepted canonical catalog. Rollback republishes corrected content with a higher version while retaining added identities; copying an older catalog verbatim may violate this rule.
8. Mandatory English name/description and existing translation-key fallbacks keep new entries readable in every locale. Translation automation is not required for publication.
9. Newly introduced downloads require a valid SHA-256 for every artifact, including a GGUF draft artifact when present. Legacy un-hashed bundled entries may continue unchanged; adding a checksum is allowed, changing the underlying URL/file/repository is not. No claim of blanket verification for legacy downloads is made.
10. Model IDs and file/extract names reject absolute paths, traversal, Windows separators/drives, control characters, and ambiguous decoded separators. Initial model download URLs require HTTPS and explicit compatible origins/repository paths. Downloads retain the existing automatic CDN redirects, omit session cookies and API credentials, and verify the final artifact's digest for newly introduced downloads.
11. Verify the complete temporary file, including resumed bytes, before promoting it. Reused archives with a catalog checksum are verified again before extraction. Reject unsafe archive entries/links before extracting a new remotely introduced archive. Executable downloads remain code-pinned.

## Desktop architecture

`src/models/registryData.js` is a pure ESM data store without Electron, React, browser globals, settings, or network imports. CommonJS main helpers use Node 24's synchronous `require(esm)` support; renderer modules import the same module. Each process has its own store, synchronized by IPC, rather than pretending imports share memory across processes. The shared validation contract may be a vendored `schema.cjs`, with its source digest recorded alongside the snapshot.

The store exposes `getRegistryData()`, `getRegistryVersion()`, `subscribeRegistry(listener)`, and `replaceRegistryData(snapshot)`. Replacement is atomic and one accepted replacement produces one notification. Getters read the current snapshot; module-scope derived maps must either be rebuilt on replacement or remain explicitly immutable compatibility constants. The registry's provider map and reasoning/Whisper/Parakeet exports must never retain the old snapshot.

`registryLoader.js` is the only main-process remote loader. It verifies a bounded cache at boot, chooses the newest compatible verified snapshot above the bundled floor, and starts fetches without delaying startup. Cache/network errors retain the usable snapshot. Cache writes use a temporary file plus rename; disk failure does not break model selection or startup.

Defaults: HTTPS GitHub raw publication URL under `OpenWhispr/model-registry`, 2 MiB envelope limit, 15-second request timeout, startup refresh after 5 seconds, refresh every 15 minutes, one request in flight, and `useSessionCookies: false`. Enforce the byte limit on streaming responses and disk cache reads, not just `Content-Length`. `OPENWHISPR_MODEL_REGISTRY_MODE=bundled` skips both cache activation and network access for managed offline use. This is a local control, not an invented server policy field.

IPC adds a snapshot request and a change event. Main verifies cached data before creating renderer windows; preload exposes the verified initial snapshot synchronously. Renderer bootstrap installs that snapshot before settings-store migrations normalize saved model IDs, preventing a valid remote-added selection from being erased on restart. It subscribes before requesting the reconciliation snapshot and ignores an older response if a newer change event already arrived. Every relevant window bootstraps synchronization. React consumers use `useSyncExternalStore`; `useMemo` values include the registry version when their result depends on registry data. Long-running operations capture the model configuration they started with.

OpenAI's `REALTIME_MODELS` set and Gemini live routing must derive eligible BYOK model IDs from the current registry, while preserving explicit provider checks. A new streaming model must both appear in the picker and reach the correct existing adapter. The Gemini streaming client must accept the selected compatible BYOK model instead of overwriting it with a constant. Managed OpenWhispr token/default-model paths remain server-controlled.

Batch routing checks live provider membership before legacy model-name heuristics. Gemini uses its pinned batch fallback only for a streaming or unknown selection; a selected compatible batch model keeps its ID. Deepgram includes the selected BYOK model in its socket identity and reconnect options, while preserving the existing Nova-3 language fallback and managed model selection. xAI and Corti transcription adapters send no model-selection parameter, so the shared contract rejects new transcription IDs for those providers until their adapters support them. Tinfoil additions remain streaming-only because its batch adapter owns a fixed attested model.

When a new OpenAI, Tinfoil, or Gemini selection replaces an unfinished warm connection, main buffers up to three seconds of initial PCM and sends it only to the selected connection. Failure clears the queue. Orukeet retains its existing larger startup buffer; Deepgram keeps its existing audio-driven connection behavior.

Tinfoil's live discovery remains its existing independent overlay, including its confirmed-fetch retirement behavior. A generic catalog refresh must not overwrite a fresher Tinfoil overlay, and Tinfoil overlay mutation must not affect canonical signature or additive validation. The migration does not alter other provider selection defaults, existing policy deny decisions, or installed-model ownership.

The desktop LLM canary scripts continue to inspect the bundled snapshot. Remotely added models enter that canary's coverage after an explicit snapshot sync; catalog publication alone is not a successful inference canary for the new model.

## Publication and snapshot provenance

The new repository publishes to a dedicated `published` branch. Desktop fetches `https://raw.githubusercontent.com/OpenWhispr/model-registry/published/manifest.json`. A custom domain, Pages configuration, and third-party CMS are unnecessary dependencies.

Publication runs only for trusted default-branch source or a deliberate dispatch. Its write/sign step is serialized with cancellation disabled and `queue: max` so a stale rerun cannot evict the latest pending publication. It fetches the current publication, chooses a strictly larger safe-integer version, validates additive compatibility, and verifies that the build source still equals the latest default-branch head immediately before publishing. A stale source run must skip or restart from the latest head. Concurrency queues alone are not assumed to be FIFO. Persist version history so a workflow rerun cannot reuse a version for different bytes.

Pull-request checks never receive the signing key. Use repository Actions secrets for the signing private key; do not print it, commit it, place it in generated artifacts, or expose it to PR code. Protect and review publication tooling/CODEOWNERS where supported, documenting the actual configured controls. Keys are public-only in desktop and repository sources.

Desktop's sync command accepts an exact publication/source revision, verifies its signature, schema, and bundled compatibility, then writes the snapshot, shared schema, and provenance metadata reproducibly. It must not silently download "latest" during an ordinary build. CI proves checked-in generated files match their recorded source and that normal builds work offline.

## Acceptance and merge conditions

- A valid signed fixture adds a cloud model and local model to the running main and renderer catalogs, preserving selections, providers, local HTTP response shape, policy restrictions, and Tinfoil overlay behavior.
- Malformed, oversized, unsupported, tampered, stale, or partially written data cannot replace the last usable catalog. A fresh offline install has the complete original catalog.
- A newer bundled snapshot beats an older cache; a compatible newer verified cache works offline and preserves a remote-added saved selection before settings migrations; a live update wins over an older in-flight IPC snapshot.
- Downloads reject bad hashes and unsafe paths before installation, including resumed data and archive reuse. Existing download cancellation/progress/optional-drafter behavior remains valid.
- New repository CI is green, publication exists and verifies with the compiled key, and the desktop snapshot is tied to that exact source. Publication infrastructure must be demonstrated rather than left as a disabled workflow.
- Focused regression tests, relevant existing tests, desktop typecheck/lint/build, and current required CI pass. Show new regression tests failing against the original implementation where applicable.
- A fresh independent reviewer reads the complete changes and cross-repository boundary evidence; actionable findings are fixed and rechecked before the authorized merge.
- Report merged PRs separately from signed/native release or production device acceptance. Remove generated build output and retire or explicitly retain all session-created worktrees.

## Deferred work

New provider adapters, provider key storage redesign, automatic model retirement, rollout cohorts, translation bots, new API policy fields, mobile catalog convergence, and an admin catalog editor are separate extensions. They are unnecessary for adding supported models through the registry CMS and would increase this migration's regression surface.
