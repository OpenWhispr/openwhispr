# Default Summary Template Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task after the user requests implementation. Steps use checkboxes for tracking. Do not commit, push, or create a branch without explicit user authorization.

**Goal:** Let users choose the template that the prominent post-meeting summary button displays and runs.

**Architecture:** Persist one template `client_id` in the existing desktop settings store. Derive the checked toggle and the summary button from the same template resolver. Reuse the existing template execution pipeline, including its summary persistence and undo behavior.

**Tech Stack:** Electron, React 19, TypeScript, Zustand, existing localStorage settings, Node test runner with the existing Vite renderer harness. No new dependencies.

**Spec:** The requested behavior and proposed decisions below form the specification for this small change. The user approved this plan and implementation on 2026-11-02.

## Requested behavior

- Users can select a built-in or custom summary template as their default.
- Existing users initially retain AI Summary as their default.
- The large blue pill shown when a meeting finishes displays and runs the selected default template.
- Selection happens through a toggle in the existing template/action manager.
- Confirmed: turning off the chosen default restores AI Summary; users cannot leave the button without a default.
- Confirmed: after a meeting's summary is deleted, the blue pill uses the current default template, regardless of the template previously used for that meeting.

## Proposed decisions

The user approved the following implementation decisions together with the plan.

- Enabling another template replaces the previous default. To maintain one effective default, disable the off action on AI Summary while it is the effective default.
- Label the control **Default summary template**, with helper text **Use this template for the summary button after a meeting.** Show a **Default** badge next to the selected template in the list.
- Show the toggle only for saved items with `kind === "template"`. For a new unsaved template, show **Save this template to set it as your default.** Chat actions are ineligible because they have a different execution/output path.
- The toggle persists immediately, independently of the template content Save/Update button. It never saves unsaved prompt edits or starts generation. Content edits still need Save/Update.
- The summary tab and regenerate picker continue to remember the template that produced the note's summary. Changing the default never rewrites an existing summary.
- Preserve **Generate AI Summary** for the built-in AI Summary. For other templates use the localized label **Generate with {{template}}**, interpolating the display name from `getActionName`.
- This is a desktop installation preference, shared by its windows, matching the current local template catalog. Cross-device/account preference sync and mobile UI are outside this change. Account-scoped defaults would require a different persistence decision.
- The same pill also appears for typed notes today. Apply the same default there; retain the current visibility rules.

## Global constraints

- Use the stable `client_id`, not a database row ID, display name, or translated label.
- Keep existing template prompts, built-in seeding, database schema, IPC contracts, and generation providers unchanged.
- No automatic generation, no bulk updates to notes, and no retroactive summary replacement.
- Retain existing recording, permission, empty-content, processing, and transcript-selection guards.
- Use existing `Toggle`, toast, translation, settings persistence, and template execution patterns.
- New TypeScript functions have explicit return types and no `any`.
- Work in the user-requested existing branch when implementation is authorized. The inspected checkout currently has detached HEAD; this plan does not select or create a branch.
- Do not install dependencies, change `.env` files, commit, or push as part of this plan.

## Current implementation

- `src/stores/actionStore.ts`: `resolveTemplate(templates, clientId)` currently prefers a note's template, then AI Summary, then the first available template. Action-created/updated/deleted IPC events already update the catalog across windows.
- `src/stores/settingsStore.ts`: string preferences already persist to localStorage and synchronize through the existing storage listener. `createStringSetter` writes storage before updating Zustand, so a failed write leaves the prior state intact.
- `src/components/notes/ActionManagerDialog.tsx`: edits templates and chat actions in separate tabs. The toggle belongs in the selected template's editor, with a badge in the list.
- `src/components/notes/NoteEditor.tsx`: currently uses one `noteTemplate` for both the regenerate picker and the blue pill. The pill's text is hardcoded to the AI Summary translation.
- `src/components/notes/NotesOnboarding.tsx`: also calls `resolveTemplate(templates, null)` to display the built-in template. Preserve its existing behavior.
- `src/stores/actionProcessingStore.ts`: already persists `action.client_id` as `enhancement_template_id` after successful generation. Reuse this behavior.
- Existing tests cover resolution, template editing, summary deletion, pill visibility, execution, and settings persistence.

## Review focus

1. A deleted, stale, or non-template preference must resolve to AI Summary, with UI and execution agreeing (Tasks 1–3).
2. Changing the default must not mislabel or rewrite a summary generated with a different template (Task 3).
3. A failed settings write must not display a successful default change or lose unsaved template edits (Task 2).
4. Rename, reload, and cross-window updates must preserve the selected identity and refresh the displayed label (Tasks 1–3).
5. Loading an empty catalog must neither overwrite the stored preference nor enable an unusable generation button (Tasks 1 and 3).

