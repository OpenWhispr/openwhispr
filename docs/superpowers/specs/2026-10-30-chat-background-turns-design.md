# Chat answers keep going in the background

Status: design, awaiting approval (2026-10-30)

## Intent

In the main Chat view (Control Panel → Chat), a question asked and then left
— by clicking another view (Notes, Home, …), another conversation, or New
chat — is cancelled today. Nothing is saved if the model was still thinking,
so the user comes back to their question with no reply.

The user expects to come back and find the answer there, or at least find it
still being worked on. A chat answer should behave like a background task
that belongs to its conversation, not to whatever is on screen.

## Root cause (for context)

- The turn lives in the `useChatStreaming` React hook inside `ChatView`. Its
  unmount cleanup calls `cancelStream()` on purpose
  (`src/components/chat/useChatStreaming.ts:374`), and `ControlPanel` mounts
  `ChatView` only while `activeView === "chat"`
  (`src/components/ControlPanel.tsx:1302`).
- `ChatView` cancels explicitly on conversation switch and New chat
  (`ChatView.tsx:80`, `:94`).
- `finishInterrupted` only saves a partial answer that already has text
  (`useChatStreaming.ts:870`), so a turn cut off while thinking saves nothing.
- `ReasoningService` keeps a single "current stream" per renderer
  (`streamAbortController`, `activeCloudStream`, `cloudOperationGeneration`):
  starting a stream cancels the previous one, and `cancelActiveStream()`
  cancels whichever is current. The main process already supports several
  concurrent cloud streams per window (`agentStreamRequestRegistry.js`).

## Goals

1. Leaving the Chat view while a conversation is answering does not stop the
   answer. It finishes and is saved exactly as if the user had stayed.
2. Switching to another conversation, or pressing New chat, does not stop
   the answer either.
3. Several conversations can answer at the same time. The user can ask in
   conversation B while A is still answering.
4. Coming back to a conversation that is still answering shows it live: what
   has streamed so far, the thinking/tool indicator, any pending approval
   card, and the composer locked until the turn ends.
5. Coming back to a conversation that finished (or failed) while away shows
   the outcome — the saved answer, or the same error message the user would
   have seen had they stayed.
6. Each conversation that is answering shows a small spinner in the Chat
   sidebar in place of its timestamp.
7. Coming back to the Chat view from another view reopens the conversation
   that was on screen when the user left (or New chat, if that's where they
   were), with anything typed but not sent still in the composer.

## Non-goals

- Note chat, folder/space (container) chat, the voice assistant panel and
  the onboarding demo keep today's behaviour (unmount/switch cancels). The
  design must not block giving them the same treatment later.
- No notification, toast or badge when a background answer finishes.
- Answers do not survive quitting the app, reloading the window or a
  renderer crash.
- No change to one-turn-at-a-time within a single conversation.
- No new queueing for local models: llama-server serves concurrent requests
  however it is configured today; a second local answer may wait for the
  first. That is acceptable.

## Anti-goals (would be a failure even if it "works")

- An answer saved into the wrong conversation, or saved twice.
- Esc / Stop in one conversation cancelling another conversation's answer.
- Note chat, container chat or a dictation cancel killing a main-chat
  background answer (today `cancelActiveStream()` is renderer-global).
- A fabricated "empty response" reply persisted for a turn that was
  cancelled (see the comment at `useChatStreaming.ts:377`).
- An approval card that can no longer be sent or dismissed because the view
  that showed it went away.
- Any regression in the other chat surfaces' behaviour.

## Decided with the user

- Scope: main Chat view only, for now.
- Leaving the view, switching conversation and New chat all keep the answer
  going.
- Conversations answer concurrently.
- Sidebar shows a loader on answering conversations, in the project's
  existing style.
- Returning to the Chat view reopens the last conversation and keeps the
  unsent draft.

## Behaviour

### Turn lifetime

A turn starts when the user sends in a conversation and ends when the
stream finishes, fails, or is cancelled. It is owned by the conversation id,
not by any component. Nothing in the Chat view's lifecycle (unmount,
conversation switch, New chat) ends it.

A turn is cancelled only by:

- Esc / Stop in that conversation (explicit cancel: partial answer
  discarded, as today);
- deleting that conversation;
- a new send superseding it (cannot happen in the UI: the composer is locked
  while the conversation answers);
