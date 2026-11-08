# Personal BYOK fork

Repository: https://github.com/SLOPTIMUS-PRIME/openwhispr
Upstream base: 7a6ae826de9ec1caf65f3a6e769475dab2ae829f (1.10.4).
Implementation branch: feat/byok-cleanup.

## Requested behavior

- Preserve existing recording, global hotkeys, text insertion, history, notes, local models and direct API-key providers.
- Let the user enter any cleanup/reasoning model ID manually alongside model discovery. OpenRouter IDs, including colon suffixes such as `:nitro`, must be persisted and sent unchanged. Discovery must not be an allowlist or overwrite manual selections, including on refresh, reload or provider-tab switching.
- Add OpenRouter as an explicit batch speech-to-text provider, with live STT-only model discovery and manual full model IDs. Use the dedicated OpenRouter transcription endpoint consistently for dictation, retries and uploaded files. Preserve existing custom-endpoint selections and keys.
- Offer checkbox controls for currently supported OpenRouter model suffixes on both LLM and STT selectors. Nitro, Floor and Exacto are competing routing sorts, so selecting one replaces another; allow the free catalog variant only when that actual model variant is listed. Do not invent model variants or expose deprecated/batch-only variants as usable synchronous transcription/chat options. Explain STT routing limitations rather than claiming a throughput/price effect that the transcription endpoint does not document. Preserve full suffixes through discovery, refresh, reload and actual requests. Keep manually supplied unknown suffixes unchanged until the user edits them.
- Add an explicit Gemini batch Smart cleanup switch (default off), passing `generation_config.transcription_config.mode: "smart"` for Gemini 3.5 Transcribe when enabled. It removes fillers, false starts and spoken corrections without a second LLM call. Preserve normal verbatim behavior when off. Do not imply OpenRouter smart-mode forwarding has been verified; direct Gemini support is the first supported path. Keep unrelated providers and live modes unchanged. Ensure dictation, retry and file-transcription paths use the setting consistently where they call Gemini batch.
- Make this a personal/local and BYOK desktop client: remove reachable OpenWhispr account/sign-in, subscriptions, upgrade nags and managed-cloud selection flows. Do not falsely unlock paid hosted APIs, simulate paid entitlements, delete user data or remove local/BYOK functions. Prefer a small explicit fork policy over wholesale deletion of upstream internals. Prevent upstream account/service background requests that are no longer needed. Existing cloud selections should fall back to personal configuration without changing keys or losing their saved values.
- Nick subsequently authorized removing the upstream desktop package and deploying this fork on nick-cachy without further prompts. Preserve existing settings, API keys, history and notes; keep a private rollback backup. Do not inspect private recording contents or print credentials.

## OpenRouter behavior

OpenRouter speech-to-text discovery uses `GET /api/v1/models?output_modalities=transcription`; LLM discovery filters for text output. Both selectors expose Nitro, Floor and Exacto as mutually exclusive routing choices, with Free enabled only for an actual catalog variant. Full model IDs remain editable and are sent unchanged. Catalog lookups remove routing-only suffixes, not `:free`.

Speech-to-text uses the dedicated JSON endpoint and explicitly requests `provider.data_collection: "deny"`. It never falls back to an OpenAI endpoint or substitutes an OpenAI model when no OpenRouter model is selected. The existing custom transcription key slot is reused, so choosing OpenRouter does not require moving or exposing saved credentials. Uploads, dictation and retries share this transport. The synchronous API does not use Batch variants; deprecated variants are not offered as checkbox choices. OpenRouter documents limited routing controls for transcription, so the UI does not promise that Nitro/Floor/Exacto change its routing.

