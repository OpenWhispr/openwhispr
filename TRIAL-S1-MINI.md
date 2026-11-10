# S1-mini trial build B: its own prompt profile

**Trial only. Not for merge or release.**

This branch makes Superwhisper's S1-mini (a Qwen3-0.6B fine-tune for dictation
cleanup) selectable as a local cleanup model and gives it its own handling
through a per-model prompt profile (`src/config/cleanupPromptProfiles.ts`):

1. Its own system prompt and control line in place of the shared cleanup prompt
   and `<transcript>` wrapper, with thinking off and temperature 0.
2. Dictations over 600 words are split at sentence ends, cleaned part by part
   and re-joined in order (`src/utils/splitAtSentenceEnds.ts`).
3. A wider output check (its own commit, easy to drop): an empty answer to
   real speech, or an answer far longer than what was said, keeps the raw text
   and raises the usual cleanup notice.

Every other model behaves exactly as before. The profile applies only to
default dictation cleanup: a custom cleanup prompt, the agent and note
formatting are sent as written. The profile does not carry the custom
dictionary, Tone & Style or the language instruction, because the model was
not trained on them. The sibling branch `feat/s1-mini-shared-prompt-trial`
(build A) keeps the shared prompt.

## What is trial-only here

`src/models/modelRegistryData.json` is edited by hand. That file is a vendored
copy of the public `OpenWhispr/model-registry` catalogue, so on this branch
`npm run model-registry:verify` (and therefore `npm run quality-check`) fails
by design, and a published catalogue would drop the entry. Run the build with
`OPENWHISPR_MODEL_REGISTRY_MODE=bundled` so the bundled list is the one used.
`superwhisper` is also added by hand to `TRUSTED_HF_PUBLISHERS` in
`src/helpers/registryDownloadTrust.js`, a list that is meant to be copied from
the registry. `test/scripts/modelRegistrySync.test.js` fails for the same
reason as the verify script.

## What a real release needs instead

- Add the model in `OpenWhispr/model-registry` with `minAppVersion`, a pinned
  `revision` and the SHA-256 below, then `npm run model-registry:sync` here.
- Add `superwhisper` to the registry's `trusted-publishers.json` first, then
  copy the list into `src/helpers/registryDownloadTrust.js`.
- Add a `descriptionKey` with translations, and the model to
  `lib/local-model-catalog.ts` in openwhispr-api and openwhispr-admin.
- Licence: Apache 2.0 plus a naming clause. The model must be shown as
  "S1-mini" by "Superwhisper" with that capitalisation, and LICENSE and NOTICE
  ship with any redistribution of the file.

## Model file

`s1-mini-q4_k_m.gguf`, 484,219,808 bytes, from `superwhisper/s1-mini-GGUF`,
SHA-256 `3b41ebe2502cbd03e811d5d16b022f5ab551eda58d62597d152f89535003c634`.
