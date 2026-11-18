# Contributing

Thanks for helping keep OpenWhispr's model list current. Every change is reviewed by a maintainer before it merges, and merging publishes it to installed apps, so please keep pull requests small: one model or one correction each.

Pull requests go to `OpenWhispr/openwhispr`, the repository this folder is part of. Adding `?template=model-registry.md` to the address of the "Open a pull request" page fills in the checklist.

## Setup

Use Node 24. From the repository root:

```sh
npm ci --ignore-scripts              # once; the registry uses the app's dependencies
npm run model-registry:sync          # after every change here: updates the app's bundled copy
npm run model-registry:verify        # the bundled copy matches, and the catalog is valid
node --test "model-registry/test/*.test.cjs"
node model-registry/scripts/check-artifacts.cjs   # needs network
```

Commit the files `model-registry:sync` changes under `src/models/` with your change; CI fails when they differ. To work on the registry alone, `cd model-registry && npm ci && npm test` still works.

## Adding a model

1. Add it to the matching file in `registry/` (see the README for which file holds what). `name` and `description` are required, in English.
2. Use an existing provider and its existing transport. A new provider, endpoint, request format or native engine needs a desktop app change first.
3. Local downloads need:
   - a `sha256` for every file, including a draft file if there is one;
   - for GGUF models, the full 40-character Hugging Face commit in `revision` (and `draftRevision`);
   - for Whisper or Parakeet, a download URL pinned to a commit, i.e. `/resolve/<commit>/`.
   CI checks these against the real files.
4. Files from a Hugging Face organisation not yet in `registry/trusted-publishers.json` need a maintainer to add the organisation, in its own pull request.
5. If the model only works with a newer app (for example it needs a new setting the app must understand), set `minAppVersion` to the first app version that supports it.

## Retiring or correcting a model

Never delete an entry. Set `"retired": true` and, when there is a successor in the same provider, `"replacement": "<id>"`. To hide an old model but keep it working for people already using it, set `"legacy": true`. The README explains how to correct a download URL or hash.

## When the desktop app needs to change too

Some models need code in the app (a new reasoning control, a new adapter). Put both in one pull request: the data here with `minAppVersion` set to the app release that will carry the code, the code in the app, and the bundled copy from `npm run model-registry:sync`. Installed apps older than `minAppVersion` ignore the model once it is published.

## Changing the catalog reader

`lib/schema.cjs`, `lib/envelope.cjs` and `lib/registrySelection.js` are the reader every app carries. If your change alters one of them, add the new reader in the same pull request:

1. Run `npm run model-registry:sync`, then create `compat/clients/<contract>/` with the three files copied from `lib/`, a `floor.json` (a copy of `src/models/modelRegistryData.json`), and a `client.json` holding `{ "appVersion": "<the release that will carry it>", "source": "OpenWhispr/openwhispr@<commit>" }`. `<contract>` is the `clientContract` in `src/models/registryMetadata.json`.
2. CI proves the folder name matches the files and that the catalog works for that reader.

A release build fails until its reader is listed there and a publication has been tested with it.

## Licence

By contributing you agree that your contributions are licensed under the repository's licence.
