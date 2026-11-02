# Chat Background Turns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task, using the execution method selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Main Chat answers continue across navigation, support concurrent conversations, and restore live results and drafts without crossing conversation or account boundaries.

**Architecture:** Extract the existing turn into a React-independent engine and replace renderer-global stream cancellation with caller-owned signals. A main-chat Zustand store owns submissions from before conversation creation through completion, while `useChatStreaming` remains the lifecycle-bound adapter for other surfaces. Main Chat validates restored selections against the database and consumes the store's live or unseen state without regenerating message IDs.

**Tech Stack:** Existing Electron, React 19, TypeScript, Zustand 5, i18next, AI SDK, SQLite IPC, and Node 24 `node:test`/tsx renderer harness. No new packages.

**Spec:** [2026-10-30-chat-background-turns-design.md](../specs/2026-10-30-chat-background-turns-design.md), updated version reviewed on 2026-11-02. Read it with this plan. Its status line still says awaiting approval; this plan does not change that line or authorize implementation.

## Global Constraints

- TypeScript strict, no `any`; named exports; explicit return types (user's global rules). Match surrounding code style.
- All new UI text goes through i18n in every locale (`src/locales/*`; there are 11 including ja and ar).
- Tests run with `node --import tsx --test` (Node 24 via nvm).
- Main Chat only. Note/container chat, voice assistant, and onboarding retain their existing cancellation and persistence behavior.
- No completion notifications, persistence across launches, new local-model queue, or concurrent sends in one conversation.
- Preserve approval TTL at `10 * 60 * 1000` and keys at `messageId::toolCallId`.
- Work on the user's requested existing branch. Do not create a branch/worktree, commit, push, modify `.env`, or install dependencies as part of this plan without the applicable explicit user instruction. Task boundaries are review checkpoints, not instructions to commit.
- The source inspected for this plan is `/Users/chadpiha/Development/openWhispr/openwhispr`. The chat's attached checkout is different. Before execution, verify the requested checkout/branch; do not copy unrelated changes between them.
- Commands below run from the implementation checkout after `source ~/.nvm/nvm.sh` and `nvm use 24`. This is an Electron renderer change; the existing host-side test harness does not require container services.

## Review Focus

1. Abort before an async generator's first `next()`, during provider setup, or between cloud tool steps must prevent subsequent work without affecting a sibling stream. Task 1.
2. Stop and then send again while an old tool/save is settling must not let the old completion release the new lock or overwrite its state. Tasks 2–3.
3. Multiple failed New chat creations must return each question once, preserve a newer draft, and never move a newer selection. Task 3.
4. Several `useAuth` consumers reconciling the same account must not repeatedly reset a valid background turn; a real replacement must reset before scope IPC. Task 4.
5. Reopen while completion/persistence/validation are in flight must preserve message IDs, approval actions, and exactly one final answer. Tasks 5–7.

## File and ownership map

| File | Responsibility |
| --- | --- |
| `src/services/ReasoningService.ts` | Independent cancellation for raw, AI SDK, and cloud streams; renderer-wide shutdown remains explicit. |
| New `src/components/chat/chatTurnEngine.ts` | Existing context/tool/stream/persistence pipeline, its types, timers, and cancellation; no React imports. |
| `src/components/chat/useChatStreaming.ts` | Thin React adapter retaining the existing public API and other surfaces' behavior. |
| New `src/components/chat/chatPersistence.ts` | Shared message decoding and explicit-ID IPC reads/writes. |
| `src/components/chat/useChatPersistence.ts` | Existing surfaces' state/session behavior, reusing the shared decoder. |
| New `src/stores/chatTurnStore.ts` | Main-chat pending submissions, turns, drafts, selection, skills, account generation, and sidebar revision. Engine handles stay in a module-local map. |
| New `src/components/chat/useMainChatSession.ts` | Validated selection, completed-entry takeover, and the view's ordinary loaded message snapshot. |
| `src/hooks/useAuth.ts`, `src/hooks/useSignOut.ts` | Reset before account scope changes and before confirmed sign-out starts awaiting work. |
| `src/components/ControlPanel.tsx` | Policy lifecycle cancellation while main Chat is unmounted. |
| `src/components/chat/ChatView.tsx` | Store-backed selection, send/stop, drafts, skills, archive/delete, and existing skill-entry actions. |
| `src/components/chat/ConversationList.tsx`, `ConversationItem.tsx` | Refresh after background creation/save; per-row answering indicator. |
| `src/locales/{en,es,fr,de,pt,it,ru,ja,ar,zh-CN,zh-TW}/translation.json` | New translated state labels/errors. |

Leave `chatStore.ts` unchanged: its `activeConversationId` cannot represent a pending submission. Use one authoritative selection in `chatTurnStore`, rather than synchronizing two stores. Main Chat stops using `useChatMessageSender`; embedded surfaces keep it unchanged.

## Task 1: Give each ReasoningService stream its own cancellation

**Files:** Modify `src/services/ReasoningService.ts`, `src/components/chat/useChatStreaming.ts`; create `test/services/reasoningServiceConcurrentStreams.test.js`; update cancellation cases in `test/services/reasoningServiceStreamingThink.test.js` and `reasoningServiceStreamingTimeout.test.js`.

**Interfaces:** Add an optional final `signal?: AbortSignal` argument to `processTextStreaming(messages, model, provider, config, signal?)`, `processTextStreamingAI(messages, model, provider, config, tools?, signal?)`, and `processTextStreamingCloud(messages, config, signal?)`. Retain existing parameter and generator return types. Remove `cancelActiveStream()` after migrating all callers; preserve `cancelAllRequests(): void` and `destroy(): void`.

- [ ] **Step 1: Add failing transport tests using the existing renderer harness.** Exercise two concurrent cloud requests and two raw/AI streams; record request IDs and transport aborts. Test names/assertions:

  ```js
  // "aborting A leaves B streaming"
  assert.deepEqual(cancelledRequestIds, [requestA]);
  assert.equal(signalB.aborted, false);
  assert.deepEqual(contentB, ["before", "after"]);
  // "pre-aborted cloud stream never starts IPC"
  assert.equal(startedRequests, 0);
  // "cancelAllRequests cancels every tracked stream"
  assert.equal(signalA.aborted, true);
  assert.equal(signalB.aborted, true);
  ```

  Also hold model/key/server setup and a cloud tool result: abort, release the await, and assert no fetch/next cloud step occurs. Run with raw local/LAN, AI SDK tools, and cloud paths; preserve timeout-vs-user-abort assertions. Verify listener/controller cleanup after success, failure, abort, and generator `return()`.

- [ ] **Step 2: Run the new suite.** `node --import tsx --test test/services/reasoningServiceConcurrentStreams.test.js`. Expected: failures demonstrating ignored signals or shared cancellation.
- [ ] **Step 3: Implement independent stream ownership.** Replace `streamAbortController`, `activeCloudStream`, and `cloudOperationGeneration` with per-operation controllers tracked in a set. Link caller abort immediately, including already-aborted signals. Recheck after asynchronous setup. Pass the operation signal through every cloud tool-loop step and request-specific IPC cancellation; detach listeners in `finally`. Retain request-generation behavior for existing non-streaming requests. `cancelAllRequests` cancels all tracked operations in this renderer and keeps its existing non-streaming cancellation.
- [ ] **Step 4: Migrate the hook and direct test callers in the same change.** Temporarily keep a controller ref per hook send; abort only that controller on supersession, Stop, and unmount, and pass its signal to the service. Replace all `cancelActiveStream()` calls, including the loop's unmounted check and test cleanup. Do not leave a compatibility method that silently cancels another owner's stream.
- [ ] **Step 5: Verify.** `node --import tsx --test test/services/reasoningServiceConcurrentStreams.test.js test/services/reasoningServiceStreamingThink.test.js test/services/reasoningServiceStreamingTimeout.test.js test/helpers/agentStreamRequestRegistry.test.js test/helpers/useChatStreamingCancellation.test.js`. Expected: all pass. `rg -n 'cancelActiveStream|cloudOperationGeneration|activeCloudStream|streamAbortController' src test` must have no obsolete implementation/call sites; remove stale comments too.

## Task 2: Extract the existing turn engine without changing other surfaces

**Files:** Create `src/components/chat/chatTurnEngine.ts`, `test/helpers/chatTurnEngine.test.js`; modify `src/components/chat/useChatStreaming.ts`. Existing regression files: `test/helpers/useChatStreaming{Cancellation,Flush,Tools,Skills,Connectors}.test.js` and `test/services/toolExecutionContext.test.js`.

**Interfaces:** Move `ChatStreamingScope`, `OpenNoteContext`, and `SendToAIOptions` to the engine and re-export their types from the hook to avoid consumer churn. Define:

```ts
interface ChatTurnSink {
  setMessages: (update: (messages: Message[]) => Message[]) => void;
  setAgentState: (state: AgentState) => void;
  setToolStatus: (status: string) => void;
  setActiveToolName: (name: string) => void;
}
interface ChatTurnEngine {
  send: (text: string, messages: Message[], options?: SendToAIOptions) => Promise<void>;
  cancel: (options: { explicit: boolean }) => void;
}
function createChatTurnEngine(
  getOptions: () => ChatTurnOptions,
  sink: ChatTurnSink
): ChatTurnEngine;
```

`ChatTurnOptions` contains the current hook options except `messages`/`setMessages`, plus `userName: string | null` and optional `isOwnerCurrent: () => boolean`. The callback fields retain their current signatures. The engine uses shared `i18n.t` bound to the i18next instance; `getOptions` replaces refs at their existing read points. `isOwnerCurrent` defaults to true for existing hook consumers and fences main-chat account ownership, including late saved-skill persistence.

- [ ] **Step 1: Add characterization tests.** Run the engine with an in-memory sink, mocked transport, and deferred tools. Assert normal content/tools persist once; explicit cancellation persists no partial text; implicit cancellation retains existing partial-text behavior; think-only cancellation does not fabricate an empty reply. Start a second send after cancellation while the first tool remains held: releasing the first must not set the second idle or clear its activity. Flip `isOwnerCurrent` false before a saved-skill result returns: assert zero persistence callbacks.
- [ ] **Step 2: Run the new suite.** `node --import tsx --test test/helpers/chatTurnEngine.test.js`. Expected: missing engine export, then behavioral failures until extraction is complete.
- [ ] **Step 3: Move the turn and supporting helpers intact.** Preserve context building, model routing, tools, 32 ms flush batching, tool presentation timers, response callbacks, history compaction, approval keys, error copy, and saved-skill interruption behavior. Use per-send identity for all sink writes and timers; a superseded operation cannot finalize a newer one. Separate account validity from turn cancellation: ordinary Stop retains the existing record of a skill already saved, while invalid account ownership forbids every write, including that exception. Clear timers on cancellation/completion.
- [ ] **Step 4: Make the hook a stable adapter.** One engine per hook instance, current options supplied through a ref; React setters form the sink. Keep `agentState`, `toolStatus`, `activeToolName`, `sendToAI`, and `cancelStream` public. Unmount calls `cancel({ explicit: false })`; Stop/switch invokes explicit cancellation as today. Preserve StrictMode setup/cleanup behavior without creating an extra send or leaving an adapter permanently inactive.
- [ ] **Step 5: Verify existing contracts.** `node --import tsx --test test/helpers/chatTurnEngine.test.js test/helpers/useChatStreaming*.test.js test/services/toolExecutionContext.test.js test/hooks/embeddedChatNewChat.test.js test/hooks/embeddedChatSendLock.test.js test/hooks/containerChat.test.js test/hooks/chatSurfacesConnectors.test.js`. Expected: all pass with original non-main-chat assertions retained.

## Task 3: Own submissions, explicit-ID persistence, and drafts in the main-chat store

**Files:** Create `src/stores/chatTurnStore.ts`, `src/components/chat/chatPersistence.ts`, `test/stores/chatTurnStore.test.js`, `test/helpers/chatPersistence.test.js`; modify `src/components/chat/useChatPersistence.ts` only to reuse message decoding.

**Interfaces:**

```ts
type ChatSelection =
  | { kind: "new-chat" }
  | { kind: "submission"; submissionId: string }
  | { kind: "conversation"; conversationId: number };
interface ChatTurnEntry {
  submissionId: string;
  conversationId: number | null;
  accountGeneration: number;
  messages: Message[];
  agentState: AgentState;
  toolStatus: string;
  activeToolName: string;
  running: boolean;
  skills: ChatSkills;
}
interface StartChatSendInput {
  selection: ChatSelection;
  messages: Message[];
  text: string;
  skills: ChatSkills;
  userName: string | null;
  options?: SendToAIOptions;
}
function startChatSend(input: StartChatSendInput): boolean;
function selectChat(selection: ChatSelection): void;
function startNewChat(): void;
function setChatDraft(selection: ChatSelection, text: string): void;
function setChatSkills(selection: ChatSelection, skills: ChatSkills): void;
function cancelChatTurn(selection: ChatSelection): void;
function dropChatConversation(conversationId: number): void;
function takeCompletedChatTurn(conversationId: number): ChatTurnEntry | null;
function cancelAllChatTurns(): void;
function resetForAccountChange(): void;
function useIsConversationAnswering(conversationId: number): boolean;
```

Export `useChatTurnStore` for selection/snapshot subscriptions. Store entries use distinct `submission:<uuid>` and `conversation:<id>` keys. State includes `selectionRevision`, `accountGeneration`, `listRevision`, per-conversation drafts, one New chat draft, `newChatError: string | null`, and New chat skills. Clear the New chat error on editing/submitting its draft or account reset. Keep engines/operation handles outside Zustand. All state updates that finish asynchronous work check account generation and submission identity, not just the conversation ID.

In `chatPersistence.ts`, derive `StoredChatConversation` from the existing `electronAPI.getAgentConversation` return type and export:

```ts
function decodeChatMessages(row: StoredChatConversation): Message[];
function appendChatMessage(
  conversationId: number,
  role: "user" | "assistant",
  content: string,
  toolCalls?: ToolCallInfo[]
): Promise<void>;
```

The decoder reuses existing metadata parsing; the new main-chat writer awaits `addAgentMessage`, strips skill-card drafts through the existing helper, and rejects missing bridge/null writes instead of silently treating them as success. Keep the legacy hook's navigation checks, write behavior, and public API; only extract its decoding. Main-chat writes call the new writer with the captured ID; they never use a view ref.

- [ ] **Step 1: Add deferred-IPC/engine tests against the real store.** Mock engine and Electron boundaries through `createRendererServer`, without implementing a second store in the tests. Cover synchronous locking/user-message insertion/draft clearing before creation resolves; rapid duplicate send rejection; A/B concurrency; and migration of a submission to its ID in one update. Example assertions before and after releasing creation:

  ```js
  assert.equal(firstAccepted, true);
  assert.equal(duplicateAccepted, false);
  assert.equal(pending.agentState, "thinking");
  assert.equal(newChatDraft, "");
  // After navigating to B, completing A's creation must not select A.
  assert.deepEqual(selection, { kind: "conversation", conversationId: 7 });
  assert.deepEqual(userWriteIds, [createdConversationId]);
  assert.deepEqual(assistantWriteIds, [createdConversationId]);
  ```

  Add failures with an existing New chat draft: append the failed question separated by `\n\n`, once per failed submission, in completion order. Cover two failures, cancellation before creation returns, `onSkillPicked` after navigation, a rejected user-message write, a held assistant-message write, and Stop→new send→old completion. Persistence tests assert exact IDs/metadata and that its returned promise remains pending until IPC settles.
- [ ] **Step 2: Run the new suites.** `node --import tsx --test test/stores/chatTurnStore.test.js test/helpers/chatPersistence.test.js`. Expected: missing modules/exports followed by failing ownership assertions.
- [ ] **Step 3: Implement reservation and migration.** `startChatSend` returns acceptance synchronously, reserves the submission before any await, snapshots options/history/skills, and starts an internally handled async operation. Existing completed entries supply their own history; otherwise use the session's validated snapshot. Reject stale selections and locked entries. Create new conversations directly through IPC, preserving the existing 50-character title truncation. Migrate selection only if it still names the submission. New chat resets its current draft/skills without touching submitted operations. For an existing conversation, preserve its identity throughout preparation and streaming. Create its engine with main-chat connectors/skills enabled, the captured signed-in user's name, and the account-generation ownership getter; it must not retain a dependency on a mounted view.
- [ ] **Step 4: Implement persistence and finalization.** Await the user's write before inference. Capture the bound conversation ID and account generation in every callback. Track assistant-write promises so the turn remains owned until durable writes settle; persistence failure produces a translated in-memory failure, never an unhandled rejection or success-only final state. Keep final entries until consumed; `takeCompletedChatTurn` atomically returns/deletes only a non-running entry. Increment `listRevision` after acknowledged creation/message writes. Main-chat cancellation releases its UI lock synchronously; old finalizers cannot release a newer lock.
- [ ] **Step 5: Implement failure/cancellation cleanup.** Failed creation restores the question to the current New chat draft, sets `newChatError`, and removes the failed submission; only reset selection if it still points at that submission. Preserve its attached skill only when restoring that still-selected submission, so a newer draft's skill is not replaced. A cancelled creation never starts inference when its result arrives. For an account-stale creation, do not issue a delete under the new account: current IPC offers no old-account-scoped cleanup, so leave the old row as the spec permits. Deletion drops draft/entry and cancels; archive does neither. All persistence checks account validity and deletion; ordinary Stop may still record an already-committed skill against its original conversation, but may not recreate an entry or mutate a newer send. Account reset suppresses even this late skill-card write.
- [ ] **Step 6: Verify.** `node --import tsx --test test/stores/chatTurnStore.test.js test/helpers/chatPersistence.test.js test/helpers/chatMessageSubmissionLock.test.js test/hooks/chatMissingConversation.test.js test/hooks/embeddedChatNewChat.test.js`. Expected: all pass; embedded session-change behavior remains intact. New translated failure keys are added in Task 6 before the feature is wired into the UI.

## Task 4: Connect account and policy lifetime outside ChatView

**Files:** Modify `src/stores/chatTurnStore.ts`, `src/hooks/useAuth.ts`, `src/hooks/useSignOut.ts`, `src/components/ControlPanel.tsx`; create `test/hooks/chatTurnAccountLifecycle.test.js`; extend `test/stores/chatTurnStore.test.js` and `test/components/signOutEndsMeetingRecording.test.js`.

**Interfaces:** Store exports `prepareChatAccountScope(userId: string | null): void` in addition to Task 3's reset/cancel actions. It remembers the last prepared identity, adopts the initial resolved identity, and resets synchronously on a replacement/sign-out. Same-identity reconciliation is idempotent. `resetForAccountChange()` always increments the generation, clears all main-chat state, invalidates loads, and aborts owned operations; it does not erase existing `chatSkillMemory` localStorage rows.

- [ ] **Step 1: Add lifecycle tests.** With ChatView unmounted, populate running and completed entries, pending creation, drafts, selection, and New chat skills. Assert reset synchronously clears all, then resolve held creation/load/tool/stream callbacks and assert no state or database writes return. Include a saved-skill result. Hold sign-out's first await and assert reset already happened. In the auth integration fixture record calls and assert reset precedes `setActiveAccountScope`; repeated consumers for the same identity must leave a newly started turn alive. Cancel a sign-out confirmation and assert no reset.
- [ ] **Step 2: Run focused tests.** `node --import tsx --test test/hooks/chatTurnAccountLifecycle.test.js test/stores/chatTurnStore.test.js test/components/signOutEndsMeetingRecording.test.js`. Expected: new lifecycle assertions fail before wiring.
- [ ] **Step 3: Wire auth ordering.** Add the store reset to `loadAccountDependencies`/`resetRendererCaches`, retaining resets before/after purge and after a verify that removes rows. Call identity preparation before `setActiveAccountScope`, not afterwards. Check the bound auth generation is current before adopting a resolved identity so an older `useAuth` effect cannot switch the store back. Keep the identity reset idempotent across multiple hook consumers. Call reset at the start of `performSignOut`, after confirmation and before `stopRecording`/network work; preserve existing meeting stop, purge, sign-out, and reload ordering.
- [ ] **Step 4: Wire policy lifetime.** Add a ControlPanel-lifetime subscription to the existing `isAgentAllowed` predicate that cancels all main-chat turns synchronously when the predicate becomes false, even while Notes/Home is active. It also checks the current value on installation and unsubscribes on teardown. Reject sends while agent access is disallowed. Policy cancellation invalidates pending creations and discards partial answers, but preserves ordinary drafts/selection; account reset is the stronger operation.
- [ ] **Step 5: Verify.** Run the focused command plus `node --import tsx --test test/lib/authAccountScope.test.js test/lib/authRequestContext.test.js test/helpers/policyFailClosedTransition.test.js test/services/signOutClearsWorkspaceListCache.test.js`. Expected: all pass, including no duplicate reset on ordinary same-account rerenders.

## Task 5: Restore validated selections and hand completed turns to the view

**Files:** Create `src/components/chat/useMainChatSession.ts`, `test/hooks/mainChatSession.test.js`; modify `src/stores/chatTurnStore.ts` only for session actions/selectors needed here.

**Interfaces:** `useMainChatSession(): MainChatSession` returns `selection: ChatSelection`, `loading: boolean`, `messages: Message[]`, `agentState: AgentState`, `toolStatus: string`, `activeToolName: string`, `skills: ChatSkills`, `draft: string`, `error: string | null`, and these actions:

```ts
openConversation: (id: number, source: "sidebar" | "restore") => Promise<void>;
newChat: () => void;
send: (text: string, options?: SendToAIOptions) => boolean;
cancel: () => void;
setDraft: (text: string) => void;
setSkills: (skills: ChatSkills) => void;
retryLoad: () => void;
```

`openConversation` uses shared decoding and the store's selection/account revisions. It always reads `getAgentConversation`, even with a cached entry. The session's loaded/final snapshot is component-owned; only running/unseen entries and remembered selection/drafts live beyond the view. The pending-submission selection restores directly because no database row exists yet. `error` exposes a local validation failure or the selected New chat's `newChatError`; retry applies only to validation failure. Read `user?.name` from the existing `useAuth` hook and capture it in Task 3's send input; account changes invalidate the engine rather than updating the old turn's identity.

- [ ] **Step 1: Add tests with deferred validation and writes.** Verify live reattachment preserves assistant/message/tool IDs; completed/error takeover happens once; completion while on screen does not reload or flicker. Hold validation of A, select B, resolve A: B wins. Restore deleted/archived rows with and without entries: deleted cancels/drops, archived falls back while its turn survives. Explicit sidebar opening of an archived row still works. Pending submission restoration shows its original user message and locked composer. During validation show a blank message area, no New chat suggestions, and disable Send. Rejected validation shows a retryable error, not a writable stale conversation.
- [ ] **Step 2: Run the suite.** `node --import tsx --test test/hooks/mainChatSession.test.js`. Expected: missing hook, then failing restoration assertions.
- [ ] **Step 3: Implement validation and latest-selection guards.** On mount validate a remembered conversation with source `restore`. On sidebar selection use source `sidebar`; on an archived restore select New chat without dropping its entry. Treat `null` as deleted and cancel/drop before fallback. Ignore obsolete loads by both account and selection revision, including a new New chat selection with the same discriminant. After the row is validated, prefer the latest entry over the row's potentially stale messages; consume only if completed. If it is still running, keep subscription ownership in the store. Never re-key live messages through the database decoder.
- [ ] **Step 4: Implement handoff and send capture.** Copy a completed entry into the session snapshot before dropping it, including errors and tool metadata. Keep it on screen until navigation; returning later may load the persisted history as specified. When sending, capture this validated snapshot and selection synchronously and delegate to Task 3; do not read mutable selection after awaits. An entry still finishing a save remains running, so reopening cannot consume/drop it before write acknowledgment.
- [ ] **Step 5: Verify.** `node --import tsx --test test/hooks/mainChatSession.test.js test/stores/chatTurnStore.test.js test/components/chatMessageApprovals.test.js test/stores/connectorApprovalStore.test.js test/stores/skillApprovalStore.test.js`. Expected: all pass. Test a pending card across two navigation cycles and its ordinary 10-minute expiry with mocked timers.

## Task 6: Wire Main Chat, drafts, skills, and sidebar loaders

**Files:** Modify `src/components/chat/ChatView.tsx`, `ConversationList.tsx`, `ConversationItem.tsx`, and all 11 translation files. Update `test/components/chatViewNewChat.test.js`, `chatViewSkills.test.js`; create `test/components/conversationItemAnswering.test.js` and `test/components/chatViewBackgroundTurns.test.js`.

**Interfaces:** ChatView consumes Task 5's session. ConversationItem calls `useIsConversationAnswering(conversation.id)`, selecting a boolean so each token does not rerender every row. ConversationList reloads from the store's `listRevision` as well as its existing explicit archive/delete refresh. Add `chat.answering` = `Answering…`, `chat.conversationCreateFailed` = `Couldn’t start the conversation. Your question is back in New chat.`, `chat.messageSaveFailed` = `Couldn’t save this message. Please try again.`, and `chat.conversationLoadFailed` = `Couldn’t load this conversation. Please try again.` with translated equivalents in every locale; use existing common retry copy.

- [ ] **Step 1: Replace obsolete main-chat expectations and add integration assertions.** Existing `chatViewNewChat` tests explicitly expect navigation cancellation; replace those main-chat assertions, retaining embedded tests. Assert A survives New chat/switch/unmount and B can send immediately. Mount again and assert the last selection, per-conversation draft, New chat skill, and mid-stream lock restore. Test creation failure recovery, sidebar appearance after held creation, correct skill chip after background `onSkillPicked`, shortcut New chat, and skill-request auto-send exactly once under StrictMode.
- [ ] **Step 2: Add loader tests.** Assert one answering row shows `Loader2` at 12 px with `animate-spin` and `text-muted-foreground/70`, replacing its timestamp; another row keeps its timestamp. Assert the row's accessible text includes translated `Answering…`, the existing hover menu still works, and finish/failure/cancel all clear the loader. Use rendered markup and real store transitions, not source-string-only assertions.
- [ ] **Step 3: Run these tests before wiring.** `node --import tsx --test test/components/chatViewNewChat.test.js test/components/chatViewBackgroundTurns.test.js test/components/chatViewSkills.test.js test/components/conversationItemAnswering.test.js`. Expected: background ownership/restore assertions fail against current ChatView.
- [ ] **Step 4: Replace view-owned orchestration with the session.** Remove main-chat `useChatStreaming`/`useChatMessageSender` usage, navigation cancellations, and unconditional `onConversationCreated` selection. Supply `ChatInput.draftText`/`onDraftChange`, its current conversation's state/cancel, and existing focus behavior. Because ChatInput clears its controlled draft before calling the host, restore the submitted text if the session rejects the send, without overwriting a newer selection's draft; add a test for this rejection path. Render live messages, loading/error states, and skill chips from the session; keep Open skill enabled during a turn. Bind skill selection to the originating submission/conversation and persist names with `chatSkillMemory`. Do not add a second React submission lock. Preserve skill requests and their existing once-per-request behavior.
- [ ] **Step 5: Connect archive/delete and sidebar updates.** On confirmed delete, cancel/drop the target before awaiting deletion, clear its draft/skill memory, and change selection only if that target is still selected; show existing error handling on a failed delete. Archive navigates away if necessary without cancelling the turn. Keep the existing Archived-list opening path. Use `listRevision` for background changes; prevent an older sidebar fetch or previous-account fetch from replacing a newer result. Keep the current explicit refresh for archive/delete.
- [ ] **Step 6: Verify.** Run Step 3's command, `node --import tsx --test test/components/chatInputFocus.test.js test/components/chatInputLeadingRow.test.js test/components/chatComposerLayout.test.js`, and `npm run i18n:check`. Expected: all pass; all 11 locales contain the new keys. No new notification/toast is emitted for background completion.

## Task 7: Verify lifecycle races and complete regression coverage

**Files:** Extend `test/components/chatViewBackgroundTurns.test.js`, `test/hooks/chatTurnAccountLifecycle.test.js`, `test/services/reasoningServiceConcurrentStreams.test.js`, and `test/hooks/mainChatSession.test.js` as needed. Reuse `test/lib/rendererTestHarness.js`; avoid new test dependencies.

**Interfaces:** Exercise the implemented store/session/engine together, mocking only transport and Electron boundaries. No new product API.

- [ ] **Step 1: Add the final cross-layer race tests.** Keep two real engines alive for A and B, unmount/remount main Chat, and complete them in reverse order. Assert each question/answer writes exactly once to its original ID. Hold a connector approval in A, use and cancel embedded chat, return to A, approve, and assert only A's action commits. Repeat with a skill approval and expiry. Stop A while B continues, then start another A send and settle the old tool. Hold an assistant IPC acknowledgment while opening A: final state stays present and its entry is not discarded early. Reset accounts while that operation and a creation/load are held: no later callback initiates an old-account write or restores state.
- [ ] **Step 2: Verify persistence ordering explicitly.** Trace `db-add-agent-message` and `db-get-agent-conversation` in `src/helpers/ipcHandlers.js`/`database.js`: both database operations are synchronous today. The implementation must still use acknowledged writes, not rely solely on assumed IPC delivery order. The delayed-ack test above verifies its ownership rule. Do not change SQLite schema or main-process stream registry for this feature.
- [ ] **Step 3: Run the required regression gates.**

  ```bash
  node --import tsx --test test/components/chatView*.test.js test/hooks/mainChatSession.test.js test/hooks/chatTurnAccountLifecycle.test.js test/hooks/embeddedChatNewChat.test.js test/hooks/embeddedChatSendLock.test.js test/hooks/containerChat.test.js test/hooks/chatSurfacesConnectors.test.js test/helpers/useChatStreaming*.test.js test/services/reasoningService*.test.js
  npm test
  npm run typecheck
  npm run lint
  npm run i18n:check
  npm run build:renderer
  git diff --check
  ```

  Expected: zero failures/errors and a successful renderer build. Run the existing installed Prettier binary with `--check` on the changed source/test files. Record pre-existing failures separately; do not change unrelated code to satisfy them. Avoid the full packaged build, whose prebuild downloads native assets unrelated to this change.
- [ ] **Step 4: Perform the desktop smoke check.** In an existing dev app, send in A, leave for Notes, send in B, return while both run, and verify independent live replies/Stop. Verify drafts in A/B/New chat, an approval while away, archived restoration, deletion, and sign-out. Check keyboard Esc/New chat and the loader/menu with a non-English locale and Arabic RTL. Use an already configured cloud or BYOK/local route; do not install a model or alter credentials for the smoke check. Automated transport coverage must cover routes unavailable locally.
- [ ] **Step 5: Review against the spec and report evidence.** Apply code-quality review to changed files, trace every cancellation/persistence caller, and confirm no renderer-global chat cancellation remains. Report tests, any unavailable manual/provider checks, and the final diff. Leave changes uncommitted unless the user explicitly requests a commit.

## Completion criteria

- All seven design goals have tests: navigation survival/concurrency (Tasks 3/6/7), live and failed-result restoration (Task 5), sidebar loader (Task 6), remembered selection/drafts (Tasks 3/5/6).
- Account reset, pending-creation ownership, explicit-ID user/assistant writes, and cached-row validation have held-promise race coverage.
- Existing embedded/voice/onboarding cancellation contracts remain covered by the hook suites and full desktop test run.
- No implementation starts merely because this plan was saved. Review this plan and select an execution method before executing its tasks.
