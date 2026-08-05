# Plan: P1-1 title guard, P1-2 provider-field corruption, P1-3 chat default

Date: 2026-08-05
Branch: `fix/pipeline-title-guard-and-provider-integrity` off `main` (a49af5a8)
Status: revision 2, after adversarial review. Awaiting confirm-only re-review.

Review returned 1 CRITICAL, 5 IMPORTANTs and 2 MINORs. I verified the three that change
the design myself (the localized placeholder, the selector's restore effect, and the
synchronous default read) before accepting. **Every finding is addressed below; none is
deferred.**

Three small fixes grouped because two of them (P1-2, P1-3) share a store and both
concern provider integrity, and all three concern "the model config the pipeline
actually runs with".

---

## P1-1 — The pipeline overwrites a title the user chose

### Symptom
A note the user titled themselves gets silently renamed by the automatic pipeline.

### Verified root cause
`postCallPipelineManager.js:117-126`, step 2 of `run()`:

```js
      const titleResult = await this._runStep(noteId, "title", () =>
        this._generateTitle(transcript)
      );
      if (titleResult.error) return;
      if (titleResult.value) {
        this._db.updateNote(noteId, { title: titleResult.value });
```

Unconditional. `run()` is reached automatically after every meeting via
`_enqueuePostCallPipeline`, and also from two explicit user actions —
`retry-pipeline-step` and `reprocess-all-meetings`.

The predicate to gate on already exists and is already used by the renderer
(`PersonalNotesView.tsx` imports it as ESM): `isRegenerableNoteTitle(title,
placeholders, calendarEventName)` in `src/helpers/regenerableNoteTitle.js`. It allows
regeneration only while the title is empty, a known placeholder, or the unedited
calendar event summary.

### Fix
Guard the write in `run()` step 2 with `isRegenerableNoteTitle`. **Do not guard
`runSingleStep`** (`:159-206`).

I2 (accepted): revision 1's reason for that was wrong. There is no "regenerate title"
action — `runSingleStep`'s only caller is the `regenerate-notes` handler with step
`"notes"` (`ipcHandlers.js:7168-7176`), so its title branch (`:184-191`) is **dead code
today**. Leaving it unguarded is still right (it is the explicit-regeneration entry point
if one is ever added), but no test should pretend to exercise it.

Consequence to accept, stated in the earlier plan and unchanged: `reprocess-all-meetings`
will no longer refresh an already-LLM-generated title. That is the correct trade — it
cannot distinguish an LLM title from a user's.

### C1 — localized placeholders are mandatory, not optional (accepted)

Revision 1 said "accept English-only placeholders". **That ships a regression worse than
the bug**, verified: `PersonalNotesView.tsx:386-393` / `:429-435` create notes titled
`t("notes.list.untitledNote")` — `"Nota sin título"` in Spanish
(`src/locales/es/translation.json`) — and `:247-259` starts a meeting recording on that
active note, which auto-enqueues the pipeline. `BUILTIN_PLACEHOLDERS`
(`regenerableNoteTitle.js:5`) is English-only, and the renderer is what normally supplies
localized ones (`PersonalNotesView.tsx:1065-1073`). A Spanish user would silently stop
getting titles generated at all.

So main must supply localized placeholders. It must **union the placeholder keys across
every locale file**, not just the current UI language: the note may have been created
while the app was in another language. Keys: `notes.list.untitledNote`,
`notes.list.newNote`, `notes.sidebar.newNote`. Main already has i18next
(`src/helpers/i18nMain.js`).

### I4 — re-read the title immediately before the write (accepted)

`run()` loads the note at `:98`, but the title write happens at `:123`, after a
re-transcription that can take minutes with the large model. Guarding on the stale
snapshot would still overwrite a user who titled the note mid-pipeline. Re-read
`notes.title` immediately before the write.

### Wire `calendarEventName`

Reachable from main and verified: `notes.calendar_event_id` (TEXT, `database.js:401`) →
`getCalendarEventById(eventId)` (`database.js:1813`) → `calendar_events.summary`
(`:382`). No new accessor needed.

Caveat to state (M2): `calendar_events` rows are purged on sync/account cleanup
(`database.js:1879`, `:1908`, `:1921`), so for a `reprocess-all-meetings` long after the
fact the lookup can return null. The guard then fails **closed** — it will not overwrite
a title the user kept. That is the safe direction.

**ESM/CJS**: `await import("./regenerableNoteTitle.js")` from CJS main works, including
inside a packaged asar (precedent at `ipcHandlers.js:3760`, `:6168`). Do not convert the
module — the renderer imports it as ESM.

---

## P1-2 — A model family is written into the provider field

### Symptom
`NOTE_FORMATTING_PROVIDER=gemma` in `.env`. "gemma" is not a provider.