## Task 1: Persist and resolve the default

**Files:**

- Modify: `src/stores/settingsStore.ts`
- Modify: `src/stores/actionStore.ts`
- Modify: `test/stores/actionStoreTemplateResolution.test.js`
- Create: `test/helpers/settingsStoreDefaultSummaryTemplate.test.js`

**Interfaces:**

- Settings state: `defaultSummaryTemplateId: string`.
- Settings action: `setDefaultSummaryTemplateId(clientId: string): void`.
- New named export: `resolveDefaultTemplate(templates: ActionItem[], defaultClientId?: string | null): ActionItem | null`.
- Extend the existing export compatibly: `resolveTemplate(templates: ActionItem[], clientId: string | null | undefined, defaultClientId?: string | null): ActionItem | null`.

- [x] Add resolver tests asserting that a valid custom preference resolves to that exact object; missing/empty/invalid/retired/non-template IDs fall back to AI Summary; AI Summary is found by `GENERATE_NOTES_KEY`; an empty eligible catalog returns `null`; and a catalog without AI Summary falls back to its first eligible template.
- [x] Add precedence tests: `resolveTemplate(templates, previous.client_id, preferred.client_id)` returns `previous`, while a missing note template returns `preferred`. Preserve the existing two-argument resolution tests and update incomplete fixtures to include `kind: "template"`.
- [x] Add settings tests using the existing renderer harness: absent key defaults to `GENERATE_NOTES_KEY`; setting `"custom-template"` writes that exact string; reloading retains it; a storage event from another window updates state; a storage write exception leaves the previous value intact.
- [x] Run `node --import tsx --test test/stores/actionStoreTemplateResolution.test.js test/helpers/settingsStoreDefaultSummaryTemplate.test.js` and confirm the new assertions fail before implementation.
- [x] Add the setting with `readString("defaultSummaryTemplateId", GENERATE_NOTES_KEY)` and the existing string-setter pattern. Reuse the generic storage event handling. Reset by writing `GENERATE_NOTES_KEY`, not by removing the key, because the current listener ignores removals.
- [x] Implement the pure resolver: filter eligible templates, prefer the configured `client_id`, then built-in AI Summary, then first eligible template, then `null`. Have `resolveTemplate` prefer the note's valid template before delegating to this fallback. Keep these functions independent of the settings store.
- [x] Do not reset the saved ID during catalog loading or failed reads. Deleted IDs may remain stored but resolve safely; no database migration or deletion hook is needed.
- [x] Rerun the targeted command and confirm all tests pass.

## Task 2: Add the default toggle to the template manager

**Files:**

- Modify: `src/components/notes/ActionManagerDialog.tsx`
- Modify: `src/locales/*/translation.json`
- Modify: `test/components/actionManagerDialog.test.js`

**Interfaces:** Consume the Task 1 setting/setter and `resolveDefaultTemplate`. Reuse `Toggle` from `src/components/ui/toggle.tsx` and `useToast`.

- [x] Add interaction tests: AI Summary initially checked; selecting a custom template as default makes only that template effective; turning it off restores AI Summary; AI Summary cannot leave the catalog without a default; actions never offer this control; and unsaved templates show the save-first hint.
- [x] Add tests that toggling calls no create/update action IPC, leaves the prompt draft unchanged, survives switching between selected templates, and shows an error while retaining the previous default when persistence throws. Verify both `{success:false}` and rejected template saves still retain their drafts using the existing tests.
- [x] Run `node --import tsx --test test/components/actionManagerDialog.test.js` and confirm the added assertions fail.
- [x] Subscribe separately to all templates and the selected default ID, so switching to the Actions tab cannot change fallback resolution. Compute the checked state and list badge from the resolved default's `client_id`.
- [x] Add `handleDefaultChange(checked: boolean): void` to persist the selected saved template ID on enable or `GENERATE_NOTES_KEY` on disable. Catch storage errors and show **Couldn't update the default template. Try again.** Disable interaction while template saving is in progress and disable the active AI Summary toggle.
- [x] Add translation keys under `notes.templates`: `defaultLabel`, `defaultHint`, `defaultBadge`, `saveBeforeDefault`, `defaultSaveFailed`. Add `notes.editor.generateWithTemplate` for Task 3. Use the exact English copy in Proposed decisions and the error above; provide matching localized keys across supported locales.
- [x] Rerun the manager tests and `npm run i18n:check`; confirm the new controls and keys pass.

## Task 3: Route and label the blue pill using the default

**Files:**

- Modify: `src/components/notes/NoteEditor.tsx`
- Modify: `src/helpers/noteFieldSync.js` (comment only: clarify that retaining template identity serves regeneration, while the pill follows the current default)
- Modify: `test/components/noteEditorSummaryDeletion.test.js`
- Existing regressions: `test/components/meetingSummaryOffer.test.js`, `test/stores/actionProcessingNoteOutput.test.js`

