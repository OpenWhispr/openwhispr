# PR 1597 Phase 2 final fix report

Date: 2026-08-19
Branch: `feat/voice-assistant`
Starting HEAD: `40ed8ac7df1c27d2827b67cf1f638a25035779e0`

## Scope and outcome

This wave closes the six remaining round-two findings:

1. Batch cancellation during segment merge and overlapping processing ownership.
2. User-cancelled raw local/LAN streams rendering as timeout/error replies.
3. Live Transcript final-hover hold leaking across teardown or sessions.
4. CJK agent-address stripping leaving a leading ASCII comma.
5. Primitive Assistant command rejections rendering `Error: undefined`.
6. A stale Tinfoil preview-routing comment.

No dependency, environment, locale, or public API changes were made.

## Root causes, hypotheses, and fixes

### 1. Batch cancellation and pipeline ownership

Root cause: `finalizeBatchRecording()` entered processing before awaiting the FFmpeg segment merge, but `processAudio()` reset the shared `_processingCancelled` boolean when the merge completed. A cancel in that gap was therefore forgotten. The same instance boolean could also be reset by a newer pipeline while older work was still settling. Cancellation and lifecycle ownership were conflated, so either a cancelled current owner could remain busy or an obsolete owner could clear a newer pipeline.

Hypothesis: a monotonically increasing cancellation generation captured before batch finalization will preserve cancellation across every await, while a distinct per-pipeline ownership token will let only the current owner publish or settle shared processing state.

Fix:

- Capture a batch pipeline token before merge/preview finalization.
- Compare its cancellation generation and active identity after relevant awaits.
- Thread the pipeline-specific cancellation predicate through transcription/reasoning paths that can bank results or report failures after an await.
- Settle a cancelled current owner when its pending work completes, but make obsolete owners no-ops.
- Supersede stale batch ownership when streaming finalization or discard takes ownership of the shared busy lifecycle.

RED evidence:

- `node --import tsx --test test/helpers/audioManagerCancelLifecycle.test.js`
  - Initial regression run: 8 tests, 6 passed, 2 failed.
  - `cancelling while batch segments merge never starts transcription`: expected `processAudio` calls `0`, actual `1`.
  - `a cancelled older pipeline cannot publish or clear a newer pipeline`: expected the newer pipeline to remain busy, actual `false`.
- Ownership-settlement regression: 9 tests, 8 passed, 1 failed.
  - `a cancelled current pipeline clears busy when its pending work settles`: expected idle after settlement, actual `isProcessing === true`.
- Cross-mode ownership regression: 10 tests, 9 passed, 1 failed.
  - `a cancelled batch pipeline cannot clear newer streaming finalization`: expected the streaming finalization to remain busy, actual `false`.

GREEN evidence:

- Final cancellation lifecycle suite: 10/10 passed.
- All `audioManager*.test.js` suites are included in the consolidated 143/143 focused run.

Files:

- `src/helpers/audioManager.js`
- `test/helpers/audioManagerCancelLifecycle.test.js`

### 2. Raw local/LAN streaming cancellation

Root cause: `processTextStreamingRaw()` mapped every fetch `AbortError` to a timeout, did not normalize an abort thrown by `reader.read()`, and the tool-ineligible wrapper had no abort-aware catch. If an abort still reached `useChatStreaming`, the hook rendered it as an error and announced response content.

Hypothesis: explicitly record whether the timeout callback owns the abort; user-owned aborts should terminate the generator normally, while timeout-owned aborts should retain the existing timeout error. The hook should also treat its request-generation cancellation as a normal terminal state if an abort escapes transport normalization.

Fix:

- Track timeout ownership and avoid letting a late timeout claim an already user-aborted controller.
- Handle both fetch-time and reader-time aborts.
- Add an abort-aware catch to the tool-ineligible raw wrapper.
- Suppress error content and response announcements in the hook after user cancellation.

RED evidence:

- `node --import tsx --test test/services/reasoningServiceStreamingThink.test.js test/helpers/useChatStreamingCancellation.test.js`
  - 24 tests, 21 passed, 3 failed.
  - Reader cancellation rejected with `AbortError` instead of ending normally.
  - Reader timeout rejected with raw `AbortError` instead of `Streaming request timed out`.
  - Hook cancellation rendered `Error: aborted` instead of an empty, settled assistant message.