### Verified root cause
`ReasoningModelSelector.tsx:501-503`:

```js
  const handleLocalProviderChange = async (providerId: string) => {
    setSelectedLocalProvider(providerId);
    setLocalReasoningProvider(providerId);
```

`providerId` here is a **local model family** — `qwen`, `mistral`, `llama`,
`openai-oss`, `gemma`, `liquidai` (from `modelRegistry.getAllProviders()`, `:365`) —
but `setLocalReasoningProvider` writes the *provider* field. `handleModeChange` does
the same at `:480` when switching to local mode.

`noteFormatting` inherits the value via `fallbackScope`, which is how it reaches the
pipeline's `_getInferenceConfig()` and then `.env`.

### Fix
The provider for every local family is `"local"` — confirmed as the established
convention: `InferenceConfigEditor.tsx:68`/`:97` already writes `provider: "local"`, and
`PROVIDER_REGISTRY` has a single `local` entry covering every GGUF family. So:
- write `provider = "local"` on the two **local** paths, `:480` and `:503` (M1: revision
  1 said `:497`, which is the cloud path it correctly leaves alone)
- the cloud path (`handleCloudProviderChange`) is correct as-is

### I1 — the selector's restore path must be fixed in the same change (accepted)

`ReasoningModelSelector.tsx:416-425` is the **only** thing that restores
`selectedMode`/`selectedLocalProvider` from persisted state, and it does so by
recognising a *family id* in the provider field. Writing `"local"` matches neither
`localProviderIds` nor `CLOUD_PROVIDER_IDS` (`:41-50`), so the component would silently
fall back to its defaults — mode `"cloud"`, family `"qwen"` (`:343-345`) — and one stray
click would rewrite a local user's config to cloud. "Keep the family in component state"
does not survive a remount.

So add a `localReasoningProvider === "local"` branch to that effect which sets mode
`"local"` and derives the family from the selected model
(`modelRegistry.getModel(reasoningModel)?.provider.id`).

**Migration for existing corrupted values.** Anyone who has already touched this selector
has a family id persisted; without a migration the fix only helps new users.

I5 (accepted) — the hazards revision 1 did not state:
- Complete family set from `modelRegistryData.json`: `qwen, mistral, llama, openai-oss,
  gemma, liquidai`.
- `"mistral"` is **also** a legitimate cloud transcription provider id, so the migration
  must touch only the four LLM provider keys — `cleanupProvider`, `noteFormattingProvider`,
  `dictationAgentProvider`, `chatAgentProvider` — and never a transcription key.
- Do **not** import `ModelRegistry` into `settingsStore.ts`: `ModelRegistry.ts:2` imports
  `settingsStore` (cycle). Import `modelRegistryData.json` directly.
- Use the existing module-scope, sentinel-guarded pattern (`migrateLLMScopeKeys`,
  `settingsStore.ts:354-370`; `migrateLegacyInferenceModes`, `:395-416`), which runs at
  import time before `create()` at `:889` reads any key. Place the new migration **after**
  `migrateLLMScopeKeys`, since that one can itself copy a corrupted legacy
  `reasoningProvider` into `cleanupProvider`.
- `.env` then self-heals on next launch via the always-run `syncNoteFormatting`
  (`ControlPanel.tsx:173-178`).

Also fix, alongside: 1.13.0's `MainProcessInference` safety-net list
(`mainProcessInference.js:5`) is `["gemma","qwen","llama","mistral","gpt-oss","phi"]`,
which does not match the registry — it misses `openai-oss` and `liquidai` and lists
non-existent `phi`/`gpt-oss` prefixes, so it silently fails for exactly the families the
migration is about.

Keep 1.13.0's `MainProcessInference` recovery as a safety net; it is not the fix.

---

## P1-3 — The chat default points at a provider the user has no key for

### Symptom
Chat fails with a 401 from groq while the UI shows the local card selected.

### Verified root cause
`settingsStore.ts:1170-1173`: `chatAgentModel` defaults to `"openai/gpt-oss-120b"` and
`chatAgentProvider` to `"groq"`, while `chatAgentMode` defaults to local. UI and runtime
disagree.

### Fix — gated, not unconditional
**Do not simply default to local.** `BUILTIN_LOCAL_MODEL_ID` is neither bundled nor
auto-downloaded; absent, the user gets `Model file not found` from `llamaServer.js`,
which is worse than a comprehensible 401.

Default to `local` + `BUILTIN_LOCAL_MODEL_ID` **only when
`modelCheck(BUILTIN_LOCAL_MODEL_ID)` passes**, mirroring the existing gate at
`ControlPanel.tsx:196-204`. Otherwise leave groq. With that gate the change is silent.

### I3 — the gate cannot live in the default expression (accepted)