References: [model variants](https://openrouter.ai/docs/guides/routing/model-variants/overview), [Nitro](https://openrouter.ai/docs/guides/routing/model-variants/nitro), [Floor](https://openrouter.ai/docs/guides/routing/model-variants/floor), [speech-to-text API](https://openrouter.ai/docs/guides/overview/multimodal/stt).

## Delivery and verification

Use focused failing regressions before implementation, then run focused tests, typecheck, lint and renderer build. Exercise the actual modified app UI with isolated data and verify persistence of a full model ID such as `vendor/example:nitro` and Gemini Smart cleanup selection. Keep test records internal; do not ship extra verification bundles. Report any blocked or untested journey honestly.

Keep personal-fork changes on `feat/byok-cleanup`; keep `main` available for tracking upstream and trusted workflow controllers. Nick authorizes committing and pushing verified fork work, and automatic conflict resolution and merging of upstream maintenance changes into the personal branch under the rules below. Nick additionally approved automatic verified package builds, personal GitHub releases, and in-app desktop updates. The upstream-maintenance workflow still changes source only; a separate personal-release workflow builds and checks the exact source before publishing. Preserve MIT attribution.

## Rules for automatic upstream maintenance

`FORK.md` is the current owner-approved behavioral contract, not a frozen patch list. Preserve the outcomes described here, not particular file layouts or implementation details. Claude Code is the requested coding agent for upstream maintenance.

- Follow upstream production releases for applicable bug fixes, security fixes and necessary compatibility/dependency changes. Do not blindly reset to upstream or pull unreleased upstream development into the personal branch. Do not add unrelated features solely because they arrived upstream.
- Automatically resolve conflicts and merge verified maintenance changes into `feat/byok-cleanup` without asking Nick for routine approval. Reimplement a customization against changed upstream internals when necessary, provided its intended behavior is preserved.
- Never reintroduce OpenWhispr advertising/upgrade nags, sign-in requirements, subscription/plan screens, hosted-service selection flows or unnecessary account-service requests. Keep the application personal, account-free and local/BYOK.
- Preserve manual full model IDs, OpenRouter transcription and cleanup, routing controls and request privacy, Gemini batch Smart cleanup, and the ordinary recording/local-provider/data-preservation behavior described above.
- Every future owner-requested change must update this contract, `.github/personal-fork-policy.json` (requirement IDs and protected-test mapping), and its relevant regression tests in the same change as the implementation. Read the latest contract and tests from the current personal branch at the start of each maintenance run; do not use a fixed copy embedded in a prompt or schedule. Do not infer changed owner intent from upstream code, issue text or the maintenance agent's preferences.
- The maintenance agent may adapt implementation and add tests, but must not weaken/delete owner requirements or acceptance checks to make an upstream update pass. A deliberate owner change can replace an older requirement; record that explicitly with its corresponding tests.
- Before merging, run the fork behavior checks, affected upstream regressions, typecheck, lint, renderer build and isolated application checks. Verify the exact candidate commit; reject a stale result if the personal branch or contract changed during the run. Missing checks, unresolved conflicts or a behavior that cannot be preserved must leave the personal branch unchanged and be reported for attention.
- Keep maintenance changes reviewable in Git with their upstream origin and test results. Do not force-push the personal branch, overwrite concurrent owner work, create release tags or install desktop packages from this workflow.

These rules authorize the intended workflow; this document alone does not enable a scheduler or connect Claude Code to GitHub Actions.

## Upstream automation and rollback

Stock release workflows remain disabled. The personal-release workflow may publish Linux x86_64 AppImages and update metadata to this fork only, after the protected behavior tests, typecheck, lint, build and packaged runtime checks succeed. Use the maintained Electron/native dependency versions, not a frozen upstream runtime. Do not publish a stale source revision or credentials.

The Linux app checks this fork's `personal` update channel at startup and periodically, never the stock upstream releases. With Automatic updates enabled, it downloads a verified AppImage and restarts only when dictation, meetings, uploads and processing are idle, activity reports are current, the settings/control-panel window is hidden, and the computer has been idle for at least one minute. Manual restart also waits for recording/processing to finish. Disabling Automatic updates prevents unattended downloads and restarts; manual checks remain available. Invalid downloads must leave the running installation intact.

Install the AppImage in Nick's writable application directory with a stable launcher, preserving the `OpenWhispr` application identity, user-data path and keyring namespace. The first migration from the system package is authorized; retain a private package and user-data backup and verify the running app after cutover. Updates must not require root or discard settings, credentials, history or notes.