GREEN evidence:

- Same focused command: 24/24 passed.
- Covered again by the consolidated focused and full-suite runs.

Files:

- `src/services/ReasoningService.ts`
- `src/components/chat/useChatStreaming.ts`
- `test/services/reasoningServiceStreamingThink.test.js`
- `test/helpers/useChatStreamingCancellation.test.js`

### 3. Live Transcript hold lifecycle

Root cause: `close()` and `dismissForError()` cancelled the scheduled hide timer but left `finalHoldRef` owned by the prior final result. A later final result therefore declined to close. A new normal recording could inherit the same stale hold.

Hypothesis: final-hold ownership is session-local and must be reset at explicit close, error replacement, and the next normal-recording boundary.

Fix: reset `finalHoldRef` in all three lifecycle transitions.

RED evidence:

- `node --import tsx --test test/helpers/liveTranscriptHoldLifecycle.test.js`
  - 3 tests, 0 passed, 3 failed.
  - Close, error replacement, and new-session cases all left `openRef.current === true`; expected `false` after the next final hide.

GREEN evidence:

- Focused lifecycle suite: 3/3 passed.
- Lifecycle plus existing AssistantPanel suite: 9/9 passed.

Files:

- `src/hooks/useLiveTranscriptPanel.js`
- `test/helpers/liveTranscriptHoldLifecycle.test.js`

### 4. CJK address separator

Root cause: CJK normalization emits a punctuation comma as its own token, but the located removal span stopped immediately after the agent name.

Hypothesis: extending the located token span by one only when the immediately adjacent raw token is `,` removes the separator without changing unrelated transcript tokens.

RED evidence:

- `node --import tsx --test test/helpers/agentDetection.test.js`
  - 24 tests, 23 passed, 1 failed.
  - Japanese result was `, メールを書いて`; expected `メールを書いて`.

GREEN evidence:

- Same focused suite: 24/24 passed, including Japanese and Simplified Chinese cases.

Files:

- `src/config/agentDetection.ts`
- `test/helpers/agentDetection.test.js`

### 5. Primitive Assistant command rejections

Root cause: the rejected value was cast to `Error` and `.message` was interpolated directly. Promise rejections are `unknown`, so strings, numbers, `null`, and `undefined` do not provide that property.

Hypothesis: normalize the unknown value before presentation, preserving a non-empty `Error.message`, stringifying non-null primitives, and using the existing localized unknown-error fallback for nullish values.

Fix: perform that normalization in `AssistantPanel` before appending the assistant error message.

Test note: the existing AssistantPanel harness uses server rendering and does not run the command-consuming effect. A new renderer seam solely to expose this catch branch would be artificial, so no dedicated regression was added, as permitted by the finding. The component remains covered by its existing suite, TypeScript, lint, and the full test run.

File:

- `src/components/dictation/AssistantPanel.tsx`

### 6. Tinfoil comment

The routing comment now states that Tinfoil preview is enabled for normal dictation and skipped for assistant voice because the Assistant panel owns the shared surface. Runtime behavior is unchanged.

File:

- `src/helpers/dictationStreamingRouting.js`

## Final verification

- Consolidated directly relevant suites: 143/143 passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed. It emits the repository's existing `MODULE_TYPELESS_PACKAGE_JSON` warning for `src/eslint.config.js`.
- `npm test` inside the sandbox: environment-only failures from `listen EPERM 127.0.0.1` and dependent child-process tests; no focused/product regression failed.
- Final escalated `npm test`: 2,767 tests total; 2,596 passed, 0 failed, 170 skipped, 1 todo.
- `git diff --check`: passed.
- i18n check: not applicable; no locale files or translation keys changed.
- Protected untracked review/planning documents remain untouched and excluded from staging.

## Remaining concerns

- The primitive-rejection branch has no direct effect-level regression because the current AssistantPanel harness cannot execute it without adding a test-only renderer seam. The implementation is a small local normalization of `unknown` and passed all static/full gates.
- Focused tests emit expected fixture noise (`localStorage` experimental warnings, AI SDK system-message warning, and a deliberately simulated provider error); these are not failures.
