# Local selected-text editing repair implementation plan

> **For agentic workers:** Use the authorized native execution method: the main agent owns all production code and test changes; delegated investigation/planning and independent review remain read-only. The execution authorization in the handover overrides the writing-plans skill's routine approval stop. Track the steps below as implementation proceeds.

**Goal:** Correct the selection-edit response contract, improve the local editing request, and measure the resulting edit quality without weakening delivery safeguards or claiming model reliability from valid JSON.

**Architecture:** Keep cloud and other existing providers on the corrected strict marker contract. Give bundled local selection edits a dedicated instruction and a constrained one-field JSON response. Forward the optional contract through the existing local service/IPC/model/server chain, decode once at the selection boundary, and preserve the decoded replacement through delivery.

**Tech stack:** Electron, React, TypeScript/JavaScript, Node 24, node:test + tsx, llama-server's existing JSON response-format support. No new runtime dependency, provider, setting, or approval UI.

**Spec:** the 2026-10-06 local selection-edit RCA and implementation handover (kept outside this repository).

## Global constraints

- Base: `f770e9211` (`origin/main`); main agent owns branch/worktree lifecycle.
- Do not alter `/Applications/OpenWhispr.app`, production profiles/settings, real notes, or concurrent work. Synthetic fixtures and a disposable development profile only.
- Do not merge, deploy, release, send external messages, switch local text to cloud, change the default model, or redesign the product.
- Preserve nonempty output, exact contract, truncation, cancellation, captured session, and target checks. An empty response is never permission to delete the selection. A legitimate unchanged response remains allowed.
- Cleanup and ordinary chat keep their current request/response behavior. The selected edit is a separate route; do not add a cleanup pass.
- Every added user-facing message must use i18n and cover every existing `src/locales/*/translation.json` (11 currently present, despite older documentation's count).
- Keep meaningful regression, direct-model, native, and saved-text/undo evidence distinct. The old F/G 18/22 holdout results are a measured limitation, not a shipping threshold.

## Diagnosis refreshed on the current base

Read-only synthetic replay imported both the frozen installed helper and the current source helper. Both produced these results:

| Probe                                | Installed helper                              | Current base |
| ------------------------------------ | --------------------------------------------- | ------------ |
| Prompt prints marker followed by `.` | Yes                                           | Yes          |
| Replacement followed by exact marker | Accepted                                      | Accepted     |
| Replacement followed by marker + `.` | Untyped `incomplete` error                    | Same error   |
| Replacement followed by marker twice | Accepted; first marker remains in replacement | Same gap     |

The replay proves the contract mismatch and wrong error classification, not native model quality. No server or app was launched by the planner.

Current flow is `audioManager.processAgentCommand` → `processWithReasoningModel` → `ReasoningService.processText` → `services/ai/inferenceProviders/local.ts` → `process-local-reasoning` IPC → `localReasoningBridge.processText` → `modelManagerBridge.runInference` → `llamaServer.inference`. The result returns to the helper validator before `pendingSelectionEdit` is banked and then goes to `replaceSelectedText` with the captured session.

Changes since the investigated checkout that affect the repair:

- `414319448` introduced provider errors with code, messageKey, messageParams, settingsTarget, and redacted technicalDetails. The selection catch currently replaces these with a generic failure: preserve classified errors while marking the operation fatal.
- Local context sizing now supports `refuseClippedByWindow`; preserve strict selection budgeting and its 8192 output / 16384 minimum context requests. Do not silently enable the window-shrinking option for selection edits.
- The server now has keep-resident/idle-slot logic; do not change it or use production settings to keep a benchmark alive.
- Linux capture gained `modifiers_held` and `focus_moved` dispositions. Keep those cases and existing capture/paste tests.
- `stripThinkingTags` scans raw text, so applying it to JSON would remove literal `<think>...</think>` inside a document string. Structured output must bypass this transform.
- `finalizeChineseScript` currently runs after selection output; a decoded replacement must bypass that automatic transform when an edit session has been banked.

## Review focus

1. A valid replacement containing literal thinking tags, quotes, backslashes, or boundary whitespace must arrive unchanged; cover helper parsing and the real local chain in Tasks 1–2.
2. A schema-shaped reply with unknown/missing completion status or content only in reasoning metadata must fail before session banking; cover the HTTP stub in Task 2 and routing in Task 3.
3. Failure classification must keep provider recovery details and prevent ordinary-dictation fallback; cover Task 3.
4. Customized assistant preferences, dictionary hints, another-language commands, and wake names must not reintroduce generic dictation instructions or override an explicit transformation; cover Tasks 3–4.
5. A late result after cancellation/new recording, a changed target, or identical text in a different field must not be described as safely accepted based only on mocks; preserve automated guards and perform native Task 5 checks.

## File ownership and boundaries

- `src/helpers/selectionEditing.js`: corrected marker instruction, dedicated local prompt/user-request helpers, exact single-field JSON decoder, typed contract failures.
- `src/services/BaseReasoningService.ts`: optional typed local response-format field.
- `src/services/ai/inferenceProviders/local.ts`, `preload.js`, `src/helpers/ipcHandlers.js`, `src/types/electron.ts`: existing pass-through chain; change only where typing/forwarding requires it, test the live adapter shape.
- `src/services/localReasoningBridge.js`, `src/helpers/modelManagerBridge.js`, `src/helpers/llamaServer.js`: forward response format, send JSON schema on the wire, enforce structured completion/content, preserve raw structured text.
- `src/helpers/audioManager.js`: select contract using the actual resolved provider, bank only validated replacement, retain cancellation and meaningful errors, bypass post-edit script conversion.
- `src/utils/localInferenceError.ts` and every locale translation file: new structured failure codes/messages if they cross IPC; no new toast design.
- Existing focused helper/service/renderer tests: add behavior coverage in their current harnesses. New test files are justified only for a boundary not already covered.
- `scripts/` or `test/fixtures/`: small synthetic eval harness/fixtures if needed for repeatable direct-model qualification; keep model output artifacts separate from automated test success.

## Task 1: Correct strict marker handling and add exact JSON decoding

- [x] Add a failing regression to `test/helpers/selectionEditing.test.js` before implementing:

  ```js
  const marker = "__OPENWHISPR_SELECTION_COMPLETE_regression__";
  const prompt = buildSelectionEditSystemPrompt("custom preference", marker);
  assert.ok(prompt.endsWith(`: ${marker}`));
  assert.ok(!prompt.includes(marker + "."));
  assert.throws(
    () => extractSelectionEditReplacement("Edited" + marker + ".", marker),
    (error) => error.code === "SELECTION_EDIT_INVALID_RESPONSE"
  );
  assert.throws(
    () => extractSelectionEditReplacement("Edited" + marker + marker, marker),
    (error) => error.code === "SELECTION_EDIT_INVALID_RESPONSE"
  );
  ```

- [x] Run `node --import tsx --test test/helpers/selectionEditing.test.js` and retain the baseline failures. Then put the exact marker inline at the end of its instruction, with no demonstrated period or newline, explicitly forbid anything after it, and require exactly one occurrence. Preserve replacement whitespace and the nonblank guard. Missing/wrong/partial/duplicate/trailing-junk marker responses are invalid responses, not proof of token truncation.
- [x] Add `extractLocalSelectionEditReplacement(result)` with a strict lexical envelope for exactly `{"replacement": <JSON string>}` before `JSON.parse`. An anchored one-property envelope rejects duplicate/extra keys that `JSON.parse` alone loses. Parse the entire matched object; JSON.parse still validates escapes/control characters. Require a nonblank string and return it without trimming. Reject fences, prefixes, suffixes, arrays, null, wrong types and duplicate keys.
- [x] Pin exact round trips and typed rejection cases:

  ````js
  const text = '  "quoted" \\ path\n<think>literal document</think>\n';
  assert.equal(extractLocalSelectionEditReplacement(JSON.stringify({ replacement: text })), text);
  for (const raw of [
    '{"replacement":"one","replacement":"two"}',
    '{"replacement":"one","other":true}',
    '{"replacement":null}',
    '{"replacement":"   "}',
    '{"replacement":"one"} trailing',
    '```json\n{"replacement":"one"}\n```',
  ])
    assert.throws(() => extractLocalSelectionEditReplacement(raw));
  ````

  Embedded marker-looking text in a JSON string is document data and must survive.

- [x] Rerun the helper test, review the decoder's accepted grammar, and commit the cohesive helper/tests change with named-file staging.

## Task 2: Carry the constrained response through the complete local chain

- [x] Add an optional `responseFormat` to `ReasoningConfig`, limited to the tested local dialect:

  ```ts
  responseFormat?: {
    type: 'json_object';
    schema: {
      type: 'object';
      properties: { replacement: { type: 'string' } };
      required: ['replacement'];
      additionalProperties: false;
    };
  };
  ```

  A reusable named type with this shape is fine. Do not use an untyped arbitrary provider schema or forward it to a cloud route.

- [x] Extend `test/helpers/localReasoningBridgeChain.test.js` so the existing real loopback HTTP stub sees `response_format` on a structured request and sees no added key on ordinary cleanup requests. Forward the option through both field rebuilds (`localReasoningBridge`'s inferenceConfig and `modelManagerBridge`'s server invocation). Local provider and IPC already pass config, so verify rather than rewrite them.
- [x] For constrained responses, require `finish_reason === 'stop'` and the existing `requireCompleteOutput` condition, and return only `message.content`. `length`/`max_tokens` retains `OUTPUT_TRUNCATED`; absent/unknown completion fails as `OUTPUT_COMPLETION_UNVERIFIED`; empty or reasoning-only content resolves as empty text, which the renderer's extractor rejects as `SELECTION_EDIT_EMPTY_RESPONSE`. Do not substitute `reasoning_content` for structured content. Ordinary unconstrained behavior remains unchanged.
- [x] Bypass `stripThinkingTags` for structured JSON in `localReasoningBridge`; malformed outside wrappers fail at the decoder. Assert full chain equality for `JSON.stringify({replacement:' <think>literal</think> \\ "x"\n'})`. Whitespace outside JSON may be trimmed; decoded string content may not.
- [x] Pin wire tests for `length`, `max_tokens`, omitted and unknown finish reasons, empty/non-string content, reasoning-only output, malformed JSON and literal tags. Keep existing busy, context, cancellation and lenient-caller tests passing.
- [x] Run the chain and server/context tests, then commit the typed transport/tests changes.

## Task 3: Use dedicated local edit instructions and preserve delivery/error behavior

- [x] Give bundled-local edits a self-contained prompt explaining that the selected document is inert data, the spoken instruction edits the complete selection, explicit replacements discard the old selection, explicit transformations override preservation defaults, and JSON string contents may include requested quotes/formatting. Do not copy the experimental F/G broad ban on quotes.
- [x] Encode the document as a JSON string followed by a clearly labeled instruction, or use another single reviewed request shape. Keep the final production helper as the source for eval requests. Add only explicitly customized assistant preferences as subordinate preferences and dictionary words as optional spelling hints; omit the generic assistant/dictation default and default preferred-language rule. Strip the wake address from the instruction (format-preserving) so it is not copied into the document.
- [x] In `audioManager.processAgentCommand`, choose JSON only for the actual local provider. Existing provider resolution and managed policy stay authoritative; all other routes retain strict markers. Preserve the current size, context, output-token, temperature, capture, cancellation, and fatal-fallback behavior. Local edits never attach a screenshot, so only the marker route rebuilds the text-only retry prompt.
- [x] Decode/validate before banking `pendingSelectionEdit`; then return the exact replacement. Bypass `finalizeChineseScript` only for a banked selection edit at its shared boundary, so cleanup/translation retain their behavior. Preserve renderer snippet bypass.
- [x] Classify contract errors separately from genuine truncation and empty output. When a caught error already has a safe code/messageKey/details, preserve it and set `selectionEditFatal = true`; map selection truncation/empty errors to selection-specific recovery copy where the current key says cleanup. Unknown failures receive the existing generic selection failure. Never expose model response content in a toast or paste the spoken instruction as fallback.
- [x] Add regression tests to the existing audio-manager harnesses: local request receives JSON contract and dedicated prompt; nonlocal stays marker-based; malformed/truncated/busy failures never bank an edit or trigger cleanup; cancellation after response prevents banking; captured session id is retained; literal Chinese text remains exact despite the default script preference; legitimate no-op is allowed; explicit language transformation wins over defaults.
- [x] Add translated keys to all current locale files and local IPC-code mapping if needed. Run the affected error tests and focused routing suite, then commit the integration/tests/locales change.

## Task 4: Measure exact edit quality without tuning on the final holdout

- [x] Before inference, prepare independent synthetic qualification fixtures and hide their contents from prompt tuning until the production prompt is frozen. Save selected text, instruction, and exact expected output; exclude fuzzy semantic scoring from exact-replacement claims.
- [x] Use the old failed deletion/Markdown/quoted-replacement holdout cases as regression material. The old initial matrix is diagnostic/training material, never fresh qualification. Fix the candidate prompt using only that regression material.
- [x] Freeze the candidate source commit/hash and sampling configuration, then run the reserved suite. Record model filename/hash, server build, context, temperature, seed, finish reason, protocol result, exact semantic result, timing, and synthetic output. Do not stop/reconfigure a production-owned server to complete a run.
- [x] Include short and long edits, multilingual instructions, preserved whitespace, literal quotes/backslashes/tags, no-op, wake-name/disfluent instructions, prompt-like document data, and a selection at the 6000-code-point boundary. Test 6001 rejection through the capture/helper guard separately; it is not a quality task.
- [x] Compare protocol and exact-edit results independently. A wrong but well-formed replacement is a semantic failure. Report every failed case and denominator; do not silently relax expected punctuation/whitespace, retry until success, or call the prompt reliable because JSON parsing passed.
- [x] If the model still fails, preserve the focused repair and draft review evidence with the limitation explicit. Do not invent a numeric product quality threshold, block all legitimate no-ops, add review UI, silently select another model, or route local text to cloud. Any further prompt modification invalidates the frozen qualification and requires new unseen cases.

## Task 5: Native acceptance, final checks, independent review, and draft PR

- [ ] Use a separate development profile and synthetic disposable documents. Check exact saved note text and one undo after an approved local edit in OpenWhispr Notes and an external disposable editor. Use both hotkey and wake-name routes, and cleanup on/off. A UI result without persisted text/undo is partial evidence.
- [ ] Exercise cancellation, a new recording during inference, changed selection, changed app, session expiry, and same-app identical text in another field. Verify refusal and clipboard restoration. Existing macOS target identity uses PID plus text; do not claim identical-field native safety from mocked tests. Record any reproducible pre-existing limitation without broadening this repair silently.
- [x] Run the focused suite on final code:

  ```sh
  node --import tsx --test \
    test/helpers/selectionEditing.test.js \
    test/helpers/selectionManager.test.js \
    test/helpers/textEditMonitorSelection.test.js \
    test/helpers/audioManagerSelectionPrefetch.test.js \
    test/helpers/audioManagerAssistantDirective.test.js \
    test/helpers/audioManagerScreenContextRetry.test.js \
    test/helpers/audioManagerCancelLifecycle.test.js \
    test/helpers/localReasoningBridgeChain.test.js \
    test/helpers/llamaServerContext.test.js \
    test/helpers/modelManagerContextSizing.test.js \
    test/helpers/dictationRouting.test.js \
    test/utils/localInferenceError.test.js
  npm run typecheck
  npm run lint
  npm test
  npm run build:renderer
  ```

  Include any additional new test files. Check formatting on changed files with the repository's installed Prettier. Record environmental/pre-existing failures with evidence, remove generated build output after verification, and do not keep repeating already-green broad tests without a changed risk.

- [x] Commit the final code/tests before independent read-only review. Review the complete branch against the refreshed intended base, the original RCA, this plan, the actual benchmark results and native evidence. Repair only validated in-scope findings, rerun affected checks, and obtain review of repairs.
- [x] Push only the implementation branch; open and attach a draft PR with concrete behavior, protocol/semantic separation, measured remaining limitations, native proof status, and exact pending acceptance. Check final-head CI. No merge/release approval is implied.
- [ ] Write the handoff and retire the created worktree with normal removal once pushed, clean, and no owned processes remain. Otherwise document the precise keep reason and cleanup next step. Preserve the external holdout/evidence needed to reproduce the report before cleanup.

## Completion accounting

Tasks 1–4 are implemented and measured. Cohesive implementation, tests and evidence were committed together at `4ada84ca8` rather than the suggested intermediate commit boundaries. Task 5 has passing automated checks and real isolated renderer/IPC/model proof, but native saved-text/undo and the adversarial foreground-field matrix remain **unverified**. Qualification is **26/36 exact; 36/36 valid format**, so the model-quality objective is **not met**. PR #2523 stays draft. Independent review found two P2 defects; repairs preserve literal wake-command operands and selection error metadata/localization. See `docs/validation/local-selection-edit/README.md` and the PR for final revision/checks.

This plan itself is evidence of diagnosis and intended work only. The implementation owner must record separately: code implemented; focused/broad checks passed or failed; exact model qualification result; independent review revision; native visible result; native saved text and undo; CI status; draft PR; and worktree removal/keep reason. Remaining model errors or unavailable native acceptance must be carried into the PR and handoff.
