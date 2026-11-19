# Note correctness provider acceptance

The adjacent JSON contains synthetic cases for output review. Local tests check
field persistence and request wiring; scripted provider calls do not establish
that a model chooses the right tool or preserves meaning.

Before release, replay these cases on each supported provider/model selected for
acceptance, using an isolated synthetic profile. Run both note chat and the
assistant panel, fresh and after an email draft result. Keep email actions mocked
or in a dedicated non-production sandbox. Record model, build SHA, complete
request/response, emitted tools, before/after stored fields and reopen result.

For edits, require either the correct saved field or an appropriate clarification
when the target is ambiguous. No email action is acceptable for a clear note-edit
request. Include explicit email edits as controls so the change does not suppress
legitimate follow-ups. Reopen the note and check unrelated text byte-for-byte.
Exercise save failure, cancellation before save and switching notes.

For shortening, email and to-do output, review every required meaning in the JSON,
including status/negation, task-specific deadlines and event order. Concision and
a successful request are not semantic passes. Record failures and rerun after
repairs; do not replace this review with substring checks on model output.

For `templateCases`, use the note's template picker and Generate AI Summary,
or build the request with `compileTemplatePrompt` and `buildNoteRunInput`.
Run each listed template with thinking enabled and disabled, temperature 0.3
and the app's 4096-token output budget. Use seed 42 when supported to replay the
1:1 exclusion regression from #3131. General AI Summary must retain substantive
personal content; 1:1 must omit unrelated personal topics while retaining work
and work-relevant personal context. When nothing remains in scope, require the
marker and verify that regeneration leaves the saved note unchanged.

Deterministic coverage lives in `noteEditPersistence.test.js` (real SQLite,
including reopen), `noteEditSurfaces.test.js` (mounted note hook/assistant panel,
real chat pipeline with scripted cloud/BYOK responses), and
`noteEditCancellation.test.js` (pending edit cancelled by a note switch).
