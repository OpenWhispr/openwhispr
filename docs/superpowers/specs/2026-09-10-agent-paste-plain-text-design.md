# Agent answers paste as plain text — design

**Date:** 2026-09-10, revised 2026-09-11 (markdown-friendly targets)
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

And a fourth, raised by Josh on 2026-09-11: **plain text is wrong for a large
class of targets.** Markdown-native editors (Obsidian, Typora), apps that
convert pasted markdown (Notion, Craft), chat tools whose composer is standard
markdown (Discord, Mattermost), AI prompt boxes (ChatGPT, Claude, Cursor's
chat) and code editors all want the markdown left alone. Many OpenWhispr users
are developers, and AI prompt boxes in particular are a daily surface for them.

## The decision

**Instruct the model, then strip as a safety net — but only when the target
wants plain text. A researched allowlist of markdown-friendly apps keeps their
markdown untouched.** Plus the missing log line, because the code is already
open.

Why not instruct alone: models drift, and a single leaked `**` on a customer's
document is a visible defect. Why not strip alone: a stripped table is
unreadable and a stripped list loses its shape, whereas a model asked for prose
writes flowing sentences that need no stripping. Why the allowlist: the strip
is blind to its destination, and for a markdown editor or an AI prompt box it
would actively damage a good answer. Plain text stays the default for anything
not on the list, because the cost of a wrong "keeps markdown" verdict (literal
asterisks in someone's document) is higher than the cost of a wrong "plain
text" verdict (a flat but readable answer in Obsidian).

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
is destined for a caret that wants plain text. The base prompt is untouched.

## Design

### 0. The main process decides, once, at capture time

The main process already identifies the app under the caret, because it has to
check the caret is still there before pasting. What it knows differs by
platform, and the allowlist matches on all of it:

| Platform | Identity available                                                                                                                                                                     | Source in code                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| macOS    | The `.app` folder name and executable name, resolved from the pid (`"Visual Studio Code Code"`, `"Obsidian Obsidian"`); on the Chromium path also the copy helper's localized app name | `_isTerminalPid` → `_readExecutablePath` (`ps -o comm=`); `_readMacSelectionViaClipboard` (`appName`) |
| Windows  | The exe name (`"Obsidian.exe"`, `"idea64.exe"`) and window class (almost always `Chrome_WidgetWin_1` for Electron, so the exe is the discriminator)                                    | `lastTarget.exeName` / `windowClass` from the fast-paste helper's `--detect` run                      |
| Linux    | The WM_CLASS (`"obsidian"`, `"md.obsidian.obsidian"` under Flatpak, `"jetbrains-idea"`), or for AT-SPI targets a pid resolved like macOS                                               | `_getLinuxTarget` (`windowClass`); `_isTerminalPid` for `atspi-pid`                                   |

The precedents are `_isLineCopyEditor` (an editor-name list) and
`isTerminalSignature` (a terminal-name list). The markdown check follows the
same shape with one difference: **it matches whole tokens or phrases, never
bare substrings**, so `code` does not match `Xcode`, and short names cannot
false-match inside longer ones. A few explicit vetoes are checked first
(`notion calendar`, `notion mail`, `xcode`).

The verdict is computed **once, when the caret session is created** in
`captureSelectedText`, stored on the session, and returned to the renderer as
`acceptsMarkdown: boolean` on the `editable` capture result. Nothing is
resolved again at paste time. A pid that cannot be read, an app not on the
list, or any error yields `false`: plain text is the safe default.

### 1. Tell the model, per request

`SendToAIOptions` in `src/components/chat/useChatStreaming.ts` gains one
optional flag:

```ts
/** Asks for plain prose because the answer will be pasted into another app. */
plainTextResponse?: boolean;
```

The renderer already carries the caret session id from the capture result to
the panel (`audioManager` → `pendingAssistantConversation.deliverySessionId` →
`useAudioRecording` → `createAssistantResponseDelivery`). `acceptsMarkdown`
rides the same route as `deliveryAcceptsMarkdown`, and the delivery object's
`paste` variant gains `plainText: boolean` (`!acceptsMarkdown`).

`AssistantPanel.tsx` already computes `targetsCapturedInput` (delivery mode is
`paste`) and passes `suppressResponseContent` from it. It passes
`plainTextResponse` from `delivery.mode === "paste" && delivery.plainText`. The
two flags stay separate because they mean different things: one is about what
the panel shows, the other about what the model writes. A caret in Obsidian
still suppresses the panel content; it just does not ask for prose.

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

| Markdown                                            | Becomes                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| ` ```lang ` fences                                  | Fence lines removed, the code inside kept verbatim                              |
| `` `code` ``                                        | `code`                                                                          |
| `# Heading` … `###### Heading`                      | `Heading`                                                                       |
| `**bold**`, `__bold__`                              | `bold`                                                                          |
| `*em*`, `_em_` (paired, hugging non-space)          | `em`                                                                            |
| `~~struck~~`                                        | `struck`                                                                        |
| `[text](url)`                                       | `text (url)`, or just `url` when text equals url                                |
| `![alt](url)`                                       | `alt`                                                                           |
| `* item`, `+ item`                                  | `- item`                                                                        |
| `- item`, `1. item`                                 | unchanged — humans type these in plain text                                     |
| `> quoted`                                          | `quoted`                                                                        |
| `---`, `***`, `___` on a line by itself             | line removed                                                                    |
| `\| a \| b \|` rows                                 | outer pipes dropped, cells joined by a tab; the `\|---\|` alignment row removed |
| `\*`, `\_`, `` \` `` and the other markdown escapes | the escaped character                                                           |

Explicitly not altered: `2 * 3 * 4` (spaces around the star), `snake_case_names`
(underscore inside a word), a lone `*` or `_`, an escaped marker such as `\*`,
and `>` anywhere but line start.

Where it is applied: inside `deliverAssistantResponse`, **only when
`delivery.mode === "paste"` and `delivery.plainText` is true**, and to both the
paste and its clipboard fallback (the answer was written for the caret; if the
paste is refused and the text lands on the clipboard, the user is about to
paste it into the same place by hand). A paste delivery with `plainText: false`
(a markdown-friendly target) and a `mode: "clipboard"` delivery both stay
verbatim: the clipboard-only answer is shown in the panel as rendered markdown,
and copying it manually already yields raw markdown, so the two copy paths stay
consistent.

### 3. The allowlist

`src/helpers/markdownTargets.js` (CommonJS, main process, no Electron
imports so it tests in plain Node) exports the list, the vetoes, and
`isMarkdownTargetSignature(signature)`. The list is data, grouped by why
markdown is right there:

1. **Markdown-native note editors** — the file _is_ markdown.
2. **Apps that convert pasted markdown into formatting** — vendor-documented.
3. **Chat composers that are standard markdown** — Discord, Zulip, Mattermost,
   Element, Rocket.Chat. Not Slack, Teams, WhatsApp or Telegram, whose dialects
   turn `**bold**` into stray asterisks and have no headings (Appendix B).
4. **Work tools whose long-text fields convert pasted markdown** — Linear,
   Todoist, TickTick, Trello. Their short title fields are plain text, but an
   agent answer lands in a description or comment in practice.
5. **AI prompt boxes** — a language model reads markdown happily, and a
   stripped table or code fence would make the prompt worse.
6. **Code editors and IDEs** — nothing renders formatting there, a developer's
   backticks and fences are deliberate, and the AI chat panels inside Cursor,
   VS Code and the JetBrains family are prompt boxes. General-purpose plain-text
   editors used for prose (TextEdit, Notepad) are **not** in this group:
   TextEdit is the reproduction case for this whole defect.

Inclusion rule: an app is listed only when its markdown-on-paste behaviour is
documented by the vendor or is the app's defining property (Appendix A carries
the evidence per app). An **unverified identity string is acceptable** because
a wrong name merely fails to match and falls back to plain text; a
**generic token is not**, because it could match an unrelated app and paste
markdown into a plain document. That is why `riot` (Element's Flatpak id) is
absent, since it would match the Riot Games launcher, and why `remarkable`
(a small Linux editor) is absent, since it would match the reMarkable tablet
app.

Apps whose behaviour is mixed, undocumented or contested go to Appendix C and
are added only after a hand test.

### 4. Conversation history and the panel copy

Decided, not discovered:

- **History stores what the model wrote.** With the suffix, a caret-targeted
  turn is stored as prose. That is correct: the stored turn is the answer the
  user received. For a markdown-friendly target the stored turn is markdown,
  also what the user received.
- **The strip never touches history.** It is a delivery transform applied to
  the bytes handed to the paste, not to the message. If the model drifts and
  emits a stray `**`, the panel's conversation view still shows the rendered
  version and the pasted text shows the clean one.
- **The panel's Copy button is unchanged.** It copies the stored content.

### 5. Log the refusal

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
paste with the target kind and the session's `acceptsMarkdown` verdict, so a
"why did this paste markdown" question is answered by the log too. The
existing `warn` on a thrown paste error stays.

Nothing about the return values changes; the renderer keeps receiving the same
`{ success, code }`.

## What this does not do

- **Rich text.** Pasting into Notes, Word or Mail, raw markdown is wrong but so
  is flattened text, because those targets accept real formatting. Doing that
  right means writing rich text (RTF or HTML) to the clipboard alongside plain
  text and letting the target choose. Separate, larger work.
- **Web apps in a browser.** The identity available today is the browser
  (`Google Chrome`, `Arc`, `Safari`), never the site, so ChatGPT, Claude,
  Notion, GitHub or Linear in a tab get plain text like any other browser
  target — and so, correctly, do Gmail and Google Docs. Telling them apart
  needs the focused window's title (the page title, readable through the
  accessibility API on macOS and `GetWindowText` on Windows) matched against a
  site list. That is the natural follow-up once PR #1952 makes browser targets
  reachable at all; it is not in this change. Every AI tool in the list ships a
  desktop app, which is why the desktop allowlist already covers the most
  common case Josh raised.
- **PR #1952.** Agent paste never succeeds in Chromium and Electron targets
  (VS Code, Slack, Arc, Obsidian) for the unrelated reason that PR addresses.
  That PR is someone else's open work, conflicts with main, and is not touched.
  Note the consequence: today this defect is visible only in native macOS apps;
  the moment #1952 lands the allowlist becomes load-bearing, because most of
  the markdown-friendly apps are Electron. On macOS today the allowlist can be
  exercised only through native apps such as the ChatGPT and Gemini desktop
  apps, Bear and iA Writer.
- **Localising the suffix.** The chat-agent prompt is English-only today; the
  suffix follows it.
- **Renderer-side logging.** `deliverAssistantResponse` still swallows the
  refusal code. The main-process debug log is the single log file, so that is
  where the line goes.
- **A user setting.** "Paste answers as plain text / as written" would let a
  user override the list. Not now: the list should earn its keep first, and a
  setting is where a wrong default hides.

## Testing

All under the repo's `node --test` runner (`npm test`, Node 24).

- `test/helpers/markdownToPlainText.test.js`: one case per rule above, plus the
  "must not alter" cases, plus a two-paragraph answer that proves paragraphs
  survive (the trap the search-preview helper would fail).
- `test/helpers/markdownTargets.test.js`: every platform's identity shape for a
  listed app matches; plain-text apps, the excluded chat dialects, `Xcode`, the
  vetoes and browsers never match; every entry is lowercase and at least three
  characters.
- `test/helpers/selectionManager.test.js`: a caret in a listed macOS app yields
  `acceptsMarkdown: true` on the capture result and the session; a caret in
  TextEdit yields `false`; an unreadable pid yields `false`; Windows and Linux
  targets are judged by exe name and window class; each of the four paste
  refusals emits the info line with its code; a successful paste emits the
  debug line with the verdict.
- `test/helpers/audioManagerAssistantDirective.test.js`: the verdict rides
  next to the session id into `pendingAssistantConversation`, and is absent
  when there is no caret delivery.
- `test/helpers/assistantResponseDelivery.test.js`: `createAssistantResponseDelivery`
  sets `plainText` from the verdict; a plain-text paste and its clipboard
  fallback receive the stripped text; a markdown-friendly paste and a
  `clipboard` delivery receive the original text.
- `test/helpers/agentPlainTextSuffix.test.js`: `appendPlainTextResponseSuffix`
  appends the constant once; the base `getAgentSystemPrompt` output does not
  contain it (so panel answers are unaffected).
- `test/helpers/retiredPrompts.test.js`: unchanged and still green, which is
  the proof the hash protocol was not triggered.
- Manual, on a dev build (`openwhispr-dev-build` skill), macOS: ask a question
  that invites a list while the caret is in TextEdit; confirm prose with no
  markers lands and the log shows `acceptsMarkdown: false`. Repeat with the
  caret in the ChatGPT desktop app's prompt box (a native app, so paste works
  today); confirm markdown lands intact and the log shows `acceptsMarkdown:
true`. Then dismiss the target before the answer arrives and confirm the
  `target_changed` line appears with its probe code.

## Verification of the premises

Checked against `origin/main` at `a2c76ef9` on 2026-09-10 and 2026-09-11:

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
- Target identity per platform: macOS `_isTerminalPid` resolves
  `"<bundle> <executable>"` from `ps -o comm=` (`selectionManager.js` 516–529);
  the macOS copy helper prints the app's `localizedName`
  (`resources/macos-fast-paste.swift` line 32); the Windows helper prints
  `WINDOW_CLASS` and `EXE_NAME` on detect (`resources/windows-fast-paste.c`
  295–297); Linux targets carry `windowClass` (`selectionManager.js` 577–603).
  No helper reads a window title today.
- The caret session id travels `captureSelectedText` → `audioManager`
  (`deliverySessionId`, lines 2666–2679) → `useAudioRecording.js` 504–530 →
  `createAssistantResponseDelivery`.
- Installed on Josh's Mac and inspected for `.app` name / executable:
  Obsidian/Obsidian, Notion/Notion, Slack/Slack, Discord/Discord, Visual
  Studio Code/Code, ChatGPT/ChatGPT, Claude/Claude, Linear/Linear, Microsoft
  Teams/MSTeams, WhatsApp/WhatsApp, Gemini/Gemini, Ollama/Ollama,
  Antigravity/Antigravity.

## Appendix A — markdown-friendly targets (the allowlist, with evidence)

Research on 2026-09-11 by three parallel agents (note editors; chat and work
tools; AI tools and IDEs), cross-checked against Homebrew cask manifests for
`.app` names, Flathub and upstream `.desktop` files for Linux WM_CLASS, and
the apps installed on Josh's Mac for executables. "unverified" means the
identity string follows the vendor's naming convention but no manifest or
binary was inspected; per the inclusion rule that is acceptable because a miss
falls back to plain text. Tokens are what `markdownTargets.js` carries.

### A1. Markdown-native note editors

| App                  | Platforms | Evidence                                                 | macOS `.app` / executable               | Windows exe                  | Linux WM_CLASS                                                      | Tokens                               |
| -------------------- | --------- | -------------------------------------------------------- | --------------------------------------- | ---------------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| Obsidian             | m/w/l     | edits `.md` on disk                                      | Obsidian / Obsidian (inspected)         | Obsidian.exe                 | obsidian; md.obsidian.Obsidian (Flatpak)                            | `obsidian`                           |
| Typora               | m/w/l     | support.typora.io/Copy-and-Paste                         | Typora / Typora (cask)                  | Typora.exe                   | typora (Flathub); io.typora.Typora (Flatpak)                        | `typora`                             |
| Logseq               | m/w/l     | markdownguide.org/tools/logseq                           | Logseq / Logseq (cask)                  | Logseq.exe                   | Logseq (Flathub); com.logseq.Logseq (Flatpak)                       | `logseq`                             |
| Joplin               | m/w/l     | joplinapp.org/help/apps/rich_text_editor (default is md) | Joplin / Joplin (cask)                  | Joplin.exe                   | joplin (electron-builder); net.cozic.joplin_desktop (Flatpak)       | `joplin`                             |
| Zettlr               | m/w/l     | docs.zettlr.com/en/editor                                | Zettlr / Zettlr (cask)                  | Zettlr.exe (unverified)      | zettlr; com.zettlr.Zettlr (Flatpak)                                 | `zettlr`                             |
| iA Writer            | m         | ia.net/writer/how-to/format-text                         | iA Writer (MAS, unverified)             | —                            | —                                                                   | `ia writer`                          |
| Ulysses              | m         | help.ulysses.app smart copy and paste                    | Ulysses (MAS, unverified)               | —                            | —                                                                   | `ulysses`                            |
| Simplenote           | m/w/l     | markdownguide.org/tools/simplenote (editor shows source) | Simplenote (cask)                       | Simplenote.exe (unverified)  | simplenote (unverified); com.simplenote.Simplenote (Flatpak)        | `simplenote`                         |
| Inkdrop              | m/w/l     | forum.inkdrop.app thread 4956                            | Inkdrop (cask)                          | Inkdrop.exe                  | inkdrop (unverified)                                                | `inkdrop`                            |
| MarkText             | m/w/l     | marktext.me/docs (cask deprecated 2026-09, unsigned)     | MarkText (cask)                         | MarkText.exe (unverified)    | marktext (electron-builder); com.github.marktext.marktext (Flatpak) | `marktext`                           |
| NotePlan             | m         | help.noteplan.co/article/45                              | NotePlan (MAS, unverified)              | —                            | —                                                                   | `noteplan`                           |
| Drafts               | m         | docs.getdrafts.com/docs/settings/markdown                | Drafts (MAS, unverified)                | —                            | —                                                                   | `drafts`                             |
| MacDown              | m         | macdown.uranusjr.com/features                            | MacDown / MacDown (cask)                | —                            | —                                                                   | `macdown`                            |
| MarkEdit             | m         | github.com/MarkEdit-app/MarkEdit                         | MarkEdit / MarkEdit (cask)              | —                            | —                                                                   | `markedit`                           |
| Nota                 | m         | nota.md: "no transformations on copy or paste"           | Nota (cask)                             | —                            | —                                                                   | `nota`                               |
| Byword               | m         | bywordapp.com                                            | Byword (MAS, unverified)                | —                            | —                                                                   | `byword`                             |
| FSNotes              | m         | fsnot.es                                                 | FSNotes (cask)                          | —                            | —                                                                   | `fsnotes`                            |
| The Archive          | m         | zettelkasten.de/the-archive (plain markdown)             | The Archive (cask)                      | —                            | —                                                                   | `the archive`                        |
| QOwnNotes            | m/w/l     | github.com/pbek/QOwnNotes (Qt plain text)                | QOwnNotes / QOwnNotes (cask)            | QOwnNotes.exe (unverified)   | qownnotes (unverified); org.qownnotes.QOwnNotes (Flatpak)           | `qownnotes`                          |
| Boost Note / Notable | m/w/l     | boostnote.io, notable.app (source editors)               | Boost Note (cask); Notable (unverified) | unverified                   | unverified                                                          | `boost note`, `boostnote`, `notable` |
| Supernotes           | m/w/l     | help.supernotes.app                                      | Supernotes (cask)                       | unverified                   | unverified                                                          | `supernotes`                         |
| Heynote              | m/w/l     | github.com/heyman/heynote                                | Heynote / Heynote (cask)                | Heynote.exe (unverified)     | heynote (unverified)                                                | `heynote`                            |
| Apostrophe           | l         | apps.gnome.org/Apostrophe                                | —                                       | —                            | org.gnome.gitlab.somas.Apostrophe (Flatpak)                         | `apostrophe`                         |
| Ghostwriter (KDE)    | w/l       | github.com/KDE/ghostwriter                               | —                                       | ghostwriter.exe (unverified) | ghostwriter (unverified); org.kde.ghostwriter (Flatpak)             | `ghostwriter`                        |
| Abricotine           | m/w/l     | github.com/brrd/abricotine (dormant)                     | unverified                              | unverified                   | abricotine (desktopName)                                            | `abricotine`                         |

### A2. Apps that convert pasted markdown into formatting

| App           | Platforms | Evidence                                                              | macOS `.app` / executable    | Windows exe                | Linux WM_CLASS                 | Tokens                                              |
| ------------- | --------- | --------------------------------------------------------------------- | ---------------------------- | -------------------------- | ------------------------------ | --------------------------------------------------- |
| Notion        | m/w       | markdownguide.org/tools/notion (converts on paste)                    | Notion / Notion (inspected)  | Notion.exe                 | —                              | `notion` (vetoes: `notion calendar`, `notion mail`) |
| Evernote      | m/w       | help.evernote.com 39988720040211 (plain-text markdown converts on ⌘V) | Evernote (cask)              | Evernote.exe (unverified)  | unverified                     | `evernote`                                          |
| Notesnook     | m/w/l     | blog.notesnook.com v3.0.27 "pasting markdown directly"                | Notesnook / Notesnook (cask) | Notesnook.exe (unverified) | start-notesnook (Flathub)      | `notesnook`                                         |
| WorkFlowy     | m/w       | blog.workflowy.com/proper-markdown-pasting                            | WorkFlowy (cask)             | unverified                 | —                              | `workflowy`                                         |
| Bear          | m         | bear.app/faq/how-to-use-markdown-in-bear                              | Bear (MAS, unverified)       | —                          | —                              | `bear`                                              |
| Craft         | m/w       | support.craft.do formatting                                           | Craft (cask)                 | Craft.exe (unverified)     | —                              | `craft`                                             |
| RemNote       | m/w/l     | help.remnote.com 6030579                                              | RemNote (cask)               | unverified                 | unverified                     | `remnote`                                           |
| Anytype       | m/w/l     | community.anytype.io/t/1314 (converts, gaps on checkboxes)            | Anytype (cask)               | Anytype.exe (unverified)   | io.anytype.anytype (Flathub)   | `anytype`                                           |
| SiYuan        | m/w/l     | github.com/siyuan-note/siyuan (Protyle)                               | SiYuan / SiYuan (cask)       | unverified                 | SiYuan (Flathub)               | `siyuan`                                            |
| Capacities    | m/w       | docs.capacities.io/reference/import                                   | Capacities (cask)            | unverified                 | unverified                     | `capacities`                                        |
| Reflect       | m/w       | curtismchale.ca in-depth-look-at-reflect                              | Reflect (cask)               | unverified                 | —                              | `reflect`                                           |
| Heptabase     | m/w       | wiki.heptabase.com                                                    | Heptabase (cask)             | unverified                 | unverified                     | `heptabase`                                         |
| Roam Research | m/w/l     | outlinersoftware.com desktop announcement (md per block)              | Roam Research (cask)         | unverified                 | unverified                     | `roam`                                              |
| AppFlowy      | m/w/l     | appflowy.io (Notion-like block editor, converts on paste)             | AppFlowy (cask)              | AppFlowy.exe (winget)      | io.appflowy.AppFlowy (Flathub) | `appflowy`                                          |

### A3. Chat composers that are standard markdown

| App         | Platforms | Evidence                                                    | macOS `.app` / executable     | Windows exe                  | Linux WM_CLASS                   | Tokens                      |
| ----------- | --------- | ----------------------------------------------------------- | ----------------------------- | ---------------------------- | -------------------------------- | --------------------------- |
| Discord     | m/w/l     | Discord markdown guide (headings, lists, fences; no tables) | Discord / Discord (inspected) | Discord.exe                  | discord                          | `discord`                   |
| Zulip       | m/w/l     | zulip.com/help/format-your-message-using-markdown           | Zulip (unverified)            | Zulip.exe (unverified)       | org.zulip.Zulip (Flatpak)        | `zulip`                     |
| Mattermost  | m/w/l     | docs.mattermost.com format-messages                         | Mattermost (unverified)       | Mattermost.exe (unverified)  | com.mattermost.Desktop (Flatpak) | `mattermost`                |
| Element     | m/w/l     | matrix-react-sdk PR 8358 (markdown parsed at send)          | Element (unverified)          | Element.exe (unverified)     | Element; im.riot.Riot (Flatpak)  | `element` (not `riot`)      |
| Rocket.Chat | m/w/l     | docs.rocket.chat/docs/messages                              | Rocket.Chat (unverified)      | Rocket.Chat.exe (unverified) | chat.rocket.RocketChat (Flatpak) | `rocket.chat`, `rocketchat` |

### A4. Work tools whose long-text fields convert pasted markdown

| App      | Platforms | Evidence                                                            | macOS `.app` / executable   | Windows exe               | Linux WM_CLASS                  | Tokens     |
| -------- | --------- | ------------------------------------------------------------------- | --------------------------- | ------------------------- | ------------------------------- | ---------- |
| Linear   | m/w       | linear.app/docs/editor (pasted markdown becomes rich text)          | Linear / Linear (inspected) | Linear.exe (unverified)   | —                               | `linear`   |
| Todoist  | m/w/l     | todoist.com/help format-text (descriptions, comments; titles plain) | Todoist (unverified)        | Todoist.exe (unverified)  | com.todoist.Todoist (Flatpak)   | `todoist`  |
| TickTick | m/w/l     | blog.ticktick.com markdown quick start                              | TickTick (unverified)       | TickTick.exe (unverified) | com.ticktick.TickTick (Flatpak) | `ticktick` |
| Trello   | m/w       | support.atlassian.com how-to-format-your-text-in-trello             | Trello (unverified)         | trello.exe                | —                               | `trello`   |

### A5. AI prompt boxes

| App                | Platforms | Evidence                                  | macOS `.app` / executable      | Windows exe                           | Linux WM_CLASS         | Tokens                              |
| ------------------ | --------- | ----------------------------------------- | ------------------------------ | ------------------------------------- | ---------------------- | ----------------------------------- |
| ChatGPT            | m/w       | model reads markdown                      | ChatGPT / ChatGPT (inspected)  | ChatGPT.exe                           | —                      | `chatgpt`                           |
| Claude             | m/w       | model reads markdown                      | Claude / Claude (inspected)    | Claude.exe (unverified)               | —                      | `claude`                            |
| Google Gemini      | m         | native app since 2026-04                  | Gemini / Gemini (inspected)    | —                                     | —                      | `gemini`                            |
| Perplexity         | m         | perplexity cask                           | Perplexity (cask)              | —                                     | —                      | `perplexity`                        |
| Microsoft Copilot  | m/w       | consumer app; M365 Copilot on Windows     | Microsoft Copilot (unverified) | Copilot.exe; M365Copilot.exe          | —                      | `copilot`, `m365copilot`            |
| GitHub Copilot app | m/w/l     | github.com/features/ai (standalone, 2026) | GitHub Copilot (unverified)    | GitHub Copilot.exe (unverified)       | unverified             | `copilot`                           |
| Poe                | m/w       | poe.com/pages/get-poe                     | Poe (cask)                     | Poe.exe                               | —                      | `poe`                               |
| LM Studio          | m/w/l     | lm-studio cask                            | LM Studio (cask)               | LM Studio.exe                         | lm-studio (unverified) | `lm studio`, `lm-studio`            |
| Ollama app         | m/w       | docs.ollama.com/windows                   | Ollama / Ollama (inspected)    | ollama app.exe (unverified)           | —                      | `ollama`                            |
| Jan                | m/w/l     | github.com/janhq/jan                      | Jan (unverified)               | Jan.exe (unverified)                  | Jan (unverified)       | `jan`                               |
| Msty               | m/w/l     | msty cask                                 | Msty (cask)                    | Msty.exe (unverified)                 | Msty (unverified)      | `msty`                              |
| Chatbox            | m/w/l     | chatbox cask                              | Chatbox (cask)                 | Chatbox.exe (unverified)              | Chatbox (unverified)   | `chatbox`                           |
| BoltAI             | m         | boltai.com                                | BoltAI (cask)                  | —                                     | —                      | `boltai`                            |
| Cherry Studio      | m/w/l     | cherry-studio cask                        | Cherry Studio (cask)           | Cherry Studio.exe                     | cherry-studio          | `cherry studio`, `cherry-studio`    |
| AnythingLLM        | m/w/l     | Mintplex-Labs releases                    | AnythingLLM (cask)             | AnythingLLMDesktop.exe (unverified)   | unverified             | `anythingllm`, `anythingllmdesktop` |
| Witsy              | m/w/l     | witsy cask                                | Witsy (cask)                   | Witsy.exe (unverified)                | unverified             | `witsy`                             |
| GPT4All            | m/w/l     | nomic-ai/gpt4all                          | GPT4All (unverified)           | gpt4all.exe or chat.exe (conflicting) | unverified             | `gpt4all`                           |

### A6. Code editors and IDEs

| App                                                          | Platforms | macOS `.app` / executable                                                 | Windows exe                                             | Linux WM_CLASS                      | Tokens                                                                                |
| ------------------------------------------------------------ | --------- | ------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| Visual Studio Code (+Insiders)                               | m/w/l     | Visual Studio Code / Code (inspected); Insiders unverified                | Code.exe; Code - Insiders.exe                           | Code; code-insiders                 | `visual studio code`, `code`                                                          |
| VSCodium                                                     | m/w/l     | VSCodium / Electron (unverified)                                          | VSCodium.exe (unverified)                               | codium; VSCodium                    | `vscodium`, `codium`                                                                  |
| Cursor                                                       | m/w/l     | Cursor / Cursor                                                           | Cursor.exe                                              | Cursor (xprop-confirmed)            | `cursor`                                                                              |
| Windsurf → Devin Desktop                                     | m/w/l     | Windsurf / Electron; Devin (unverified, rebrand 2026-06)                  | Windsurf.exe; Devin.exe                                 | Windsurf; Devin                     | `windsurf`, `devin`                                                                   |
| Zed                                                          | m/w/l     | Zed (cask)                                                                | zed.exe (unverified)                                    | dev.zed.Zed                         | `zed`                                                                                 |
| Trae, Kiro, Void, Positron                                   | m/w/l     | Trae, Kiro, Void, Positron (.app; exec unverified)                        | Trae.exe, Kiro.exe, Void.exe, Positron.exe (unverified) | trae, kiro, void, co.posit.positron | `trae`, `kiro`, `void`, `positron`                                                    |
| Antigravity                                                  | m/w/l     | Antigravity / Antigravity and Antigravity IDE / Electron (both inspected) | Antigravity-x64.exe                                     | Antigravity (unverified)            | `antigravity`                                                                         |
| PearAI, Aide                                                 | m/w/l     | PearAI, Aide (stale projects)                                             | PearAI.exe, Aide.exe (unverified)                       | pearai, aide (unverified)           | `pearai`, `aide`                                                                      |
| IntelliJ IDEA (Ultimate, CE)                                 | m/w/l     | IntelliJ IDEA / idea; IntelliJ IDEA CE / idea                             | idea64.exe                                              | jetbrains-idea                      | `intellij`, `idea`, `idea64`, `jetbrains`                                             |
| PyCharm (+CE)                                                | m/w/l     | PyCharm / pycharm                                                         | pycharm64.exe                                           | jetbrains-pycharm(-ce)              | `pycharm`                                                                             |
| WebStorm, PhpStorm, Rider, GoLand, CLion, RubyMine, DataGrip | m/w/l     | `<Name>.app` / lowercase name                                             | `<name>64.exe`                                          | jetbrains-`<name>`                  | `webstorm`, `phpstorm`, `rider`, `rider64`, `goland`, `clion`, `rubymine`, `datagrip` |
| Android Studio                                               | m/w/l     | Android Studio / studio                                                   | studio64.exe                                            | jetbrains-studio (unverified)       | `android studio`, `studio64`                                                          |
| Sublime Text                                                 | m/w/l     | Sublime Text / sublime_text                                               | sublime_text.exe                                        | subl; Sublime_text                  | `sublime`, `sublime_text`, `subl`                                                     |
| Nova, BBEdit, CotEditor                                      | m         | Nova, BBEdit, CotEditor (casks; exec unverified)                          | —                                                       | —                                   | `nova`, `bbedit`, `coteditor`                                                         |
| Notepad++                                                    | w         | —                                                                         | notepad++.exe (winget)                                  | —                                   | `notepad++`                                                                           |
| Kate (KDE)                                                   | m/w/l     | kate / kate (cask)                                                        | kate.exe (unverified)                                   | org.kde.kate; kate                  | `kate`                                                                                |
| Emacs (GUI)                                                  | m/w/l     | Emacs / Emacs (cask)                                                      | emacs.exe, runemacs.exe                                 | Emacs                               | `emacs`, `runemacs`                                                                   |
| MacVim / gVim / Neovide                                      | m/w/l     | MacVim / MacVim; Neovide / neovide                                        | gvim.exe; neovide.exe                                   | gvim; neovide                       | `macvim`, `gvim`, `neovide`                                                           |
| Visual Studio                                                | w         | —                                                                         | devenv.exe                                              | —                                   | `devenv`                                                                              |

## Appendix B — deliberately excluded, and why

| App                                                                                                            | Reason                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Notes, Word, TextEdit, Pages, Mail                                                                       | Show literal `**` and `#`. TextEdit is the reproduction case.                                                                                                                                       |
| Microsoft OneNote                                                                                              | No markdown parsing in any version (unmarkdown.com/blog/onenote-markdown).                                                                                                                          |
| Slack                                                                                                          | Own dialect: `*bold*`, no headings; the composer's conversion is a typing rule ("add an asterisk and press the spacebar") that does not fire on paste (slack.com/help 202288908, 360039953113).     |
| Microsoft Teams                                                                                                | "Markdown-style" dialect with single-asterisk bold, rendered as a live preview while typing; vendor and community tests report paste is not parsed (support.microsoft.com use-markdown-formatting). |
| WhatsApp Desktop                                                                                               | Own dialect (`*bold*`, `_italic_`, bullets since 2024); `**bold**` and `#` are garbage.                                                                                                             |
| Telegram Desktop                                                                                               | Converts inline emphasis only; `#` headings and list markers stay literal.                                                                                                                          |
| Signal                                                                                                         | No markdown by design.                                                                                                                                                                              |
| Google Chat                                                                                                    | Own dialect and PWA-only (no distinct process).                                                                                                                                                     |
| Asana, ClickUp, Basecamp, Monday, Things 3                                                                     | Markdown shortcuts fire while typing, not on paste (Asana, ClickUp — ClickUp turns pasted markdown into a code block); Trix rich text (Basecamp); rich or plain text only (Monday, Things).         |
| UpNote                                                                                                         | Plain ⌘V does not convert; conversion needs the separate "Paste from Markdown" command (help.getupnote.com).                                                                                        |
| Amplenote                                                                                                      | Vendor forum: "When you take markdown text and paste it into Amplenote, it just stays plain text."                                                                                                  |
| Trilium / TriliumNext                                                                                          | Default note type is CKEditor rich text; raw markdown is a separate opt-in note type.                                                                                                               |
| Zim Wiki, Cherrytree                                                                                           | Own wiki dialect (Zim); default node is rich text (Cherrytree).                                                                                                                                     |
| Xcode                                                                                                          | An IDE for Swift and C where literal markdown is garbage outside a `.md` file; explicitly vetoed so `code` cannot match it.                                                                         |
| Notepad, TextEdit                                                                                              | General-purpose plain-text editors used for prose by non-developers.                                                                                                                                |
| Raycast, Alfred                                                                                                | The main surface is a launcher search field, not a prose or prompt box.                                                                                                                             |
| Marked 2, Panda, Google Keep, Coda, SilverBullet, Open WebUI, TypingMind, Jira, Confluence, GitLab             | Previewer with no editable pane; browser prototype; web or PWA only with no process identity of their own (browser follow-up).                                                                      |
| Cline, Roo Code, Continue, Foam, Dendron                                                                       | Live inside VS Code and carry its identity; VS Code is listed.                                                                                                                                      |
| Grok, Le Chat (Mistral)                                                                                        | No official desktop app as of 2026-09; only third-party wrappers with unstable names.                                                                                                               |
| Quiver, Haroopad, Turtl, Atom, JetBrains Fleet, Skype, Height, Sourcegraph Cody app, Windsurf legacy name kept | Abandoned or discontinued (Fleet 2025-12, Skype 2025-05, Height 2025-09). Windsurf's old name is kept alongside Devin.                                                                              |
| reMarkable-named editor                                                                                        | The Linux "Remarkable" markdown editor is omitted because the token would match the reMarkable tablet's desktop app.                                                                                |

## Appendix C — hand-test before adding

Behaviour mixed, undocumented or contested. Each needs one real paste on an
installed copy before it goes on the list.

- **Tana** (`Tana Outliner.app`): "Tana Paste" is a markdown-like dialect;
  vanilla markdown converts only partially.
- **AFFiNE** (`AFFiNE.app`): converts, but open bugs collapse structured
  documents on paste (AFFiNE#12313).
- **Standard Notes** (`Standard Notes.app`, Flatpak `org.standardnotes.standardnotes`):
  behaviour depends on the note type (Plain is raw, Super is rich text); two
  research passes disagreed on the default.
- **Agenda** (`Agenda.app`): markdown shortcuts documented for typing only.
- **Mem, Slite, FuseBase/Nimbus, Saga, Twos**: typing shortcuts documented,
  paste behaviour not.
- **Zed on Windows, Claude for Windows**: identities changed recently (Zed
  Windows preview; Claude moved to MSIX in 2026-02); confirm the exe names.
- **Any MAS-only app** (Bear, iA Writer, Ulysses, NotePlan, Drafts, Byword):
  `.app` names follow convention and are unverified; a wrong name only means
  plain text, but a check on an installed copy would close the gap.
