# Agent answers paste as plain text — design

**Date:** 2026-09-10
**Status:** awaiting Josh's sign-off before anything is built
**Origin:** Finding 3 of the 1.10.0 release testing report (titan,
`artefacts/reports/2026-09-10-openwhispr-1-10-0-release-testing.md`)

## The problem

When a voice command's answer is pasted where the user was typing, the text
arrives with markdown syntax intact. Bold emphasis lands as literal asterisks,
headings as hash marks, bullets as dashes and stars. In a plain document that
reads as garbage.

Two halves, both real:

1. Nothing tells the model to avoid markdown. The chat-agent prompt is three
   sentences about being a concise voice assistant and says nothing about
   output format. Current models default to markdown.
2. Nothing in the delivery path touches the text. `deliverAssistantResponse`
   in `src/helpers/assistantResponseDelivery.ts` hands the model's output
   verbatim to `pasteAtCapturedTarget`.

A third, adjacent gap sits in the same code: when the main process declines to
paste, it returns one of four refusal codes and logs none of them. That is why
the feature reads as unreliable rather than as limited.

## The decision

**Both halves, in that order: instruct the model, then strip as a safety net.**
Plus the missing log line, because the code is already open.

Why not instruct alone: models drift, and a single leaked `**` on a customer's
document is a visible defect. Why not strip alone: a stripped table is
unreadable and a stripped list loses its shape, whereas a model asked for prose
writes flowing sentences that need no stripping. The instruction produces the
good output; the strip guarantees the floor.

### One refinement to the handover's framing

The handover assumed the instruction means editing `DEFAULT_CHAT_AGENT_PROMPT`
and therefore following the prompt-hash retirement protocol. It does not, and
it should not:

- **The panel renders markdown.** `AssistantPanel.tsx` displays answers through
  `MarkdownRenderer`. When the answer targets the panel rather than the caret,
  markdown is the right output. A base-prompt edit would degrade every panel
  answer to fix caret answers.
- **Custom prompts bypass the default entirely.** `resolvePrompt("chatAgent")`
  returns the user's `customPrompts.chatAgent` when one is set. An edit to the
  default never reaches those users. A suffix appended per request does, which
  is exactly how the dictionary and screen-context suffixes already work.
- **The shipped default text does not change**, so the retired-hash set and the
  current-hash snapshot in `src/config/retiredPrompts.js` stay as they are.

So the instruction is a **conditional suffix**, appended only when the answer
is destined for the caret. The base prompt is untouched.

## Design

### 1. Tell the model, per request

`SendToAIOptions` in `src/components/chat/useChatStreaming.ts` gains one
optional flag:

```ts
/** Asks for plain prose because the answer will be pasted into another app. */
plainTextResponse?: boolean;
```

`AssistantPanel.tsx` already computes `targetsCapturedInput` (delivery mode is
`paste`) and passes `suppressResponseContent` from it. It passes
`plainTextResponse` from the same boolean. The two flags stay separate because
they mean different things: one is about what the panel shows, the other about
what the model writes.

`useChatStreaming.sendToAI` appends the suffix **last**, after the dictionary
and screen-context suffixes, so it sits where models weight instructions most
(the same reasoning the cleanup prompt documents in `src/config/prompts/index.ts`).

The suffix is an English constant, `PLAIN_TEXT_RESPONSE_SUFFIX`, defined in
`src/config/prompts/registry.ts` beside `DEFAULT_CHAT_AGENT_PROMPT`. It is not
localised because the chat-agent prompt it extends is not localised
(`i18nKey: null`). It is applied by a new `appendPlainTextResponseSuffix(prompt)`
in `src/config/prompts/index.ts`, re-exported from `src/config/prompts.ts`
alongside the other `append*Suffix` helpers.

Text:

> OUTPUT FORMAT: Your answer will be inserted as plain text exactly where the
> user is typing, inside another application. Write plain prose with no
> markdown: no asterisks, underscores, backticks, heading marks, bullet or
> numbered-list markers, tables, or link syntax. Use ordinary sentences and
> paragraphs. If several items must be listed, put each on its own line with no
> marker.

The suffix reaches every route. The cloud route forwards the client-built
system prompt on every step of the tool loop (`processTextStreamingCloud` →
`streamFromIPC` with `systemPrompt`), and the BYOK, LAN and local routes take
it through `processTextStreamingAI`. No server change is needed.

### 2. Strip before pasting, as the floor

A new pure helper, `markdownToPlainText(text)` in
`src/helpers/markdownToPlainText.ts`. It preserves every line break. That is
the whole reason it is a new helper: the existing `stripMarkdownPreview` in
`src/components/CommandSearch.tsx` collapses all newlines into one space
because it feeds one-line search previews, and it must not be reused or
"generalised" for this.

Rules, chosen so that nothing a human would type in plain text is ever
altered:

