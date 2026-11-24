<!-- For changes to model-registry/. See model-registry/CONTRIBUTING.md. -->

## What changes

<!-- One model or one correction. Name the provider and the model ID. -->

## Checklist

- [ ] The entry is in the matching file under `model-registry/registry/`, with an English `name` and `description`
- [ ] Nothing is deleted: a model that goes away is `retired` (with a `replacement` where one exists) or `legacy`
- [ ] Local downloads have a `sha256` for every file and are pinned to a commit
- [ ] I ran `npm run model-registry:sync` and committed the files it changed under `src/models/`
- [ ] If the model needs app code, the code is in this pull request and the entry has `minAppVersion`
- [ ] If the reader changed (`lib/schema.cjs`, `lib/envelope.cjs`, `lib/registrySelection.js`), the new reader is under `compat/clients/`

## How I checked it

<!-- For a cloud model: a request that worked. For a local model: the download and a transcription or reply. -->
