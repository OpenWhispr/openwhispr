# OpenWhispr model registry

The list of models OpenWhispr desktop offers, kept as reviewed data. A merged change is signed and published, and installed apps pick it up without a new release. Provider integrations and native engines still ship in the app, so some models need an app release as well (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Files

- `registry/cloud-providers.json`: reasoning models for the existing cloud providers.
- `registry/transcription-providers.json`: transcription models and their streaming flag.
- `registry/enterprise-providers.json`: suggested models for Bedrock, Azure and Vertex, independent of tenant deployments and policy.
- `registry/local-gguf.json`: local reasoning models and optional draft models.
- `registry/whisper.json` / `registry/parakeet.json`: local transcription models.
- `registry/legacy.json`: preserved compatibility data, not editable.
- `registry/trusted-publishers.json`: Hugging Face organisations allowed to supply files.
- `test/seed.json`: the catalog the desktop app bundles (the floor every publication must keep).
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

On every pull request, without access to the signing key:

1. `npm test` and `npm run validate`: the catalog is valid, unknown fields are rejected, and every model the app bundles is still present.
2. `scripts/check-compat.cjs`: every released app's reader (plus this repository's own) accepts the catalog, keeps its bundled models, finds every default, and can read every entry not excluded by `minAppVersion`.
3. `scripts/check-previous.cjs`: the catalog is a valid next step from the live publication, and request-setting changes carry the `capability-change` label.
4. `scripts/check-artifacts.cjs`: every new or changed download exists at its source with the declared hash and size. GGUF files must start with the GGUF header, and Hugging Face files must come from a trusted publisher.

## How the app reads a publication

Apps read leniently: a field they do not know is dropped, an entry they cannot understand is skipped on its own (the bundled copy stands in if there is one), and the rest still applies. Provider endpoints and membership always come from the app. Each publication signs `testedClientContracts`, the readers CI ran it through. An app applies a publication only when its own reader is listed, otherwise it keeps its bundled catalog and last good cache.

When an app release changes its reader, add that reader under `compat/clients/` first (see CONTRIBUTING.md); until then the new release runs on its bundled catalog.

## Publication and recovery

`Publish signed catalog` runs on `main` in the protected `registry-publish` environment, repeats every check, signs with Ed25519, and pushes to the `published` branch:

- `v2/manifest.json`: the current publication. `v2/history/<n>.json` keeps every version.
- `v2/schema.cjs`, `v2/envelope.cjs`, `v2/registrySelection.js`: the exact reader that published it, which desktop vendors.
- `manifest.json` and `history/` at the root: the retired v1 format, frozen at version 3.

A serialized, non-cancelling queue and a final "is this still the latest main?" check stop an older run from overwriting a newer publication.

To undo a bad publication quickly, run **Roll back the signed catalog** with the version to restore. It republishes that version's data under a new number: models retired since stay retired, and models added since come back as legacy (hidden from new choices, still working for anyone already using them). Then fix `main`, or its next publication will bring the bad data back. A model that must stop working for everyone (a broken file, a provider shutdown) is retired in a normal pull request instead.

A publication must keep testing every reader the last one was tested with. To stop serving a very old app, list its contract in `compat/dropped-clients.json` in a reviewed pull request.

## Keys

`REGISTRY_SIGNING_KEY` lives only in the `registry-publish` environment; pull requests never see it. Only public keys are checked in (`trusted-keys.json`). A second, offline recovery key is held separately by the maintainer; switching the signer to it, or recovering from a stolen key, needs an app release that trusts the new key. Apps refuse a version number more than 10,000 above the one they hold, so a stolen key cannot lock them out with one huge number.

This registry does not replace API inference routing, organisation policy catalogs, admin required-model choices, mobile catalogs or credential storage.