| Markdown | Becomes |
|---|---|
| ` ```lang ` fences | Fence lines removed, the code inside kept verbatim |
| `` `code` `` | `code` |
| `# Heading` … `###### Heading` | `Heading` |
| `**bold**`, `__bold__` | `bold` |
| `*em*`, `_em_` (paired, hugging non-space) | `em` |
| `~~struck~~` | `struck` |
| `[text](url)` | `text (url)`, or just `url` when text equals url |
| `![alt](url)` | `alt` |
| `* item`, `+ item` | `- item` |
| `- item`, `1. item` | unchanged — humans type these in plain text |
| `> quoted` | `quoted` |
| `---`, `***`, `___` on a line by itself | line removed |
| `\| a \| b \|` rows | outer pipes dropped, cells joined by a tab; the `\|---\|` alignment row removed |
| `\*`, `\_`, `` \` `` and the other markdown escapes | the escaped character |

Explicitly not altered: `2 * 3 * 4` (spaces around the star), `snake_case_names`
(underscore inside a word), a lone `*` or `_`, and email-style `> ` is stripped
only at line start.

Where it is applied: inside `deliverAssistantResponse`, **only when
`delivery.mode === "paste"`**, and to both the paste and its clipboard fallback
(the answer was written for the caret; if the paste is refused and the text
lands on the clipboard, the user is about to paste it into the same place by
hand). `mode: "clipboard"` stays verbatim: that answer is shown in the panel as
rendered markdown, and copying it manually already yields raw markdown, so the
two copy paths stay consistent.

### 3. Conversation history and the panel copy

Decided, not discovered:

- **History stores what the model wrote.** With the suffix, a caret-targeted
  turn is stored as prose. That is correct: the stored turn is the answer the
  user received.
- **The strip never touches history.** It is a delivery transform applied to
  the bytes handed to the paste, not to the message. If the model drifts and
  emits a stray `**`, the panel's conversation view still shows the rendered
  version and the pasted text shows the clean one.
- **The panel's Copy button is unchanged.** It copies the stored content.

### 4. Log the refusal

`SelectionManager.pasteAtCapturedTarget` in `src/helpers/selectionManager.js`
gets a single `debugLogger.info` at every decline, scope `clipboard`, carrying
enough to diagnose without a trace through four files:

```
Assistant response paste declined  { code, sessionFound, sessionKind, probeStatus, probeCode, platform }
```

where `code` is one of the four existing refusal codes (`invalid_replacement`,
`session_expired`, `target_changed`, `paste_failed`), and `probeStatus` /
`probeCode` are the editable-probe verdict that produced `target_changed`
(`target_unavailable`, `accessibility_unavailable`, `selection_unavailable`,
`unsupported_platform`, …). A matching `debug`-level line records a successful
paste with the target kind. The existing `warn` on a thrown paste error stays.

Nothing about the return values changes; the renderer keeps receiving the same
`{ success, code }`.

## What this does not do

- **Rich text.** Stripping is blind to the destination. Pasting into Notes,
  Word or Mail, raw markdown is wrong but so is flattened text, because those
  targets accept real formatting. Doing that right means writing rich text
  (RTF or HTML) to the clipboard alongside plain text and letting the target
  choose. That is a separate, larger piece of work and is deliberately not
  started here.
- **PR #1952.** Agent paste never succeeds in Chromium and Electron targets
  (VS Code, Slack, Arc) for the unrelated reason that PR addresses. That PR is
  someone else's open work, conflicts with main, and is not touched. Note the
  consequence: today this defect is visible only in native macOS apps; the
  moment #1952 lands it becomes visible everywhere paste starts working, which
  is why this is worth landing first or alongside.
- **Localising the suffix.** The chat-agent prompt is English-only today; the
  suffix follows it. If the base prompt is ever localised, the suffix moves
  into the locale bundles with it.
- **Renderer-side logging.** `deliverAssistantResponse` still swallows the
  refusal code. The main-process debug log is the single log file, so that is
  where the line goes.

## Testing

All under the repo's `node --test` runner (`npm test`, Node 24).

- `test/helpers/markdownToPlainText.test.js`: one case per rule above, plus the
  "must not alter" cases, plus a two-paragraph answer that proves paragraphs
  survive (the trap the search-preview helper would fail).
- `test/helpers/assistantResponseDelivery.test.js`: a paste delivery receives
  the stripped text; the clipboard fallback of a refused paste receives the
  stripped text; a `clipboard` delivery receives the original text.
- `test/helpers/agentPlainTextSuffix.test.js`: `appendPlainTextResponseSuffix`
  appends the constant once; the base `getAgentSystemPrompt` output does not
  contain it (so panel answers are unaffected).
- `test/helpers/selectionManager.test.js`: each of the four refusals emits the
  info line with its code; a successful paste does not emit it.
- `test/helpers/retiredPrompts.test.js`: unchanged and still green, which is
  the proof the hash protocol was not triggered.
- Manual, on a dev build (`openwhispr-dev-build` skill), macOS: ask a question
  that invites a list while the caret is in TextEdit; confirm prose with no
  markers lands; then dismiss the target before the answer arrives and confirm
  the `target_changed` line appears in the debug log with its probe code.

## Verification of the premises

Checked against `origin/main` at `a2c76ef9` on 2026-09-10:

- `deliverAssistantResponse` passes `content` untouched to
  `pasteAtCapturedTarget` (`src/helpers/assistantResponseDelivery.ts`).
- `DEFAULT_CHAT_AGENT_PROMPT` is three sentences with no format instruction
  (`src/config/prompts/registry.ts`).
- `AssistantPanel.tsx` line 209 passes `suppressResponseContent:
  targetsCapturedInput`; content still reaches `persistence.saveAssistantMessage`.
- `pasteAtCapturedTarget` returns four refusal codes and logs only the thrown
  case (`src/helpers/selectionManager.js` lines 257–291).
- The cloud route forwards the client `systemPrompt` on every tool-loop step
  (`src/services/ReasoningService.ts` around line 1115).
- `stripMarkdownPreview` collapses `\n+` to a space
  (`src/components/CommandSearch.tsx` line 64).
