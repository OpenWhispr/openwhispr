# Dynamic model registry (v2)

Date: 2026-11-03. Replaces the 2026-10-14 design behind #2683/#2686 after code review of #2686 (39 findings). Registry side: `OpenWhispr/model-registry` branch `feat/catalog-lifecycle`.

## Outcome

The desktop model catalog lives in the public `OpenWhispr/model-registry` repository. A merged change is signed and published; installed apps apply it between releases. A release bundles a verified copy, so offline installs keep a complete catalog. Nothing a catalog contains can stop the app from starting.

No released app has read a publication yet (#2683 and its revert #2685 both landed before v1.10.4), so the published format changes to `schemaVersion: 2` at `published/v2/manifest.json`, continuing the version numbers of the frozen v1 manifest.

## Lifecycle (review finding 1)

| Flag                                    | Meaning                                                             | Changes   |
| --------------------------------------- | ------------------------------------------------------------------- | --------- |
| `legacy: true`                          | Still works; pickers hide it unless selected or (local) downloaded. | Both ways |
| `retired: true`, optional `replacement` | No longer works.                                                    | One way   |

Entries are never deleted; a retired entry tells old caches and apps what happened. `registryData` strips retired entries, so no picker, route or check can offer them, and keeps them in a retired index. `reconcileRetiredCloudModelSelections()` moves saved cloud and transcription selections to the replacement (or the provider default) at startup and on every catalog update, with the retired-model toast, which waits until the control panel has focus. `resolveRetiredCloudModel()` maps retired IDs at request dispatch for every hosted provider. Local retired models are not offered or loaded: Whisper and sherpa-onnx selections move to the replacement or the engine's recommended model, GGUF selections to a replacement on disk or to none, and Settings → Developer removes their files. An enterprise selection only follows a named replacement.

## Corrections (finding 2)

Every provider names an explicit, editable `defaultModel`; list order is display only. Downloads change one leg at a time: a file moves while its SHA-256 stays the same, or a wrong hash is corrected while the file stays at a pinned revision; changing both needs a new ID. Registry CI checks new and changed files against Hugging Face and GitHub (hash, size, GGUF header, trusted publisher). Request-setting edits (`tokenParam`, `supportsTemperature`, `reasoningEffort`, `thinkingFloor`, ...) need a maintainer's `capability-change` label. A rollback workflow republishes an earlier version's data, keeping everything retired since.

## Evolving the format (finding 3)

The registry authors strictly (unknown keys fail review); the app reads leniently through the shared `acceptCatalog`: unknown fields are dropped, an entry the app cannot read is skipped alone (its bundled copy stands in), provider endpoints and membership always come from the app, and it never throws. Fields an older app must understand travel with `minAppVersion`. Registry CI runs every catalog through each released app's reader (`compat/clients/`) and signs the readers it tested as `testedClientContracts`; the app applies a publication only when its own `clientContract` (recorded in `registryMetadata.json`, proved by `model-registry:verify`) is listed. A version more than 10,000 above the current one is refused. `npm run model-registry:release-check` fails a release build that pins no signed publication, or whose reader the live publication or the registry's `compat/clients` doesn't list.

## Boot safety and the loader (findings 4, 20, 21, 24–26)

`registryLoader.js` applies the bundled catalog at once, restores the cache (or its backup copy), and fetches immediately when neither is usable, otherwise after five seconds and every 15 minutes, with ETag revalidation. Invalid bundled data is used as shipped; a malformed app version only hides version-gated models. The logger starts before the loader. Settings → Privacy → Model list updates persists `OPENWHISPR_MODEL_REGISTRY_MODE=bundled` (no cache, no network). The synchronous preload IPC stays answerable after teardown.

## Missing catalog entries (findings 7, 13–15, 30, 34–36)

The localStorage "published history" and its unavailable-model error are removed. While a catalog is pending (one the app accepted before can't be used yet or, with updates off, the cache is newer than the bundle), an ID no catalog knows is left alone rather than replaced, and cloud requests pass it through. Otherwise it moves to the provider's default with a notice. A verified publication no newer than the catalog in use ends the pending state. Also, `installedModels.js` records every downloaded local model so main merges it back when its catalog entry is missing. Unknown Parakeet models fail closed, and a missing local model never triggers the cloud fallback.

## Not in this change

Streaming opening-audio fixes (findings 9–12, 29a) are a separate PR. Mobile catalogs and the API/admin required-model list (finding 23), an org policy for polling, manifest expiry (27) and staged rollout are follow-ups.

## Before release

Merge and publish the registry change, then `npm run model-registry:sync -- --revision <v2 publication commit>` so the bundle is the signed v4 publication and the reader is the one CI tested.
