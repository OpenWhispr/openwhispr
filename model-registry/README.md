# OpenWhispr model registry

The list of models OpenWhispr desktop offers, kept as reviewed data in this folder of the main repository. A merged change here is signed and published, and installed apps pick it up without a new release. Provider integrations and native engines still ship in the app, so some models need app code as well; that code goes in the same pull request (see [CONTRIBUTING.md](CONTRIBUTING.md)).

Until November 2026 the registry was its own repository, `OpenWhispr/model-registry`. Its history is part of this repository's, and apps released before the move still read its `published` branch, which every publication from here is mirrored to.

## Files

- `registry/cloud-providers.json`: reasoning models for the existing cloud providers.
- `registry/transcription-providers.json`: transcription models and their streaming flag.
- `registry/enterprise-providers.json`: suggested models for Bedrock, Azure and Vertex, independent of tenant deployments and policy.
- `registry/local-gguf.json`: local reasoning models and optional draft models.
- `registry/whisper.json` / `registry/parakeet.json`: local transcription models.
- `registry/legacy.json`: preserved compatibility data, not editable.
- `registry/trusted-publishers.json`: Hugging Face organisations allowed to supply files.
- `test/seed.json`: the catalog of the first app that read the registry (the floor every publication must keep).
- `../src/models/`: the copy the desktop app bundles, generated from this folder by `npm run model-registry:sync` at the repository root. The desktop checks fail when it differs.
- `compat/clients/<contract>/`: the catalog readers of released apps, which CI tests every catalog against.

## A model's lifecycle

| State | How | What the app does |
|---|---|---|
| Active | default | Listed and usable. |
| Legacy | `"legacy": true` | Still works. Hidden from pickers unless it is the user's current choice or, for a local model, still downloaded. Can be set and cleared. |
| Retired | `"retired": true`, optional `"replacement": "<id>"` | No longer works (the provider shut it down, or a file was withdrawn). Never listed. Selections move to the replacement, or the provider default, and the user is told. One way only. |

Models are never deleted: retire them. Old caches and apps learn what happened from the retired entry. `minAppVersion` hides a new model from apps too old to use it, and stays fixed once published.

Each provider names its `defaultModel`, which must be active and can change at any time. List order is display order only.

## Correcting a published model

Names, descriptions, lifecycle flags, defaults and order can change freely.

A downloadable file is located by its URL or Hugging Face revision and proven by its SHA-256. Change one at a time, so the other still vouches for the bytes:

- **Move a file** (for example, a repository is renamed) while keeping its `sha256`. Moves to Hugging Face must be pinned to a 40-character commit.
- **Fix a wrong `sha256`** while the file stays at the same pinned revision.
- **Changing both** means it is a different file: add it under a new model ID and retire the old one.

A file without a hash can be given one first, then moved. File name, folder, engine type, quantization and context length identify the artifact and cannot change.

Request settings (`tokenParam`, `supportsTemperature`, `supportsThinking`, `disableThinking`, `supportsVision`, `supportsTools`, `reasoningEffort`, `thinkingFloor`) can change, but a wrong one breaks every request. CI lists such changes and fails until a maintainer checks them and adds the `capability-change` label.

## What CI checks

On every pull request that changes this folder (the `Model registry` workflow), without access to the signing key:

1. `npm test` and `npm run validate`: the catalog is valid, unknown fields are rejected, and every model the app bundles is still present.
2. `scripts/check-compat.cjs`: every released app's reader (plus this repository's own) accepts the catalog, keeps its bundled models, finds every default, and can read every entry not excluded by `minAppVersion`.
3. `scripts/check-previous.cjs`: the catalog is a valid next step from the live publication, and request-setting changes carry the `capability-change` label.
4. `scripts/check-artifacts.cjs`: every new or changed download exists at its source with the declared hash and size. GGUF files must start with the GGUF header, and Hugging Face files must come from a trusted publisher.
5. A publishing dry run (`REGISTRY_DRY_RUN=1 node scripts/publish.cjs`): the catalog is signed with a key made for that run, verified and committed to a local copy of the published branch. Nothing is pushed, so a change that would break publishing fails before it merges.

The desktop checks run on the same pull request: they prove the app's bundled copy equals this folder, then run the app's tests and this folder's tests together.

## How the app reads a publication

Apps read leniently: a field they do not know is dropped, an entry they cannot understand is skipped on its own (the bundled copy stands in if there is one), and the rest still applies. Provider endpoints and membership always come from the app. Each publication signs `testedClientContracts`, the readers CI ran it through. An app applies a publication only when its own reader is listed, otherwise it keeps its bundled catalog and last good cache.

When a change alters the reader (`lib/schema.cjs`, `lib/envelope.cjs` or `lib/registrySelection.js`), add the new reader under `compat/clients/` in the same pull request (see CONTRIBUTING.md). `npm run model-registry:verify` fails without it, so the pull request cannot merge.

## Publication and recovery

`Publish model registry` runs when a commit on `main` changes this folder, and never as part of an app release. It waits for a reviewer in the protected `registry-publish` environment, repeats the tests, the catalog validation and the reader and download checks in a job that has no key, then verifies the published branch, signs with Ed25519, and pushes to this repository's `model-registry-published` branch:

- `v2/manifest.json`: the current publication. `v2/history/<n>.json` keeps every version.
- `v2/schema.cjs`, `v2/envelope.cjs`, `v2/registrySelection.js`: the exact reader that published it.
- `manifest.json` and `history/` at the root: the retired v1 format, frozen at version 3.

A publication's source is the last commit that changed this folder, so an app merge neither republishes the catalog nor makes a waiting publication stale. A serialized, non-cancelling queue and a final "is this still the registry at the latest main?" check stop an older run from overwriting a newer publication.

Apps released before the move read `OpenWhispr/model-registry`'s `published` branch. The last step of every run pushes the commit this repository serves to that branch, and the run fails if it cannot. Before publishing, a run also takes in any version that repository published itself, so there is one version sequence while both exist. Neither branch is copied on trust: before each push the run checks that the publication is signed by a pinned key, is the newest entry of its own history, is not older than what it replaces, and was signed from a registry commit on `main`.

An app release bundles the signed publication of the catalog at its commit (`npm run model-registry:pin-release`). A release cut while a registry change is merged but not yet published fails with a message to approve the waiting publication first.

To undo a bad publication quickly, run **Roll back model registry** with the version to restore. It republishes that version's data under a new number: models retired since stay retired, and models added since come back as legacy (hidden from new choices, still working for anyone already using them). Then fix `main`, or its next publication will bring the bad data back. A model that must stop working for everyone (a broken file, a provider shutdown) is retired in a normal pull request instead.

A publication must keep testing every reader the last one was tested with. To stop serving a very old app, list its contract in `compat/dropped-clients.json` in a reviewed pull request.

## Keys

`REGISTRY_SIGNING_KEY` and the two deploy keys (one that may update `model-registry-published`, one for the mirror) live only in the `registry-publish` environment, which is limited to `main` and needs a reviewer's approval for every run; pull requests and other workflows never see them. Only public keys are checked in (`trusted-keys.json`). A second, offline recovery key is held separately by the maintainer; switching the signer to it, or recovering from a stolen key, needs an app release that trusts the new key. Apps refuse a version number more than 10,000 above the one they hold, so a stolen key cannot lock them out with one huge number.

This registry does not replace API inference routing, organisation policy catalogs, admin required-model choices, mobile catalogs or credential storage.