- an account change (see "Account changes" below);
- *(my call)* the organisation turning the agent off — every running
  main-chat turn is cancelled, since the Chat view itself can no longer be
  shown.

Archiving a conversation does not cancel its turn *(my call)*; the answer
saves into the archived conversation.

Delete and policy-off discard the partial answer, the same as an explicit
Stop *(my call)*. A late save into a deleted conversation is already a no-op
in `db-add-agent-message`.

### Account changes

Conversations belong to an account, and this design adds state that outlives
the Chat view. An account change (sign-out, or another user replacing this
one) must therefore clear **all** of it, not only stop what's running:

- running turns and pending submissions (cancelled, partial answers
  discarded, no skill-card rows written);
- finished-but-unseen entries, which hold message text;
- drafts, including New chat's;
- the remembered conversation and New chat's attached skill, so the view
  lands on an empty New chat.

The reset is synchronous and bumps an account generation in the store, as
`noteStore`'s `resetForAccountChange` does. Every late callback checks that
generation first and does nothing if it changed: a creation or load that
resolves, a stream chunk, a tool result, a save, an `onSkillPicked`. None of
them may repopulate the store or write to the database for the old account.

The trigger must not depend on `ChatView` being mounted, since the chat is
usually unmounted when a background turn is running. It joins
`resetRendererCaches` in `src/hooks/useAuth.ts:54`, which already covers the
purge path (before and after the purge) and a verify that purged rows. It must
also run before `setActiveAccountScope` (`useAuth.ts:165`), because that call
changes the main process's scope first and an old turn's save could otherwise
land after it. The builder should confirm how that ordering is best achieved.

`useSignOut` reloads the window, which ends everything anyway, but it awaits
network work first, so it also resets at its start.

Existing behaviour stays as it is: `chatSkillMemory.ts` keeps its localStorage
rows, which hold skill names rather than conversation text.

### Sending

Once the user presses Send, the turn proceeds whatever they do next, including
while the conversation is still being created. Today two things drop such a
send: `useChatMessageSender`'s `isCurrent()` checks, and
`useChatPersistence.createConversation`, which throws `AbortError` if the
session changed during its IPC await. The main chat must get past both, so
removing the sender's checks alone isn't enough.

**Ownership starts before the first await.** Pressing Send synchronously:

1. gives the send a client-generated submission id;
2. adds a store entry under that id holding the user's message and a thinking
   state (for an existing conversation, the entry is that conversation's, and
   it starts from that conversation's own messages, not the view's);
3. if the sender is on screen, sets the view's selection to that submission,
   so the composer locks and the message shows at once;
4. clears the draft it was sent from.

That entry is the lock: a conversation or submission with a live entry can't
send again, while every other conversation can.

**Sending from New chat, while the conversation is being created:**

- Pressing New chat gives a fresh, empty, unlocked New chat. Selecting another
  conversation or leaving the view changes only the selection. None of these
  touch the submission.
- Leaving and returning while it's pending restores the submission's entry,
  with its message and thinking state.
- Creation doesn't go through the view-bound `persistence.createConversation`.
  It neither throws on navigation nor moves the view.
- When creation resolves, one store update moves the entry to the new
  conversation id, and moves the selection with it **only if the selection is
  still that submission**. A newer selection is never changed. Today's
  `onConversationCreated` in `ChatView` sets the active conversation
  unconditionally, and that has to go. The sidebar then refreshes and the new
  row appears with its loader.
- If the account generation changed meanwhile, no entry or turn is created. The
  builder should remove the orphaned row if main still allows it, otherwise it
  stays as a row of the old account.
- If creation fails, the entry goes away and the question isn't lost: it returns
  to the New chat draft, after whatever is already there *(my call)*. Today this
  failure surfaces nowhere.

**Writes use the bound conversation id.** `saveUserMessage` currently reads
`conversationIdRef`, the view's current conversation, so with a quick switch it
would save the question into the wrong one. It must take the bound id, as
`persistAssistantMessage` already does. The answer is persisted the same way.
- Everything a send writes back belongs to the send's own conversation, not
  to whatever is on screen. In particular `onSkillPicked` (the app picking a
  skill for a model without tools) writes that conversation's skill chip,
  not the one on screen *(my call)*.

### What the view shows

For the conversation on screen, the Chat view renders that conversation's
live turn state if one exists, otherwise what it loaded from the database.