**Interfaces:** Consume the Task 1 setting and resolvers. Keep `onRunNoteAction` unchanged and pass the resolved `ActionItem` to it.

- [x] Extend the existing NoteEditor harness to change the default through the real settings store. Assert the pill's label names the custom template and clicking passes that exact template to `onRunNoteAction`; repeat for the legacy AI Summary label and a typed note without a transcript.
- [x] Test changing the default while a note is open, renaming the preferred template, deleting it through the existing catalog event, and receiving a preference change from another window. The pill must show and run the same latest resolved template.
- [x] Test an existing summary written with template A while the global default is B: the tab remains A and regeneration still selects A; after deleting that summary, the pill runs B. Assert that changing preferences alone performs no generation and no note mutation.
- [x] Add empty-catalog coverage and retain tests for recording/processing/read-only/empty-note/selected-segment suppression. Run `node --import tsx --test test/components/noteEditorSummaryDeletion.test.js test/components/meetingSummaryOffer.test.js` and confirm the new assertions fail.
- [x] Derive `defaultTemplate` using `resolveDefaultTemplate(templates, defaultSummaryTemplateId)` and `noteTemplate` using `resolveTemplate(templates, note.enhancement_template_id, defaultSummaryTemplateId)`. Retain note identity for the summary label/picker. Use `defaultTemplate` for the callout's availability, label, and click handler.
- [x] Keep the existing summary-offer predicate and UI placement. Render the existing AI Summary text for `GENERATE_NOTES_KEY`, otherwise `t("notes.editor.generateWithTemplate", { template: getActionName(defaultTemplate, t) })`. Bound the pill to available width, truncate only the visual label, and keep the complete accessible button name; isolate interpolated user text according to existing bidi patterns.
- [x] Rerun the editor tests plus `node --import tsx --test test/stores/actionProcessingNoteOutput.test.js` to verify summary identity, persistence, and undo behavior still pass.

## Final verification and handoff

- [x] Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run i18n:check` under the repository's Node 24 environment. Run Prettier checks on changed files. Report unrelated baseline failures separately.
- [ ] Manually verify: finish a meeting → open template manager → save a custom template → select it and enable default → pill immediately changes → click once → resulting summary uses its instructions. Restart the app and verify the preference survives.
- [ ] Verify switching defaults and deleting a selected custom template from another window. Test long names, keyboard operation, and an RTL locale; preserve the existing blue pill styling and layout.
- [x] Review the focused diff using the custom `code-quality` skill. Deliver the changes and verification results without committing or pushing.

## Acceptance criteria

An existing installation behaves exactly as before until a default is changed. A saved custom template can become the sole default with one toggle, and the blue pill accurately names and runs it. The preference survives restart, existing summary content remains intact, and unavailable defaults fall back safely to AI Summary.

## Implementation verification record

- Implemented all three tasks without database/IPC migrations or added dependencies.
- Focused automated checks: 70 passed; 2 existing database-dependent tests skipped because the installed SQLite native binding is unavailable to Node 24.
- Type checking passed. Lint passed with existing warnings in unchanged files. All locale keys/placeholders passed validation.
- Independent read-only code-quality review: no actionable findings.
- Browser component preview: verified keyboard toggling, persistence after reload, restoring AI Summary, and Arabic RTL layout. Preview used a fixture catalog; actual meeting capture, AI generation, and native app restart were not exercised.
- Full-suite standalone Node 24 run with localhost permitted: 9,693 passed, 17 failed, 541 skipped, 1 todo. All 17 failures were the installed SQLite binding's ABI mismatch: 15 in `test/helpers/metaActivation.test.js`, 1 in `test/services/assistantNoteUndo.test.js`, and 1 in `test/services/noteEditPersistence.test.js`.
- Full-suite Electron Node 24 run (matching SQLite ABI): 10,274 passed, 8 failed, 14 skipped, 1 todo. The 8 failures are in unchanged `test/helpers/whisperVadModelPath.test.js`; its fixtures assign `process.resourcesPath`, which is read-only in Electron. All 9 tests in that file passed on a separate standalone Node 24 run.
- Supplemental Electron run of the three SQLite failure files and the entire NoteEditor regression file: 102 passed, no failures or skips. Thus the runtime-specific failures in each full run passed under their compatible runtime; neither full run individually was green. No dependency rebuilds or unrelated source/test changes were made.
- The initial sandboxed full run was interrupted after local-socket restrictions caused failures and stalled progress. All subsequent full runs allowed localhost sockets.
- Implementation was reviewed before the user authorized committing. Pushes remain user-managed.
