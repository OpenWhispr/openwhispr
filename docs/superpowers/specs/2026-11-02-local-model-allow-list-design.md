# Approved local models across desktop API and admin

Status: approved for implementation, 2026-11-02. Deployment requires separate authorization.

Workspace admins approve speech and AI text models separately. Members choose among approved models that suit their hardware. The supported desktop must refuse unapproved downloads, loading, and inference, including calls outside the UI. Existing installed files remain removable by the member.

## Sources and verification

The acceptance comments are the product basis: [desktop journey](https://github.com/OpenWhispr/openwhispr/issues/2637#issuecomment-6518952177), [API journey](https://github.com/OpenWhispr/openwhispr-api/issues/258#issuecomment-6518951307), and [admin journey](https://github.com/OpenWhispr/openwhispr-admin/issues/24#issuecomment-6518951736). The [earlier detailed draft](https://github.com/OpenWhispr/openwhispr-api/issues/258#issuecomment-6133906486) and issue bodies are inputs, not verified requirements about implementation.

GitHub `main` heads were checked on 2026-11-02. Source inspection used these exact revisions:

| Repository | Revision                                   | Inspection                                                                                             |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Desktop    | `7155b905dddd593e4577cf254eefb64ec7cc55d0` | Current clean task checkout; package version 1.11.0                                                    |
| API        | `11121f11a82388f990543347eb7b6223ecdeb8e2` | Read-only `git show origin/main` and GitHub schema                                                     |
| Admin      | `b06de60423e8508a874bbcd3969cd9b5a2dbc7f1` | Read-only `git show origin/main` and GitHub schema; local working copy is older and dirty, so excluded |

112 existing desktop tests passed: `test/helpers/{policyRules,policyValidation,localTranscriptionModels,workspacePolicyManager}.test.js` and `test/components/setupEligibility.test.js`. The task checkout has no dependencies; the run used the existing primary checkout's `tsx` loader and `NODE_PATH`, without installing packages. These are baseline tests, not tests of this proposed feature. API/admin runtime tests and real managed-device journeys have not been run.

### Verified corrections to the earlier draft

| Earlier assumption                                         | Verified finding and consequence                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 12 speech models and 31 AI text models                     | Registry now contains **15 speech IDs and 42 AI text IDs**. Include legacy IDs still supported by the registry, but retain existing legacy picker visibility.                                                                                    |
| Add Orukeet and Cohere to the required catalog             | Five speech IDs are missing from the API's 10-entry enum: `large-q5`, `turbo-q5`, `parakeet-tdt-110m-en`, `cohere-transcribe-03-2026`, `orukeet-v0.1.0`.                                                                                         |
| Gating the public manager start methods covers inference   | Whisper `_runServerTranscription` calls `serverManager.start` directly; Parakeet `transcribe` calls `wsServer.start`, and online streams use separate paths. Startup, download completion, wake, and GPU fallback also start servers.            |
| Screen-context gate can be copied directly                 | `isScreenContextBlocked` permits ordinary unresolved failures. Local-model authorization must deny any unresolved signed-in identity; it needs the stronger identity and lifecycle patterns in `audioFeaturePolicy` and the IPC policy resolver. |
| Selection guards need no caller changes                    | LLM callers currently pass only mode/provider. `reasoningPolicy.ts`, `ReasoningService.ts`, and `useChatStreaming.ts` must pass the actual dispatched model.                                                                                     |
| Empty effective model is always inert                      | `selectResolvedLLMConfig` inherits a fallback model when a field is empty. Recheck the final resolved model before dispatch; clearing a field alone is insufficient.                                                                             |
| Old consoles may reset restrictions; deploy close together | The API already preserves omitted audio controls in PUT. Apply that protection to these fields too. Close deployment timing is insufficient.                                                                                                     |
| One combined models card prevents all save conflicts       | Provider cards still replace whole `transcription`/`llm` sections from drafts. A mounted stale card can overwrite a models-card save using the latest timestamp. Limit each card to its owned fields.                                            |
| Admin has no test runner                                   | `npm run test:e2e` and two Playwright suites exist. Extend the mocked-API browser testing pattern.                                                                                                                                               |
| CLI has no policy enforcement                              | CLI now enforces the upload feature through `_audioFeaturePolicy`; local mode/model enforcement remains missing. Preserve both controls.                                                                                                         |
| Minimum app version secures every old path                 | Older renderer guards respect it, but the legacy main-process model IPC and CLI paths under discussion lack these checks. A floor alone cannot retrofit those paths.                                                                             |

Evidence paths: desktop `src/models/modelRegistryData.json`, `src/stores/{policyRules,settingsStore}.ts`, `src/services/{reasoningPolicy,ReasoningService}.ts`, `src/helpers/{whisper,parakeet,parakeetServer,modelManagerBridge,workspacePolicyManager,audioFeaturePolicy,ipcHandlers,cliBridge}.js`; API `lib/{policy-schema,policy}.ts` and `api/workspaces/[id]/policy.ts`; admin `lib/hooks/{use-policy,use-policy-section}.ts`, `components/console/policy/provider-policy-cards.tsx`, `package.json`, `e2e/audio-feature-controls.spec.ts`.

## Scope and boundaries

Cover desktop's built-in Whisper, Parakeet-family ASR, and downloadable GGUF AI text models. Include dictation, meetings, uploads/batch, notes, cleanup, translation, agents, onboarding, background downloads, startup/wake/GPU warm-up, direct IPC, and CLI.

Self-hosted/LAN and BYOK retain their existing mode/provider rules. Do not apply this catalog to remote model names or route a denied local request to a remote service. Mobile is excluded and must be disclosed. Nonselectable support assets—diarization, VAD, embeddings, and GPU/runtime binaries—are excluded. A declared companion draft model is part of its parent GGUF model's approval; it is not a separately selectable model.

This is enforcement by the supported application, not device management or model-file attestation. It cannot prevent modified clients, renamed/replaced model files, direct access to native sidecars, or other applications from running models. Do not claim company-wide machine enforcement without a separately managed deployment of compliant builds.

## Contract

Keep policy version 1. Add `allowedLocalModels: string[] | null` to both `transcription` and `llm`; optional on older desktop payloads, defaulted to `null` on API/admin reads.

| Value or operation                        | Meaning                                                                                                                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old stored row with no field; `null`      | All catalog models are approved, subject to existing mode and capability restrictions                                                                                                                                                   |
| Nonempty array                            | Only these exact registry IDs are approved in this scope                                                                                                                                                                                |
| `[]` in a resolved multi-workspace policy | No approved models; deny local actions for this scope                                                                                                                                                                                   |
| `[]` in an admin PUT                      | Invalid as a change; explicitly use `null` to allow all, or turn Local mode off to disable local processing. One already stored, which only a direct database edit can create, reads as no approved models and survives unrelated saves |
| Field omitted from an update              | Preserve that scope's stored value; if no stored policy, default to `null`                                                                                                                                                              |
| Field explicitly `null`                   | Deliberately remove that scope's model restriction                                                                                                                                                                                      |
| Local mode disabled                       | Deny local actions regardless of the list; retain dormant lists for later reuse                                                                                                                                                         |

The comments' “leaving the list empty means all” is an **admin interaction**, not the semantics of an effective array. In the console, clearing the last checkbox changes the choice to **Allow all**, visibly before Save, and serializes `null`. Show “No specific models selected. All on-device models will be allowed.” Never convert an effective `[]` from the API into `null`.

Shape limits: at most 200 IDs; each 1–128 characters; no duplicates on writes. Unknown strings remain readable so retiring an ID does not invalidate a saved workspace. A new or edited non-null list may contain only IDs in the corresponding current API catalog. Unchanged stored lists containing retired IDs may be carried through unrelated saves; new/changed lists must remove unknown IDs. Return HTTP 400 with `code: "UNKNOWN_LOCAL_MODEL"`, `ids`, and `scope`, plus a human-readable `error`. A new or edited list also needs at least one current model, since the desktop never offers legacy models as a new choice: HTTP 400 with `code: "NO_CURRENT_LOCAL_MODEL"` and `scope`. A saved list isn't re-judged when a model turns legacy. Validate after omission preservation, comparing each list with its stored value to distinguish an actual edit.

`requiredLocalModels` remains speech-only and must be a subset of the speech approvals when restricted. It still requires Local transcription mode. Stored values are read by shape only, like the approval lists, so retiring a catalog ID can't make a saved policy unreadable. New or changed lists are checked against the 15-ID speech catalog when saved, and an unchanged retired ID survives unrelated saves.

Combine workspace approvals by intersection; `null` is the universe, not an empty list. Preserve the first non-null list's ordering. Deduplicate merged results. Union required IDs using existing catalog ordering, then remove anything not approved by the effective speech list. No required models are actionable when effective Local transcription is disabled. Zero policies retain existing defaults; one-policy results retain the field values. An empty model intersection remains a managed policy and blocks only that local scope. Existing strict failure for no common inference mode remains unchanged.

## Member journeys

1. **Fresh managed setup:** resolve policy before offering local download choices. Local setup requires a device-supported approved speech model. AI text is optional there: when none is approved, the assistant step shows the blocked notice plus Skip. Select an approved initial candidate using existing recommendation/order rules; do not start a download until that choice is established.
2. **Choose a model:** show approved choices with size and existing hardware/platform information. Approval does not imply the device can run it. Explain: “Your organization approved these models. Pick one that suits your computer.” Preserve legacy-model visibility rules rather than reviving retired recommendations.
3. **Previously installed model becomes disallowed:** keep it visible as “Not approved by your organization”, with Delete only. Do not hide its only family/tab if that would hide deletion; a separate installed-disallowed section is acceptable. Never select, download, warm, or run it.
4. **Current selection becomes disallowed:** when Local is allowed but this model isn't, derive an inert effective selection and prompt the member to choose an approved model. When Local itself is off, the member is moved to an allowed mode, as mode policy always did. A blocked scope never falls back to another scope. Preserve the saved preference; no policy-triggered setter, file deletion, automatic large download, or cloud fallback. This intentionally replaces the draft's automatic re-selection: current settings already preserve personal preferences through policy overrides. An explicit member choice changes the saved selection normally.
5. **No compatible approvals:** show a blocked local state: “Your organization hasn't approved any on-device models this app version supports. Update OpenWhispr or contact your administrator.” Keep other policy-permitted setup modes usable. For an empty intersection, explain that workspace policies have no model in common; do not imply an update will necessarily fix it.
6. **Policy changes during work:** once a newer authoritative denial is accepted, stop newly prohibited downloads, native loading, and inference; cancel streams and queued work, discard denied results, and stop affected loaded servers. Completed model files remain. Existing cleanup of incomplete download artifacts is permitted; do not purge completed installations. A blocked meeting stops with a clear reason and keeps the transcript so far rather than switching engines mid-session. Audio not yet transcribed, at most the last few seconds, is lost: the app keeps no meeting recording to recover it from, and this feature adds none, so retention rules are unchanged.
7. **Reapproval/sign-out:** reevaluate from the new identity/policy. Installed files become usable if allowed. Never let an old account's asynchronous response authorize work in the new account.

All three transcription contexts and every `INFERENCE_SCOPES` entry must use final resolved model IDs. Inherited LLM configurations are checked after fallback resolution. Under a managed policy, empty model IDs are refused before manager defaults such as Whisper `base` or Parakeet's default can apply; guests and unmanaged users keep those defaults. Pending selections are rechecked at download completion before activation.

## Main-process enforcement

Use `workspacePolicyManager` as the policy source. Reuse `policyRules` for the model/mode/min-version decision, not a second independently maintained ruleset. Adapt snapshots with explicit managed/unmanaged states. Main must distinguish a proven guest from a signed-in identity whose policy has not settled; renderer `idle` is not proof of guest status.

Create `src/helpers/localModelPolicyGate.js` as the lifecycle adapter. Wire it in `ipcHandlers.js` alongside `_audioFeaturePolicy`, before startup warm-ups. Resolve auth using existing main-owned token generation, account binding, and cookie/bearer helpers; never trust a caller-supplied “unmanaged” flag. Preserve the existing credential/origin-scoped last-good policy cache and five-minute refresh window. Do not invent a separate policy cache. Revocation is effective when learned, not instantly while a device is offline.

- Proven guest: allow known catalog models, subject to normal capability checks. A blank model isn't a refusal: engine defaults apply as they always did. An unknown ID is an ordinary validation error with no organization wording. Cookies the API rejects with a 401, with no bearer and no account, prove a guest.
- Resolved unmanaged identity: as for a proven guest.
- Resolved managed identity: require app version, Local mode, and exact model approval.
- Signed-in unresolved, malformed/error with no usable matching cache, or invalid auth generation: deny. A matching last-good snapshot supplied by the policy manager can authorize offline operation under existing policy-cache semantics. A rotated credential falls back to the last validated verdict for the same account and origin; another account never does.
- Background pre-warm: consult memory only; skip if unresolved. Resume a skipped warm-up once, when the first verdict for the identity settles.
- Foreground actions decide from a held verdict at once, in memory or in the existing disk cache, and refresh it in the background, so a slow network never holds up dictation; a denial from the refresh revokes through the same path. Only an identity with no verdict anywhere awaits the bounded lookup.

Recheck authorization at the irreversible boundaries, not only when accepting an IPC: before network transfer, before native process load/reload, before inference dispatch against a reused server, and before delivering/activating a result. A lookup made for a previous credential never lands, and new work needs the current credential's verdict. Policy updates abort affected jobs. A token rotation takes the account's held verdict for new work, and running work and loaded servers keep theirs until the re-resolve answers; an unresolved verdict never stops anything, here or in the audio controls: a running upload or meeting ends only on a settled denial, a sign-out or account change, or a server refusing it. A session cleared when no one was signed in changes no identity and cancels nothing. Account switches/sign-out cancel old-account jobs before applying the new verdict. Going from a guest to signed in keeps running work and re-evaluates it when the verdict lands.

| Boundary        | Coverage required                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Downloads       | `download-whisper-model`, `download-parakeet-model`, `model-download`, and manager entry points; companion draft downloads inherit parent authorization       |
| Whisper         | `initializeAtStartup`, `startServer`, `_runServerTranscription`, wake/GPU restarts, raw server start/reuse and transcription                                  |
| Parakeet family | startup, download-completion warm-up, `startServer`, `transcribe`, `createOnlineStream`, WS server start/reuse and subsequent stream frames                   |
| AI text         | `downloadModel`, `prewarmServer`, `runInference`, context-budget paths that load a model, context/GPU retry starts, native generation against a reused server |
| IPC callers     | upload/file transcription, note recordings, meeting chunks/streams, dictation preview, local reasoning and server-control handlers                            |
| CLI             | await policy for model listing and transcription; preserve existing upload-feature refusal                                                                    |

Carry canonical model identity from the registry into native-server requests; verify the dispatched path matches that model's catalog path. Do not derive approval from an arbitrary filename. Gate local paths without applying catalog restrictions to the existing LAN transport. Native implementations may share a small authorization callback, but the plan must prove that each direct start and reuse path invokes it.

Use typed failures consistently: `POLICY_MODEL_BLOCKED` for a disallowed model, `POLICY_LOCAL_MODE_BLOCKED` for Local disabled, `POLICY_UNRESOLVABLE` for unresolved policy, and `POLICY_APP_VERSION_BLOCKED` for the floor. Preserve these codes through manager/IPC catches; classify them as terminal refusals so retry/cloud fallback cannot bypass them. CLI maps these to HTTP 403 `forbidden` using its existing envelope. Unknown catalog IDs retain ordinary validation errors. A denied configured CLI default must not silently choose another model; name the recovery action.

## Admin journeys and save ownership

Replace Required model downloads with **On-device models** on `/policies/providers`. Save speech approvals, AI text approvals, and required speech downloads as one slice of the full policy document.

Each scope has Allow all / Only allow models I approve. Entering restricted mode preselects current catalog entries. Speech rows show name, size, description, Approved and Require on every device; unapproving clears Required. AI text rows are grouped by family and sorted by numeric size. Include companion download bytes where applicable. Legacy rows are marked; existing unknown IDs are shown as unavailable entries rather than silently discarded.

Disable a scope's controls when its **saved** Local mode is off, explaining where to enable it. Disabling Local while required speech models remain continues to fail with actionable validation; tell the admin to clear Required first. Dormant approvals remain intact. Reset loads the latest saved slice, and navigation retains existing unsaved-change protection.

Change Transcription and AI text provider cards to select/apply only their owned mode/provider fields. They must spread the latest base section when saving and preserve `allowedLocalModels`. The new models card likewise spreads the latest base scopes. A stale server revision remains a 409; do not auto-retry conflicting edits. Extend `usePolicySection` to expose save errors for inline rendering while retaining existing callers and toast behavior. API unknown IDs and required-not-approved errors must appear beside the relevant section.

API GET and successful PUT add `localModelPolicyVersion: 1` to the policy-state envelope, including GET for an unmanaged workspace, once restrictions are enabled (`LOCAL_MODEL_RESTRICTIONS_ENABLED`, off by default in production). PUT must return it because `useSavePolicy` replaces the query cache with the response. Hide/disable model approval editing when that capability is absent; older APIs strip unknown fields, so a successful HTTP save alone is not support detection. A PUT changes approvals only when its body declares `localModelPolicyVersion: 1`; otherwise the stored lists are carried forward, because old consoles echo back whatever lists they loaded. Required downloads stay editable without the capability.

## Release and compatibility

Define `LOCAL_MODEL_POLICY_MIN_VERSION` in API/admin as the actual first desktop release containing the complete main-process and UI enforcement. **The user selected 1.11.1 as the first enforcing release.** Qualify its complete enforcement before deploying restriction writes; current 1.11.0 does not contain this feature. No database migration or new package is expected.

For new/changed restricted lists, require `minAppVersion >= LOCAL_MODEL_POLICY_MIN_VERSION` at save time, in the PUT handler (which can compare with the stored row), never a version-dependent stored-row validator. Apply the same rule when lowering the floor of a restricted policy. Unrelated saves are exempt, so raising the constant later can't stop a restricted workspace saving other controls. Do not automatically raise the floor: show a review/confirmation with the affected-device information pattern already used for audio controls, then save the model slice and approved floor together. Existing unrelated policy constraints still apply.

Deploy API first with unrestricted defaults, omitted-field preservation, catalog validation, and tests, with `LOCAL_MODEL_RESTRICTIONS_ENABLED` unset, so new restrictions are refused with a 403. Release and qualify desktop next: desktop bumps to 1.11.1 in the PR that adds enforcement, so no earlier build can take that version, and a scheduled API check (`npm run catalog:check`) fails if the tagged floor release lacks enforcement. Enable restrictions on the API only after the qualifying desktop is available. Existing consoles preserve restrictions through the API's capability check; new consoles always declare the capability and send both fields. Old desktops tolerate the added fields, but do not enforce them. Minimum-version settings reduce exposure in older supported UI paths; they do **not** secure every legacy direct-main/CLI path. Enterprise rollout requires updating the desktop fleet before claiming complete app-path coverage.

A rollback of the console must retain the preserving API; an old console's checkbox group also drops required IDs outside its 10-entry catalog when one is toggled. An API rollback must keep these fields and protections; rolling back to an API that ignores them can erase enforcement, and a row requiring one of the 5 newer speech IDs fails the old API's enum, returning 503 to that workspace's members. Unset `LOCAL_MODEL_RESTRICTIONS_ENABLED` while diagnosing a failed rollout rather than setting lists to `null`: stored restrictions keep applying.

## Acceptance matrix

| Scenario                                                         | Required result                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Old row/default and unmanaged/guest                              | Existing local operation unchanged                                                |
| Restricted speech/LLM list                                       | Every UI surface and main entry agrees on the same exact IDs                      |
| Wrong-scope, malformed, duplicate, oversized or unknown new list | Predictable validation; no save                                                   |
| Stored retired ID                                                | Policy still resolves; desktop grants no unknown ID; unrelated save preserves it  |
| Two workspaces with disjoint lists                               | Effective `[]`; local scope unavailable; no forced prohibited download            |
| Old console omits or echoes either list                          | Stored restriction survives; a declared explicit `null` clears only that scope    |
| Provider card saved after models card                            | New model restriction survives                                                    |
| Required model unapproved                                        | Clear Require in UI; API rejects inconsistent direct write                        |
| Disallowed installed file                                        | Delete only; no automatic removal                                                 |
| Approved model incompatible with device                          | Existing capability block; no unauthorized fallback                               |
| Direct IPC, CLI, startup, wake, GPU retry, reused server         | Denial before network/native dispatch, with stable error code                     |
| Revocation during download/load/stream                           | Cancel affected work; no late activation/result; completed files retained         |
| Account/token switch with delayed verdict                        | Old response and jobs cannot authorize the new identity                           |
| Offline cached managed / signed-in uncached                      | Use matching existing cache / fail closed                                         |
| Missing or blank final model                                     | Managed: refuse before engine defaults. Guest/unmanaged: engine default as before |
| Remote BYOK/LAN, helper assets                                   | Existing behavior unchanged                                                       |
| Older desktop/mobile                                             | Truthful coverage disclosure; no unsupported security claim                       |

Ship after automated contract/behavior tests and managed-workspace QA on macOS, Windows, and Linux pass. Hardware-unavailable paths must be reported as untested, not inferred from unit tests. Use all 11 current desktop locales for new member copy.

## Implementation plans

- [API](../plans/2026-11-02-local-model-allow-list-api.md)
- [Desktop](../plans/2026-11-02-local-model-allow-list-desktop.md)
- [Admin console](../plans/2026-11-02-local-model-allow-list-admin.md)

Deliberate design calls for review: empty admin selection serializes `null`; blocked existing preferences require an explicit member choice; revocation cancels active local work; restriction writes require a reviewed release floor; unchanged retired lists survive unrelated saves. These decisions were approved for implementation; they are not claims that the original issues already specified them.

## Implementation and verification — 2026-11-02

Implemented and reviewed on `feat/local-model-allow-list` in all three repositories. No deployments, production policy writes, environment-file edits, or dependency installations were performed.

| Repository | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API        | 2,861 tests passed. TypeScript (`--incremental false`), ESLint and whitespace checks passed; ESLint retains four unrelated warnings. Broad review found no blockers.                                                                                                                                                                                                                                                                                                                                                                                       |
| Desktop    | Full installed-Electron-runtime run: 10,360 tests, 10,337 passed, eight failed, 14 skipped, one todo. The eight failures are in the existing VAD-path suite, whose assignment to `process.resourcesPath` cannot change Electron's read-only property. All nine tests in that suite pass under Node 24. The final enterprise-route/blank-ID correction passed 37 focused tests; final review found no remaining actionable issue. Renderer build, typecheck, translations, lint and changed-file formatting passed, with existing lint/chunk-size warnings. |
| Admin      | Full browser run: 101 passed, two flag-dependent skips, one strict-text-locator failure caused by the new inline error plus existing toast. The assertion was scoped to its alert; that test and three confirmation retry cases then passed. TypeScript, ESLint, changed-file formatting and whitespace checks passed. Task and broad reviews approved.                                                                                                                                                                                                    |

The desktop tests use controlled native/network fixtures, not real model inference on every operating system. Before enabling restrictions, release and qualify desktop **1.11.1**, run the managed-device journeys on macOS, Windows and Linux, and perform staging API → desktop → admin checks. The desktop package version is 1.11.1 on this branch, reserving the floor for the first build with enforcement. API/admin enforce that floor.

The API deployment must explicitly set `LOCAL_MODEL_RESTRICTIONS_ENABLED=true` only after qualification; it defaults off in production, and the console follows the capability it returns. The admin README records rollout and manual checks. Existing unrelated workspace switching can discard unsaved card drafts without a navigation warning; that pre-existing switcher behavior was flagged and left unchanged.

Implementation decisions recorded during execution:

- Use Git to create the authorized API/admin worktrees because the app worktree tool could not target those repositories. Their terminal paths and branch names were verified; they remain separate checkouts.
- Reuse installed dependencies through symlinks. This avoids installing packages but requires runtime-aware native tests; no shared native dependency was rebuilt.
- Derive `policyBlockedLocalScopes` without persisting it. This distinguishes a deliberately blocked selection from an empty preference that normally inherits defaults; every final dispatch must honor that distinction.
- Carry main-process authorization through nested native calls using `AsyncLocalStorage` leases. Production managers receive the gate before startup; future managers must be added to that initialization, or could miss enforcement.
- Delegate independent admin/UI work with separate reviews while retaining the main-process work in the primary task. This adds coordination but keeps ownership and verification distinct.
- Default the rollout switch off, on the API: a numeric floor alone does not prove a qualifying desktop has shipped. One server-side switch lets rollout and rollback happen without rebuilding the console.
- Continue the original fixer for the re-review's enterprise-route regression and whitespace-only ID residual, rather than leave known defects at a nominal review-loop cap. Both narrow corrections received RED/GREEN tests and another scoped review; the cost was an extra verification round.