A conversation's live state (messages, agent state, tool status/name) is
kept after its turn ends **until the user next opens that conversation**,
then the view takes it over and the store drops it. This covers outcomes
that are only in memory, such as an error message that isn't persisted, and
keeps message ids stable so approval cards (keyed
`messageId::toolCallId` in `connectorApprovalStore`) still render. Delete
drops it immediately.

When a turn ends while its conversation is on screen, the view simply keeps
showing the final state; no reload, no flicker.

### Returning to the Chat view

Today `ChatView` holds the open conversation (`activeConversationId`,
`isNewChat`) and the attached-skill state in local `useState`, so every
remount lands on an empty New chat. That state moves to a place that
outlives the view (the existing but unused `activeConversationId` in
`src/stores/chatStore.ts` is a candidate).

- Remounting reopens the conversation that was on screen when the user
  left: from its live store entry if it has one (taking it over as above),
  otherwise loaded from the database. There must be no flash of New chat on
  the way.
- If the user left from New chat, they come back to New chat, with its
  attached skill chip.
- The composer's unsent text is kept per conversation (and for New chat)
  and restored when the user returns to that conversation, whether by
  leaving and re-entering the view or by switching conversations in the
  sidebar *(my call: per conversation, not one shared draft; this follows
  from the user's answer and keeps a draft from following them into the
  wrong conversation)*. Sending, or the conversation being deleted, clears
  its draft.
- *(my call)* This memory lasts for the app session only: in memory, not
  persisted across launches. After a relaunch the Chat view opens as it does
  today. Attached skills already persist per conversation in localStorage
  (`chatSkillMemory.ts`) and keep doing so.
- **Validate on every open, even when a live entry exists.** A store entry
  skips the database, so it can't vouch for the conversation by itself. Opening
  a conversation always reads its row through `getAgentConversation` first. The
  row decides whether it may open; the entry supplies the messages while a turn
  is live or unseen. A newer selection beats a validation still in flight. While
  a restore validates, the message area stays blank rather than flashing New
  chat.
- **Deleted:** `getAgentConversation` returns `null` (it filters on
  `deleted_at`). The view falls back to New chat, the entry is dropped and any
  turn is cancelled.
- **Archived:** `getAgentConversation` does *not* filter archived rows and
  `loadConversation` accepts them, so the restore checks `archived_at`
  explicitly. If it's set, the view falls back to New chat and leaves the entry
  and any running turn alone, since archiving doesn't cancel. *(My call: this
  also applies if the user had deliberately opened an archived conversation
  before leaving. Keeping it open would mean remembering how it was opened, for
  little gain.)* Opening an archived conversation from the sidebar's Archived
  list keeps working as it does today.

### Approval cards

Cards live in global stores (`connectorApprovalStore`,
`skillApprovalStore`), so they already outlive the view. A card that appears
while the user is elsewhere stays pending, expires on the usual 10-minute
TTL, and the turn waits on it as today. Coming back shows it, live.

### Sidebar loader

While a conversation has a running turn, its row in `ConversationItem`
replaces the timestamp with `Loader2` (12px, `animate-spin`,
`text-muted-foreground/70`), the same loader the notes dialogs use for
in-progress states. Hover still swaps in the ⋯ menu. The row gets an
accessible "Answering…" label, a new i18n key added to every locale. The
loader goes away when the turn finishes, fails or is cancelled.

### Esc / Stop

`ChatInput`'s cancel applies to the conversation on screen only.

### Open skill link

`ChatView` disables the skill card's Open skill link while a turn is running
because leaving used to end the turn (`ChatView.tsx:196`). With this change
leaving no longer ends it, so the link stays enabled.

## Architecture (my calls)

### 1. Per-stream cancellation in `ReasoningService`

`processTextStreaming`, `processTextStreamingAI` and
`processTextStreamingCloud` take the caller's `AbortSignal`. Each stream owns
its own abort controller and cloud request id; starting a stream never
cancels another. The renderer-global "current stream" slot and
`cloudOperationGeneration` go away. `cancelAllRequests()` (dictation cancel)
aborts every stream it tracks, as it does today for the one. A chat surface
cancels only its own stream, through its own signal.

This is required for concurrency and for the anti-goal "note chat cancelling
a main-chat answer". (A dictation cancel cannot reach the Control Panel's
chat in practice: `cancelAllRequests()` is only called from `audioManager`
in the dictation window, which has its own `ReasoningService` instance.)

