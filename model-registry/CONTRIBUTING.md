# Contributing

Thanks for helping keep OpenWhispr's model list current. Every change is reviewed by a maintainer before it merges, and merging publishes it to installed apps, so please keep pull requests small: one model or one correction each.

## Setup

Use Node 24, then:

```sh
npm ci
npm test
npm run validate
node scripts/check-compat.cjs
node scripts/check-artifacts.cjs   # needs network
```

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

Some models need code in the app (a new reasoning control, a new adapter). Add the data here with `minAppVersion` set to the app release that will carry the code, then in the desktop repository run `npm run model-registry:sync -- --revision <publication commit>` alongside the code change.

## Releasing a desktop app that changes the catalog reader

If a desktop release changes `src/models/registrySchema.cjs`, `registryEnvelope.cjs` or `registrySelection.js`, add that reader here before the release:

1. Create `compat/clients/<contract>/` with those three files copied from the release, a `floor.json` (the release's `src/models/modelRegistryData.json`), and a `client.json` holding `{ "appVersion": "<release version>", "source": "OpenWhispr/openwhispr@<commit>" }`. `<contract>` is the `clientContract` in the release's `src/models/registryMetadata.json`.
2. Open a pull request. CI proves the folder name matches the files and that the current catalog works for that reader.

Until it merges and publishes, that release keeps using its bundled catalog.

## Licence

By contributing you agree that your contributions are licensed under the repository's licence.