`settingsStore.ts:1170-1173` is computed **synchronously at module load** — `readString`
(`:35-38`) is a bare `localStorage.getItem`, and `create()` runs at `:889`. `modelCheck`
is async IPC. So revision 1 was unimplementable as written.

It becomes an **async seed** in `initializeSettings()` (`settingsStore.ts:1920`), which is
already async and electronAPI-aware. Two consequences to honour:
- "The user explicitly chose groq" is only decidable as
  `localStorage.getItem("chatAgentProvider") === null` — the resolved state cannot tell a
  defaulted groq from a chosen one. The seed must check the raw key, and only seed when it
  is absent.
- `ControlPanel.tsx:170-171` carries a comment stating the chat scope's resolving default
  is deliberately left untouched. That invariant is changing, so the comment must change
  with it rather than being quietly contradicted.

---

## Carried into implementation from the confirm pass

Green-lit; three items to fold in while coding, none needing another review round:

1. **Chat seed: re-check after the await.** Check
   `localStorage.getItem("chatAgentProvider") === null` again *after* `modelCheck`
   resolves, immediately before writing — that closes the clobber window entirely.
   `initializeSettings()` is invoked once per window from a mount effect
   (`useSettings.ts:111-121`) before any user interaction, and the null-check makes two
   windows idempotent. Note honestly: once seeded the key is non-null forever, so a user
   who later deletes the Gemma model gets "Model file not found" — the same exposure as
   anyone who chose local then deleted the model, not introduced here, and the seed must
   not be claimed to prevent it.
2. **Restore effect: set the mode unconditionally.** When `localReasoningProvider ===
   "local"`, set mode `"local"` always, and apply the derived family only when
   `modelRegistry.getModel(reasoningModel)` resolves — it returns `undefined` for `""`
   (`ModelRegistry.ts:166-174`), so fall back to the component default `"qwen"` when
   nothing is downloaded. Add `reasoningModel` to the dependency array (`:425` is
   currently `[localProviders, localReasoningProvider]`) or the family never re-derives.
3. **Migration lives in its own module**, not exported from `settingsStore.ts`, so the
   test does not have to execute the store's module-level code to import it.

Implementation note for C1: `i18nMain.js:3-12` already bundles all **10** locales' full
`translation.json`, so the union is `i18nMain.t(key, { lng })` over
`SUPPORTED_UI_LANGUAGES` — no new file reads, works inside the asar, and it is plain CJS
so the regression test can require it under `node --test`.

## Test plan

Feasible under `node --test` (CJS mocks for the pipeline; `.ts` imports work directly, as
verified for the zustand store in the previous change):

- Title guard in `run()`: a user-typed title is not overwritten; empty and placeholder
  titles are; a **localized** placeholder ("Nota sin título") is regenerated — the C1
  regression test; the unedited calendar summary is regenerated; a title changed
  mid-pipeline is not overwritten (I4).
- `calendarEventName` resolved via `getCalendarEventById` reaches the guard, and a purged
  event (null lookup) fails closed.
- Migration, as a **pure exported function** so it is testable: each of the six family ids
  in each of the four LLM provider keys becomes `"local"`; a real provider id is
  untouched; a transcription provider key holding `"mistral"` is untouched; the sentinel
  makes it idempotent.
- `MainProcessInference`'s family list matches the registry's six ids.

Not automatable (stated rather than pretended): the selector's write and restore effect,
and the async chat seed, live in React components/effects and this repo has no React test
harness. The migration and the guard — the parts that can silently corrupt or regress —
are covered above; the component paths get manual verification.

Dropped from revision 1: "`runSingleStep` always regenerates regardless" would test dead
code (I2).

Gate: `npm run typecheck && npm run lint && npm test`.

---

## Open questions — all three answered by review

1. ~~Another automatic writer of `notes.title`?~~ **No.** The only automatic writers are
   `postCallPipelineManager.js:123` and `:189`. Everything else is user-initiated
   (PersonalNotesView save/flush `:296`/`:334`, the agent `update_note` tool, and
   upload/batch flows which set the title at creation via `saveNote` and never overwrite).
   `_tryAutoLabelOneOnOne` (`ipcHandlers.js:7587`) touches only speaker mappings. The guard
   is complete.
2. ~~Does `getAllProviders()` return cloud too?~~ **No** — `ModelRegistry.ts:198-214`
   registers only `modelData.localProviders`; cloud lives in `getCloudProviders()`. No
   mode-keying needed at that call site.
3. ~~Where does the migration live?~~ Module scope in `settingsStore.ts`, sentinel-guarded,
   after `migrateLLMScopeKeys` — see I5 above.

Corrected citations (M1): the ESM-from-CJS precedent is `ipcHandlers.js:3760` and `:6168`,
not `:3795`/`:6192`. `handleLocalProviderChange` is `:501-503`.