### 2. A turn engine outside React

The body of `useChatStreaming`'s `sendToAI` (the turn: context building,
tool registry, streaming, persistence, error handling) moves into a plain
module, e.g. `src/components/chat/chatTurnEngine.ts`, that has no React
dependency. It takes:

- its options (what `UseChatStreamingOptions` carries today), with the
  values the hook reads through refs at send time passed as getters
  (`openNote`, `noteContext`, `searchScope`, `noteMeeting`, the user's name);
- a sink for its output: message updates (`setMessages`-style updater),
  agent state, tool status and tool name, plus the existing
  `onStreamComplete` / `onResponseContent` callbacks;
- `t` from the shared i18next instance (`src/i18n.ts`).

It exposes `send(...)` and `cancel({ explicit })`. Each send creates its own
abort controller and tool scope; `cancel` aborts both and bumps the same
generation counter the hook uses today, keeping the explicit-vs-implicit
cancel distinction (`explicitCancelGenerationRef`).

`useChatStreaming` keeps its public API (`agentState`, `toolStatus`,
`activeToolName`, `sendToAI`, `cancelStream`) and becomes a thin wrapper:
one engine per hook instance, sink writing into React state, unmount →
implicit cancel. Every surface other than the main chat keeps its
behaviour.

### 3. A store for the main chat's turns

A zustand store, e.g. `src/stores/chatTurnStore.ts`, holds one entry per
conversation with a live or unseen turn, plus one per pending submission (see
"Sending"): messages, agent state, tool status/name, running flag. It also holds
the view's selection (New chat, a pending submission or a conversation), the
drafts and New chat's attached skill. Engines are held beside it (not in React
state). Actions: start a send, cancel a conversation's turn, move a submission to
its conversation, take over / drop an entry, cancel all (policy off),
`resetForAccountChange` (see "Account changes"), and a selector for "is this
conversation answering" for the sidebar.

`ChatView` reads the on-screen conversation from the store, sends through
it, and no longer cancels on unmount, switch or New chat.

## Constraints

- TypeScript strict, no `any`; named exports; explicit return types
  (user's global rules). Match surrounding code style.
- All new UI text goes through i18n in every locale (`src/locales/*`; there
  are 11 including ja and ar).
- Tests run with `node --import tsx --test` (Node 24 via nvm). Existing
  chat tests to keep green include `test/components/chatViewNewChat.test.js`,
  `chatViewSkills.test.js`, `test/hooks/embeddedChatNewChat.test.js`,
  `embeddedChatSendLock.test.js`, `containerChat.test.js`,
  `chatSurfacesConnectors.test.js` and the `test/services/reasoningService*`
  suites.
- Ordering: `db-add-agent-message` is an `ipcMain.handle` that writes SQLite
  synchronously, and one renderer's invokes reach main in order, so an
  answer saved before the user reopens a conversation is in the database the
  reopen reads. The builder should confirm this holds rather than assume it.

## Left to the builder

- Exact module names, file layout and the engine's sink shape.
- How `ChatView`'s message state and `useChatPersistence` cooperate with the
  store (an option on `useChatPersistence` for external message state, or
  `ChatView` reading the store directly), provided the behaviour above holds.
- Whether `ChatView` keeps using `useChatMessageSender` (with a
  per-conversation lock and no navigation drop) or sends through the store.
- Test strategy, beyond: concurrency of two conversations; leaving and
  returning mid-stream and after finish; Esc cancelling only its own
  conversation; another surface's cancel not touching a main-chat turn;
  delete cancelling; the sidebar loader appearing and clearing; leaving the
  view and returning lands on the same conversation with its draft. Also:
  - Send, then immediately New chat, another conversation or another view, with
    creation held open: the turn runs, its answer lands in the new conversation,
    and the newer selection doesn't move.
  - A quick switch after Send saves the question in the sending conversation.
  - An account change with the Chat view unmounted clears turns, unseen entries,
    drafts and the selection, and a held creation, load or stream chunk that
    resolves afterwards repopulates nothing and writes nothing.
  - Restoring a remembered conversation that was archived or deleted meanwhile,
    both with and without a cached entry, lands on New chat. The archived one's
    turn keeps running; the deleted one's is cancelled.
