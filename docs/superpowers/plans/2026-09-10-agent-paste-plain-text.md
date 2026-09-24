# Agent answers paste as plain text — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A voice-command answer pasted at the caret arrives as plain prose in a plain-text app, as untouched markdown in a markdown-friendly app, and every declined paste leaves one diagnosable line in the debug log.

**Architecture:** The main process decides once, at caret capture, whether the target app accepts markdown (a researched allowlist in `markdownTargets.js`, matched on the identity the platform already exposes) and returns `acceptsMarkdown` with the session id. The renderer carries that verdict into the delivery object as `plainText`. When `plainText` is true a per-request suffix asks the model for prose and `markdownToPlainText` strips whatever slips through before the paste; when false both are skipped. `pasteAtCapturedTarget` logs each refusal code with the probe verdict.

**Tech Stack:** Electron desktop app; TypeScript renderer, CommonJS main process; tests are `node --test` files under `test/` that dynamically import `.ts` through `tsx`; Prettier + ESLint.

**Spec:** `docs/superpowers/specs/2026-09-10-agent-paste-plain-text-design.md` — read it first; every decision below argues from it, and Appendix A is the source of the allowlist.

## Global Constraints

- Branch `fix/agent-paste-plain-text`, based on `origin/main` at `a2c76ef9`. Work in a scratchpad worktree, never by switching branches in the shared `~/dev/openwhispr-desktop` clone.
- **Never merge.** Open the PR, stop. (Josh's standing rule.)
- **Do not edit `DEFAULT_CHAT_AGENT_PROMPT`** in `src/config/prompts/registry.ts`, and do not touch `src/config/retiredPrompts.js`. The instruction is a conditional suffix; the hash protocol is deliberately not triggered.
- **Do not reuse or "generalise" `stripMarkdownPreview`** in `src/components/CommandSearch.tsx`. It collapses newlines into spaces.
- **Do not touch PR #1952** or anything under the Chromium/Electron paste probe. Independent defect.
- **No rich-text clipboard work, no browser-tab (window title) detection, no user setting.** All three are scoped out in the spec.
- **Plain text is the default.** Any error, unreadable pid or unlisted app yields `acceptsMarkdown: false`.
- **Allowlist entries are lowercase, at least three characters, and never a generic word that another app could carry.** `riot` and `remarkable` are deliberately absent (spec §3). Matching is whole-token or whole-phrase, never bare substring.
- Run the suite with `nvm exec 24 npm test` — Node 25 (the shell default) fakes one unrelated failure. About 169 Electron-ABI skips are normal locally.
- The worktree's `node_modules` is a symlink to the clone's. It is excluded via `.git/info/exclude`, but still confirm `git status --short` never lists it before every commit.
- Commit messages: conventional commits, and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Before every commit: `npx prettier --write <touched files>`, then `npx eslint <touched files>` from the repo root for `test/**` and TSX/TS renderer files. **`src/helpers/*.js` and `src/utils/**` are linted by neither config** (the root config ignores `src/**`, and `src/eslint.config.js` ignores `helpers/**` and `utils/**`), so ESLint reports them as ignored; Prettier, the tests and `npm run typecheck` are the gate for those. The overall gate is `npm run quality-check` in Task 9.

---

## File map

| File                                                           | Responsibility                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/helpers/markdownToPlainText.ts` (create)                  | Pure function: markdown → plain text, every line break preserved                 |
| `test/helpers/markdownToPlainText.test.js` (create)            | One test per strip rule, plus the must-not-alter cases                           |
| `src/helpers/markdownTargets.js` (create)                      | The allowlist, the vetoes, and `isMarkdownTargetSignature`                       |
| `test/helpers/markdownTargets.test.js` (create)                | Every platform identity shape matches; plain-text apps and vetoes never do       |
| `src/helpers/selectionManager.js` (modify)                     | Resolve the verdict at capture; store it on the session; log every paste refusal |
| `src/types/electron.ts` (modify)                               | `acceptsMarkdown` on the `editable` capture result                               |
| `test/helpers/selectionManager.test.js` (modify)               | Logger stub; verdict tests; one test per refusal code                            |
| `src/helpers/audioManager.js` (modify)                         | Carry `deliveryAcceptsMarkdown` next to `deliverySessionId`                      |
| `test/helpers/audioManagerAssistantDirective.test.js` (modify) | The verdict rides into `pendingAssistantConversation`                            |
| `src/hooks/useAudioRecording.js` (modify)                      | Pass the verdict into `createAssistantResponseDelivery`                          |
| `src/helpers/assistantResponseDelivery.ts` (modify)            | `plainText` on the paste delivery; strip only when it is true                    |
| `test/helpers/assistantResponseDelivery.test.js` (modify)      | `plainText` derivation; stripped vs verbatim per delivery                        |
| `src/config/prompts/registry.ts` (modify)                      | `PLAIN_TEXT_RESPONSE_SUFFIX` constant beside the chat-agent prompt               |
| `src/config/prompts/index.ts` (modify)                         | `appendPlainTextResponseSuffix(prompt)` beside the other suffix helpers          |
| `src/config/prompts.ts` (modify)                               | Re-export the new helper                                                         |
| `test/helpers/agentPlainTextSuffix.test.js` (create)           | Suffix appends once at the end; panel prompt never carries it                    |
| `src/components/chat/useChatStreaming.ts` (modify)             | `plainTextResponse` option; append the suffix last                               |
| `src/components/dictation/AssistantPanel.tsx` (modify)         | Pass `plainTextResponse` from `delivery.plainText`                               |

---

### Task 1: the newline-preserving strip helper

**Files:**

- Create: `src/helpers/markdownToPlainText.ts`
- Test: `test/helpers/markdownToPlainText.test.js`

**Interfaces:**

- Produces: `export function markdownToPlainText(markdown: string): string` — pure, synchronous, never throws on any string input.

This task's code was executed as a throwaway check on 2026-09-10 under Node 24: 11/11 pass, Prettier and ESLint clean. Copy it as written.

- [ ] **Step 1: Write the failing tests**

Create `test/helpers/markdownToPlainText.test.js`:

````js
const test = require("node:test");
const assert = require("node:assert/strict");

const helperModule = import("../../src/helpers/markdownToPlainText.ts");

// Every case pins one rule from the spec's table. The first test is the one
// that matters most: it is exactly what the search-preview helper in
// CommandSearch.tsx would fail, because it collapses newlines into spaces.
test("paragraphs, blank lines and line breaks survive untouched", async () => {
  const { markdownToPlainText } = await helperModule;
  const answer = "First paragraph.\n\nSecond paragraph,\nwrapped onto a second line.";
  assert.equal(markdownToPlainText(answer), answer);
});

test("emphasis markers are removed and the words kept", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(
    markdownToPlainText("**bold** and *em* and __b__ and _e_ and ~~s~~"),
    "bold and em and b and e and s"
  );
  assert.equal(markdownToPlainText("**x**"), "x");
});

test("headings lose their marks", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(markdownToPlainText("## Title\nBody"), "Title\nBody");
});

test("inline code and fenced blocks keep their content verbatim", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(
    markdownToPlainText("Run `npm test`.\n```bash\nnpm test\n```\nDone."),
    "Run npm test.\nnpm test\nDone."
  );
  assert.equal(markdownToPlainText("```\n**not bold**\n```"), "**not bold**");
});

test("links keep their text and their url; images keep their alt text", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(
    markdownToPlainText("see [the docs](https://x.y/d)"),
    "see the docs (https://x.y/d)"
  );
  assert.equal(markdownToPlainText("[https://x.y](https://x.y)"), "https://x.y");
  assert.equal(markdownToPlainText("![a chart](chart.png)"), "a chart");
});

test("star and plus bullets become dashes; dashes and numbers stay as typed", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(
    markdownToPlainText("* one\n+ two\n- three\n1. four"),
    "- one\n- two\n- three\n1. four"
  );
});

test("blockquote markers are removed at line start only", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(markdownToPlainText("> quoted\n>> nested\nx > y"), "quoted\nnested\nx > y");
});

test("horizontal rules are removed", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(markdownToPlainText("a\n---\nb\n* * *\nc"), "a\nb\nc");
});

test("tables become tab-separated rows without the alignment row", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(
    markdownToPlainText("| Name | Qty |\n|---|---:|\n| Apples | **3** |"),
    "Name\tQty\nApples\t3"
  );
});

test("markdown escapes resolve to the escaped character", async () => {
  const { markdownToPlainText } = await helperModule;
  assert.equal(markdownToPlainText("\\*literal\\* and 5 \\_ 6"), "*literal* and 5 _ 6");
  assert.equal(markdownToPlainText("\\*\\*kept\\*\\*"), "**kept**");
});

test("plain-text conventions a human would type are never altered", async () => {
  const { markdownToPlainText } = await helperModule;
  const answer = "2 * 3 * 4 = 24\nsnake_case_name stays\na lone * star\n#hashtag\nx > y";
  assert.equal(markdownToPlainText(answer), answer);
});
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm exec 24 node --import tsx --test test/helpers/markdownToPlainText.test.js`
Expected: every test FAILS with `Cannot find module '../../src/helpers/markdownToPlainText.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/helpers/markdownToPlainText.ts`:

```ts
// Turns a model answer into text that is safe to paste into a plain-text
// field. Every line break is preserved: paragraphs, blank lines and list
// lines survive. This is deliberately NOT stripMarkdownPreview from
// CommandSearch.tsx — that helper collapses newlines into spaces to feed
// one-line search previews and would flatten a multi-paragraph answer.
//
// The rules only touch syntax a human would not type in plain text. A `- `
// bullet, a `1.` number, `2 * 3`, snake_case, `#hashtag` and `x > y` are all
// left exactly as written.

const FENCE_LINE = /^\s*(`{3,}|~{3,}).*$/;
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_ALIGNMENT_CELL = /^:?-+:?$/;

function stripInline(text: string): string {
  return (
    text
      .replace(/(?<!\\)`([^`]+)`/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label: string, url: string) =>
        label === url ? url : `${label} (${url})`
      )
      .replace(/(?<!\\)(\*\*|__)(\S(?:.*?\S)?)\1/g, "$2")
      .replace(/(?<!\\)~~(\S(?:.*?\S)?)~~/g, "$1")
      // Markers must hug non-space on the inside, not sit inside a word on the
      // outside, and not be escaped — so `2 * 3`, snake_case and `\*` survive.
      .replace(/(?<![\w*\\])\*(\S(?:.*?\S)?)\*(?![\w*])/g, "$1")
      .replace(/(?<![\w_\\])_(\S(?:.*?\S)?)_(?![\w_])/g, "$1")
      // Escapes resolve last so an escaped marker is never re-stripped.
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
  );
}

export function markdownToPlainText(markdown: string): string {
  const lines: string[] = [];
  let inFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      lines.push(line);
      continue;
    }
    if (HORIZONTAL_RULE.test(line)) continue;

    if (TABLE_ROW.test(line)) {
      const cells = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      if (cells.every((cell) => TABLE_ALIGNMENT_CELL.test(cell))) continue;
      lines.push(cells.map(stripInline).join("\t"));
      continue;
    }

    const block = line
      .replace(/^(\s{0,3}>\s?)+/, "")
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^(\s*)[*+]\s+/, "$1- ");
    lines.push(stripInline(block));
  }

  return lines
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nvm exec 24 node --import tsx --test test/helpers/markdownToPlainText.test.js`
Expected: 11 tests PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write src/helpers/markdownToPlainText.ts test/helpers/markdownToPlainText.test.js
npx eslint src/helpers/markdownToPlainText.ts
npx eslint test/helpers/markdownToPlainText.test.js
git status --short   # must list only the two files, never node_modules
git add src/helpers/markdownToPlainText.ts test/helpers/markdownToPlainText.test.js
git commit -m "feat(assistant): newline-preserving markdown-to-plain-text helper

Pure helper for text that is about to be pasted into a plain-text app.
Keeps every line break, which is why stripMarkdownPreview (search
previews, collapses newlines) is not reused.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: the markdown-friendly target list

**Files:**

- Create: `src/helpers/markdownTargets.js`
- Test: `test/helpers/markdownTargets.test.js`

**Interfaces:**

- Produces (CommonJS): `MARKDOWN_TARGET_SIGNATURES: string[]`, `MARKDOWN_TARGET_VETOES: string[]`, `isMarkdownTargetSignature(signature: string | null | undefined): boolean`. Task 3 requires this module from `selectionManager.js`.

The list is the spec's Appendix A, tokens column. Do not add an entry that is not in Appendix A; if research turns up a new app, add it to the spec's appendix first with its evidence.

- [ ] **Step 1: Write the failing tests**

Create `test/helpers/markdownTargets.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isMarkdownTargetSignature,
  MARKDOWN_TARGET_SIGNATURES,
} = require("../../src/helpers/markdownTargets");

// Each signature below is the exact shape one platform hands the matcher:
// macOS "<.app folder name> <executable>", Windows "<exe> <window class>",
// Linux "<WM_CLASS>". One representative per group of the spec's Appendix A.
test("markdown-friendly apps match on every platform's identity shape", () => {
  for (const signature of [
    "Obsidian Obsidian", // macOS, resolved from the pid
    "Visual Studio Code Code", // macOS: .app name and executable differ
    "IntelliJ IDEA idea", // macOS JetBrains
    "ChatGPT ChatGPT", // macOS AI prompt box
    "Google Gemini Gemini", // macOS, Chromium-path app name plus executable
    "Notion Notion",
    "Discord Discord",
    "Linear Linear",
    "Obsidian.exe Chrome_WidgetWin_1", // Windows exe + Electron window class
    "Code.exe Chrome_WidgetWin_1",
    "idea64.exe SunAwtFrame",
    "notepad++.exe Notepad++",
    "M365Copilot.exe",
    "md.obsidian.obsidian", // Linux Flatpak WM_CLASS
    "net.cozic.joplin_desktop",
    "jetbrains-idea",
    "dev.zed.zed",
    "code",
    "org.kde.kate",
  ]) {
    assert.equal(isMarkdownTargetSignature(signature), true, signature);
  }
});

test("plain-text apps, own-dialect chat tools, browsers and near-miss names never match", () => {
  for (const signature of [
    "TextEdit TextEdit",
    "Notes Notes",
    "Microsoft Word Microsoft Word",
    "Pages Pages",
    "Mail Mail",
    "WINWORD.EXE",
    "notepad.exe Notepad",
    "gedit",
    "Slack Slack",
    "Microsoft Teams MSTeams",
    "ms-teams.exe",
    "WhatsApp WhatsApp",
    "Telegram Telegram",
    "Xcode Xcode", // "code" must not match inside Xcode
    "Notion Calendar Notion Calendar", // veto
    "Notion Mail Notion Mail", // veto
    "Google Chrome Google Chrome",
    "Safari Safari",
    "Arc Arc",
    "Riot Client RiotClientUx.exe", // the reason "riot" is not an entry
    "reMarkable reMarkable", // the reason "remarkable" is not an entry
    "",
    null,
    undefined,
  ]) {
    assert.equal(isMarkdownTargetSignature(signature), false, String(signature));
  }
});

test("every entry is lowercase, at least three characters, and free of generic tokens", () => {
  for (const entry of MARKDOWN_TARGET_SIGNATURES) {
    assert.equal(entry, entry.toLowerCase(), entry);
    assert.ok(entry.length >= 3, entry);
  }
  for (const banned of ["riot", "remarkable", "notes", "mail", "word", "text", "app"]) {
    assert.ok(!MARKDOWN_TARGET_SIGNATURES.includes(banned), banned);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm exec 24 node --test test/helpers/markdownTargets.test.js`
Expected: FAIL with `Cannot find module '../../src/helpers/markdownTargets'`.

- [ ] **Step 3: Write the list and the matcher**

Create `src/helpers/markdownTargets.js`:

```js
// Apps whose text surface wants markdown left alone: markdown-native editors,
// apps that convert pasted markdown into formatting, chat tools whose composer
// is standard markdown, AI prompt boxes (a model reads markdown happily) and
// code editors / IDEs (nothing renders formatting there, and a developer's
// backticks and fences are deliberate). Anything not listed gets plain text —
// the safe default, because a wrong verdict here pastes literal asterisks
// into someone's document.
//
// Matching is by whole token or phrase, never bare substring, so "code" does
// not match "Xcode". Entries are lowercase and never a generic word another
// app could carry: "riot" (Element's Flatpak id) would match the Riot Games
// launcher and "remarkable" (a small Linux editor) the reMarkable tablet app,
// so neither is here. The identity matched per platform:
//   macOS   — the .app folder name + executable resolved from the pid
//             ("Visual Studio Code Code"), plus the copy helper's app name
//   Windows — the exe name ("Code.exe", "idea64.exe") + window class
//   Linux   — the WM_CLASS ("code", "md.obsidian.obsidian", "jetbrains-idea")
// Evidence per app, and the apps deliberately excluded:
// docs/superpowers/specs/2026-09-10-agent-paste-plain-text-design.md, Appendix A–C.

const MARKDOWN_TARGET_SIGNATURES = [
  // Markdown-native note editors — the file is markdown.
  "obsidian",
  "typora",
  "logseq",
  "joplin",
  "zettlr",
  "ia writer",
  "ulysses",
  "simplenote",
  "inkdrop",
  "marktext",
  "noteplan",
  "drafts",
  "macdown",
  "markedit",
  "nota",
  "byword",
  "fsnotes",
  "the archive",
  "qownnotes",
  "boost note",
  "boostnote",
  "notable",
  "supernotes",
  "heynote",
  "apostrophe",
  "ghostwriter",
  "abricotine",
  // Apps that convert pasted markdown into formatting (vendor-documented).
  "notion",
  "evernote",
  "notesnook",
  "workflowy",
  "bear",
  "craft",
  "remnote",
  "anytype",
  "siyuan",
  "capacities",
  "reflect",
  "heptabase",
  "roam",
  "appflowy",
  // Chat composers that are standard markdown (not Slack, Teams, WhatsApp or
  // Telegram — their dialects turn **bold** into stray asterisks).
  "discord",
  "zulip",
  "mattermost",
  "element",
  "rocket.chat",
  "rocketchat",
  // Work tools whose long-text fields convert pasted markdown.
  "linear",
  "todoist",
  "ticktick",
  "trello",
  // AI prompt boxes — the model reads markdown.
  "chatgpt",
  "claude",
  "gemini",
  "perplexity",
  "copilot",
  "m365copilot",
  "poe",
  "lm studio",
  "lm-studio",
  "ollama",
  "jan",
  "msty",
  "chatbox",
  "boltai",
  "cherry studio",
  "cherry-studio",
  "anythingllm",
  "anythingllmdesktop",
  "witsy",
  "gpt4all",
  // Code editors and IDEs — nothing renders formatting; the AI chat panels
  // inside them are prompt boxes. Not general prose editors (TextEdit,
  // Notepad, gedit): those are the plain-text case.
  "visual studio code",
  "code",
  "vscodium",
  "codium",
  "cursor",
  "windsurf",
  "devin",
  "zed",
  "trae",
  "kiro",
  "antigravity",
  "void",
  "positron",
  "pearai",
  "aide",
  "intellij",
  "idea",
  "idea64",
  "pycharm",
  "webstorm",
  "phpstorm",
  "rider",
  "rider64",
  "goland",
  "clion",
  "rubymine",
  "datagrip",
  "android studio",
  "studio64",
  "jetbrains",
  "sublime",
  "sublime_text",
  "subl",
  "nova",
  "bbedit",
  "coteditor",
  "kate",
  "notepad++",
  "emacs",
  "runemacs",
  "macvim",
  "gvim",
  "neovide",
  "devenv",
];

// Checked first, as plain substrings. An app that carries a listed name but
// is not a markdown surface — the veto wins.
const MARKDOWN_TARGET_VETOES = ["notion calendar", "notion mail", "xcode"];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whole-token / whole-phrase match: the entry must be bounded on both sides by
// the start or end of the signature or by a character that is not a letter or
// digit. Dots, hyphens, underscores and spaces all count as boundaries, which
// is what makes "md.obsidian.obsidian", "jetbrains-idea" and "Code.exe" match
// while "Xcode" does not.
const TOKEN_PATTERNS = MARKDOWN_TARGET_SIGNATURES.map(
  (entry) => new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(entry)}(?:$|[^a-z0-9])`)
);

function isMarkdownTargetSignature(signature) {
  if (!signature) return false;
  const normalized = String(signature).toLowerCase();
  if (MARKDOWN_TARGET_VETOES.some((veto) => normalized.includes(veto))) return false;
  return TOKEN_PATTERNS.some((pattern) => pattern.test(normalized));
}

module.exports = {
  MARKDOWN_TARGET_SIGNATURES,
  MARKDOWN_TARGET_VETOES,
  isMarkdownTargetSignature,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nvm exec 24 node --test test/helpers/markdownTargets.test.js`
Expected: 3 tests PASS. If a "never match" case fails, the fix is to remove or narrow the offending entry, never to loosen the test.

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write src/helpers/markdownTargets.js test/helpers/markdownTargets.test.js
npx eslint src/helpers/markdownTargets.js test/helpers/markdownTargets.test.js
git status --short
git add src/helpers/markdownTargets.js test/helpers/markdownTargets.test.js
git commit -m "feat(assistant): allowlist of apps whose caret keeps markdown

Markdown-native editors, markdown-converting note apps, standard-markdown
chat composers, AI prompt boxes and code editors, matched by whole token
on the identity each platform already exposes. Plain text stays the
default for everything else. Evidence per app lives in the design spec.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: decide the verdict at capture, in the main process

**Files:**

- Modify: `src/helpers/selectionManager.js` (require at line 3; `captureSelectedText` editable branch, lines 176–183; `_isTerminalPid`, lines 516–525; new methods beside it)
- Modify: `src/types/electron.ts` (the `captureSelectedText` return type, lines 1116–1132)
- Test: `test/helpers/selectionManager.test.js`

**Interfaces:**

- Consumes: `isMarkdownTargetSignature` from Task 2.
- Produces: the `editable` capture result becomes `{ status: "editable", sessionId, acceptsMarkdown: boolean }`; the caret session object gains `acceptsMarkdown`; new methods `_readTargetNames(pid): Promise<string>` and `_targetAcceptsMarkdown(target): Promise<boolean>`. Task 4 reads `acceptsMarkdown` off the capture result; Task 8 reads it off the session.

- [ ] **Step 1: Write the failing tests**

Append to `test/helpers/selectionManager.test.js` (reuse its `makeHarness`, `SelectionManager` and `loadSelectionManager`):

```js
test("a caret in a markdown-native macOS app is reported as accepting markdown", async () => {
  const { manager } = makeHarness({ selections: [{ state: "none", editable: true }] });
  manager._readExecutablePath = async () => "/Applications/Obsidian.app/Contents/MacOS/Obsidian";

  const result = await manager.captureSelectedText({ probeEditable: true });

  assert.equal(result.status, "editable");
  assert.equal(result.acceptsMarkdown, true);
  assert.equal(manager.sessions.get(result.sessionId).acceptsMarkdown, true);
});

test("a caret in a plain-text macOS app is reported as wanting plain text", async () => {
  const { manager } = makeHarness({ selections: [{ state: "none", editable: true }] });
  manager._readExecutablePath = async () =>
    "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit";

  const result = await manager.captureSelectedText({ probeEditable: true });

  assert.equal(result.status, "editable");
  assert.equal(result.acceptsMarkdown, false);
  assert.equal(manager.sessions.get(result.sessionId).acceptsMarkdown, false);
});

test("an unreadable pid defaults the caret to plain text", async () => {
  const { manager } = makeHarness({ selections: [{ state: "none", editable: true }] });
  manager._readExecutablePath = async () => "";

  const result = await manager.captureSelectedText({ probeEditable: true });

  assert.equal(result.status, "editable");
  assert.equal(result.acceptsMarkdown, false);
});

test("Windows and Linux caret targets are judged by the identity they already carry", async () => {
  const { manager } = makeHarness();
  manager._readExecutablePath = async () => {
    throw new Error("must not spawn ps for a target that names its app");
  };

  assert.equal(
    await manager._targetAcceptsMarkdown({
      kind: "win-hwnd",
      id: "00001A2B",
      exeName: "Obsidian.exe",
      windowClass: "Chrome_WidgetWin_1",
    }),
    true
  );
  assert.equal(
    await manager._targetAcceptsMarkdown({
      kind: "win-hwnd",
      id: "00001A2B",
      exeName: "WINWORD.EXE",
    }),
    false
  );
  assert.equal(
    await manager._targetAcceptsMarkdown({
      kind: "x11-window",
      id: "0x1",
      windowClass: "md.obsidian.obsidian",
    }),
    true
  );
  assert.equal(await manager._targetAcceptsMarkdown(null), false);
});

test("a Linux AT-SPI target resolves its executable like the terminal check does", async () => {
  const { manager } = makeHarness();
  manager._readExecutablePath = async (pid) => (pid === 77 ? "obsidian" : "");

  assert.equal(await manager._targetAcceptsMarkdown({ kind: "atspi-pid", id: 77 }), true);
  assert.equal(await manager._targetAcceptsMarkdown({ kind: "atspi-pid", id: 78 }), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm exec 24 node --import tsx --test test/helpers/selectionManager.test.js`
Expected: the five new tests FAIL (`result.acceptsMarkdown` is `undefined`; `_targetAcceptsMarkdown is not a function`). Every pre-existing test still PASSES.

- [ ] **Step 3: Resolve and store the verdict**

In `src/helpers/selectionManager.js`, add the require after the existing `debugLogger` require:

```js
const { isMarkdownTargetSignature } = require("./markdownTargets");
```

Replace the editable branch inside `captureSelectedText` (currently):

```js
if (capture.status === "editable") {
  const sessionId = crypto.randomUUID();
  this.sessions.set(sessionId, {
    kind: "caret",
    target: capture.target,
    expiresAt: this.now() + SESSION_TTL_MS,
  });
  return { status: "editable", sessionId };
}
```

with:

```js
if (capture.status === "editable") {
  const sessionId = crypto.randomUUID();
  // Decided once, here, and carried on both the session and the result:
  // the renderer asks the model for plain prose and strips markdown only
  // when the target is not a markdown-friendly app.
  const acceptsMarkdown = await this._targetAcceptsMarkdown(capture.target);
  this.sessions.set(sessionId, {
    kind: "caret",
    target: capture.target,
    acceptsMarkdown,
    expiresAt: this.now() + SESSION_TTL_MS,
  });
  return { status: "editable", sessionId, acceptsMarkdown };
}
```

Replace `_isTerminalPid` (currently lines 516–525) with the three methods below. The first is the existing method with its path parsing moved into `_readTargetNames`; the behaviour is unchanged.

```js
  async _isTerminalPid(pid) {
    if (!this.clipboardManager.isTerminalSignature) return false;
    const names = await this._readTargetNames(pid);
    return names ? this.clipboardManager.isTerminalSignature(names) : false;
  }

  // "<bundle name> <executable name>" for a pid — "Visual Studio Code Code" on
  // macOS, the bare comm name on Linux — or "" when the pid cannot be read.
  async _readTargetNames(pid) {
    const executablePath = await this._readExecutablePath(pid);
    if (!executablePath) return "";
    // Match the bundle and executable names, not the whole path — segments
    // like "/System/" would collide with short signatures such as "st".
    const bundleName = executablePath.match(/\/([^/]+)\.app\//)?.[1] ?? "";
    const executableName = executablePath.split("/").pop() ?? "";
    return `${bundleName} ${executableName}`.trim();
  }

  // Windows and Linux X11 targets name their app on the target; macOS AX and
  // Linux AT-SPI targets carry only a pid, so resolve the executable exactly
  // as the terminal check does. A miss or an error means plain text.
  async _targetAcceptsMarkdown(target) {
    if (!target) return false;
    try {
      const parts = [this._targetSignature(target)];
      const pid = target.kind === "mac-pid" ? target.pid : target.kind === "atspi-pid" ? target.id : null;
      if (pid) parts.push(await this._readTargetNames(pid));
      return isMarkdownTargetSignature(parts.join(" ").trim());
    } catch {
      return false;
    }
  }
```

- [ ] **Step 4: Type the new field**

In `src/types/electron.ts`, change the `editable` variant of the `captureSelectedText` return type from:

```ts
        | {
            status: "editable";
            sessionId: string;
          }
```

to:

```ts
        | {
            status: "editable";
            sessionId: string;
            /** True when the captured app keeps markdown (spec Appendix A); false means plain text. */
            acceptsMarkdown: boolean;
          }
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `nvm exec 24 node --import tsx --test test/helpers/selectionManager.test.js && nvm exec 24 npm run typecheck`
Expected: all tests PASS, including the five new ones; typecheck exits 0.

- [ ] **Step 6: Format, lint, commit**

```bash
npx prettier --write src/helpers/selectionManager.js src/types/electron.ts test/helpers/selectionManager.test.js
npx eslint src/helpers/selectionManager.js test/helpers/selectionManager.test.js
(cd src && npx eslint types/electron.ts)
git status --short
git add src/helpers/selectionManager.js src/types/electron.ts test/helpers/selectionManager.test.js
git commit -m "feat(assistant): decide at caret capture whether the target keeps markdown

captureSelectedText resolves the app under the caret against the
markdown-target list once, stores the verdict on the session and returns
it as acceptsMarkdown. macOS and AT-SPI pids resolve through the same
executable lookup the terminal check uses; Windows and X11 targets are
judged by the exe name and window class they already carry.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: carry the verdict to the delivery object

**Files:**

- Modify: `src/helpers/audioManager.js` (`_bankAssistantDirective` lines 2585–2600; `_bankPanelAgentCommand` lines 2618–2635; `processAgentCommand` lines 2665–2700)
- Modify: `src/hooks/useAudioRecording.js` (lines 504–531)
- Modify: `src/helpers/assistantResponseDelivery.ts` (the `AssistantResponseDelivery` type and `createAssistantResponseDelivery`)
- Test: `test/helpers/audioManagerAssistantDirective.test.js`, `test/helpers/assistantResponseDelivery.test.js`

**Interfaces:**

- Consumes: `capture.acceptsMarkdown` from Task 3.
- Produces: `pendingAssistantConversation.deliveryAcceptsMarkdown: boolean` (present only with `deliverySessionId`); `createAssistantResponseDelivery({ ..., acceptsMarkdown?: boolean })`; the paste delivery variant `{ mode: "paste"; sessionId; restoreClipboard; allowClipboardFallback; plainText: boolean }`. Tasks 5 and 7 read `delivery.plainText`.

- [ ] **Step 1: Write the failing tests**

In `test/helpers/audioManagerAssistantDirective.test.js`, the existing test "a verified caret is delivered to the captured input" (the one asserting `deliverySessionId: "caret-session"`) must now expect the verdict too. Change its `assert.deepEqual(manager.pendingAssistantConversation, {...})` to:

```js
assert.deepEqual(manager.pendingAssistantConversation, {
  transcript: "draft a reply",
  screenContext: null,
  deliverySessionId: "caret-session",
  deliveryAcceptsMarkdown: false,
});
```

Then append:

```js
test("a caret in a markdown-friendly app carries that verdict with the session id", async (t) => {
  const { createManager } = await loadAudioManagerHarness(t, {
    cachePrefix: "openwhispr-assistant-caret-markdown-",
    settingsKey: "__assistantCaretMarkdownSettings",
    settings: { autoPasteEnabled: true },
    mockModules: {
      "/services/ReasoningService": 'export default { processText: async () => "" };',
    },
  });
  const { manager } = managerWithCapture(createManager, {
    status: "editable",
    sessionId: "caret-session",
    acceptsMarkdown: true,
  });

  await manager.processAgentCommand("draft a reply", "gpt", "Aria", {
    selectionEditReachable: true,
  });

  assert.deepEqual(manager.pendingAssistantConversation, {
    transcript: "draft a reply",
    screenContext: null,
    deliverySessionId: "caret-session",
    deliveryAcceptsMarkdown: true,
  });
});
```

The test "a verified caret stays panel-first when auto-paste is disabled" already asserts no `deliverySessionId`; it must still pass unchanged, which proves the verdict is absent without a caret delivery.

In `test/helpers/assistantResponseDelivery.test.js`, change `PASTE_DELIVERY` to carry the new field and extend the mode test:

```js
const PASTE_DELIVERY = {
  mode: "paste",
  sessionId: "caret-session",
  ...PASTE_OPTIONS,
  plainText: true,
};
```

and inside "Assistant delivery mode follows Auto-Paste and target state":

```js
const createDelivery = (autoPasteEnabled, deliverySessionId, acceptsMarkdown) =>
  createAssistantResponseDelivery({
    autoPasteEnabled,
    deliverySessionId,
    acceptsMarkdown,
    ...PASTE_OPTIONS,
  });

assert.equal(createDelivery(false), null);
assert.deepEqual(createDelivery(true), { mode: "clipboard" });
assert.deepEqual(createDelivery(true, "caret-session"), PASTE_DELIVERY);
assert.deepEqual(createDelivery(true, "caret-session", false), PASTE_DELIVERY);
assert.deepEqual(createDelivery(true, "caret-session", true), {
  ...PASTE_DELIVERY,
  plainText: false,
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm exec 24 node --import tsx --test test/helpers/audioManagerAssistantDirective.test.js test/helpers/assistantResponseDelivery.test.js`
Expected: the changed caret test and the new markdown test FAIL on the missing `deliveryAcceptsMarkdown`; the delivery mode test FAILS on the missing `plainText`. Everything else PASSES.

- [ ] **Step 3: Carry it through the audio manager**

In `src/helpers/audioManager.js`:

`_bankAssistantDirective` — change the destructure and the spread:

```js
const { selectedContext, deliverySessionId, deliveryAcceptsMarkdown } = options || {};
this.pendingAssistantConversation = {
  transcript,
  // resolveReasoningRoute mirrors an attached screenContext into
  // rawScreenContext (same object), so the raw carry is the single source
  // to read — it also survives when this attach gate dropped the image
  // (the panel re-decides for its own request).
  screenContext: config?.rawScreenContext ?? null,
  ...(selectedContext ? { selectedContext } : {}),
  // The verdict only means something next to a caret session.
  ...(deliverySessionId
    ? { deliverySessionId, deliveryAcceptsMarkdown: deliveryAcceptsMarkdown === true }
    : {}),
};
```

`_bankPanelAgentCommand` — accept and forward the field:

```js
  _bankPanelAgentCommand(
    text,
    agentName,
    config,
    { selectedContext, selectedText, deliverySessionId, deliveryAcceptsMarkdown } = {}
  ) {
```

and its last statement:

```js
this._bankAssistantDirective(transcript, config, {
  selectedContext,
  deliverySessionId,
  deliveryAcceptsMarkdown,
});
```

`processAgentCommand` — directly after the `deliverySessionId` const:

```js
// True when the caret sits in a markdown-friendly app (Obsidian, an AI
// prompt box), so the panel neither asks for plain prose nor strips the
// answer. Meaningless without a caret delivery, so undefined then.
const deliveryAcceptsMarkdown = deliverySessionId ? capture.acceptsMarkdown === true : undefined;
```

and add `deliveryAcceptsMarkdown,` to both `_bankPanelAgentCommand(...)` option objects in that method (the `!config?.selectionEditReachable` branch and the `standalone || caret` branch).

- [ ] **Step 4: Carry it into the delivery object**

In `src/hooks/useAudioRecording.js`, the destructure at line 504 becomes:

```js
const { screenContext, transcript, selectedContext, deliverySessionId, deliveryAcceptsMarkdown } =
  result.assistantConversation;
```

and the `createAssistantResponseDelivery` call gains one argument:

```js
                delivery: createAssistantResponseDelivery({
                  autoPasteEnabled,
                  deliverySessionId,
                  acceptsMarkdown: deliveryAcceptsMarkdown === true,
                  restoreClipboard: !keepTranscriptionInClipboard,
                  allowClipboardFallback: isAccessibilitySkipped(),
                }),
```

In `src/helpers/assistantResponseDelivery.ts`, the type and the factory become:

```ts
export type AssistantResponseDelivery =
  | {
      mode: "paste";
      sessionId: string;
      restoreClipboard: boolean;
      allowClipboardFallback: boolean;
      /** Ask for prose and strip markdown before pasting. False for a markdown-friendly target. */
      plainText: boolean;
    }
  | { mode: "clipboard" };
```

```ts
export function createAssistantResponseDelivery({
  autoPasteEnabled,
  deliverySessionId,
  acceptsMarkdown = false,
  restoreClipboard,
  allowClipboardFallback,
}: {
  autoPasteEnabled: boolean;
  deliverySessionId?: string;
  acceptsMarkdown?: boolean;
  restoreClipboard: boolean;
  allowClipboardFallback: boolean;
}): AssistantResponseDelivery | null {
  if (!autoPasteEnabled) return null;
  if (!deliverySessionId) return { mode: "clipboard" };

  return {
    mode: "paste",
    sessionId: deliverySessionId,
    restoreClipboard,
    allowClipboardFallback,
    plainText: !acceptsMarkdown,
  };
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `nvm exec 24 node --import tsx --test test/helpers/audioManagerAssistantDirective.test.js test/helpers/assistantResponseDelivery.test.js && nvm exec 24 npm run typecheck`
Expected: all PASS; typecheck exits 0.

- [ ] **Step 6: Format, lint, commit**

```bash
npx prettier --write src/helpers/audioManager.js src/hooks/useAudioRecording.js src/helpers/assistantResponseDelivery.ts test/helpers/audioManagerAssistantDirective.test.js test/helpers/assistantResponseDelivery.test.js
npx eslint src/helpers/audioManager.js src/helpers/assistantResponseDelivery.ts test/helpers/audioManagerAssistantDirective.test.js test/helpers/assistantResponseDelivery.test.js
(cd src && npx eslint hooks/useAudioRecording.js)
git status --short
git add src/helpers/audioManager.js src/hooks/useAudioRecording.js src/helpers/assistantResponseDelivery.ts test/helpers/audioManagerAssistantDirective.test.js test/helpers/assistantResponseDelivery.test.js
git commit -m "feat(assistant): carry the markdown verdict from capture to the delivery object

acceptsMarkdown rides next to deliverySessionId through the audio manager
and useAudioRecording, and the paste delivery gains plainText (its
negation) for the panel and the delivery helper to act on.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: strip before pasting, only for plain-text targets

**Files:**

- Modify: `src/helpers/assistantResponseDelivery.ts` (`deliverAssistantResponse`)
- Test: `test/helpers/assistantResponseDelivery.test.js`

**Interfaces:**

- Consumes: `markdownToPlainText` (Task 1), `delivery.plainText` (Task 4).
- Produces: no signature change.

- [ ] **Step 1: Write the failing tests**

Append to `test/helpers/assistantResponseDelivery.test.js`:

```js
const MARKDOWN_RESPONSE = "**Bold** start.\n\n* item one\n* item two";
const PLAIN_RESPONSE = "Bold start.\n\n- item one\n- item two";

test("a plain-text caret target receives the response stripped of markdown", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, pastes, writes } = createDeliveryHarness(true);

  assert.deepEqual(
    await deliverAssistantResponse(PASTE_DELIVERY, MARKDOWN_RESPONSE, dependencies),
    { pasted: true, copied: false }
  );
  assert.equal(pastes[0].text, PLAIN_RESPONSE);
  assert.deepEqual(writes, []);
});

test("the clipboard fallback of a refused plain-text paste carries the same stripped text", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, writes } = createDeliveryHarness(false);

  assert.deepEqual(
    await deliverAssistantResponse(PASTE_DELIVERY, MARKDOWN_RESPONSE, dependencies),
    { pasted: false, copied: true }
  );
  assert.deepEqual(writes, [PLAIN_RESPONSE]);
});

test("a markdown-friendly caret target receives the response verbatim", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, pastes } = createDeliveryHarness(true);

  await deliverAssistantResponse(
    { ...PASTE_DELIVERY, plainText: false },
    MARKDOWN_RESPONSE,
    dependencies
  );
  assert.equal(pastes[0].text, MARKDOWN_RESPONSE);
});

test("a clipboard-only delivery keeps the response verbatim", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, writes } = createDeliveryHarness(false);

  await deliverAssistantResponse({ mode: "clipboard" }, MARKDOWN_RESPONSE, dependencies);
  assert.deepEqual(writes, [MARKDOWN_RESPONSE]);
});
```

- [ ] **Step 2: Run the tests to verify the first two fail**

Run: `nvm exec 24 node --import tsx --test test/helpers/assistantResponseDelivery.test.js`
Expected: the two plain-text tests FAIL (the markdown is still pasted / copied); the verbatim tests PASS already.

- [ ] **Step 3: Apply the strip**

In `src/helpers/assistantResponseDelivery.ts`, add the import at the top:

```ts
import { markdownToPlainText } from "./markdownToPlainText";
```

Replace `deliverAssistantResponse` with:

```ts
export async function deliverAssistantResponse(
  delivery: AssistantResponseDelivery,
  content: string,
  dependencies: AssistantResponseDeliveryDependencies = {}
): Promise<{ pasted: boolean; copied: boolean }> {
  const electronAPI = dependencies.electronAPI ?? window.electronAPI;
  const clipboard = dependencies.clipboard ?? navigator.clipboard;

  if (delivery.mode === "paste") {
    // plainText is the main process's verdict on the captured app. When set,
    // the model was asked for prose (plainTextResponse) and this is the floor
    // under a model that drifts back to markdown. It covers the clipboard
    // fallback too: a refused paste leaves the user about to paste the same
    // text by hand into the same field. A markdown-friendly target (Obsidian,
    // an AI prompt box) gets the answer exactly as written.
    const text = delivery.plainText ? markdownToPlainText(content) : content;
    try {
      const result = await electronAPI?.pasteAtCapturedTarget?.(delivery.sessionId, text, {
        restoreClipboard: delivery.restoreClipboard,
        allowClipboardFallback: delivery.allowClipboardFallback,
      });
      if (result?.success === true) return { pasted: true, copied: false };
    } catch {}
    return {
      pasted: false,
      copied: await copyAssistantResponse(text, electronAPI, clipboard),
    };
  }

  // A clipboard-only delivery is shown in the panel as rendered markdown and
  // its Copy button yields the raw markdown; keep the two copy paths equal.
  return {
    pasted: false,
    copied: await copyAssistantResponse(content, electronAPI, clipboard),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nvm exec 24 node --import tsx --test test/helpers/assistantResponseDelivery.test.js`
Expected: all PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write src/helpers/assistantResponseDelivery.ts test/helpers/assistantResponseDelivery.test.js
npx eslint src/helpers/assistantResponseDelivery.ts test/helpers/assistantResponseDelivery.test.js
git status --short
git add src/helpers/assistantResponseDelivery.ts test/helpers/assistantResponseDelivery.test.js
git commit -m "fix(assistant): paste caret-bound answers as plain text unless the app keeps markdown

A plainText paste delivery, and the clipboard fallback of a refused one,
go through markdownToPlainText. Markdown-friendly targets and
clipboard-only deliveries stay verbatim.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: the plain-prose prompt suffix

**Files:**

- Modify: `src/config/prompts/registry.ts` (after `DEFAULT_CHAT_AGENT_PROMPT`, lines 3–8)
- Modify: `src/config/prompts/index.ts` (import on line 5; new function after `appendDictionarySuffix`, which ends at line 59)
- Modify: `src/config/prompts.ts` (export block, lines 3–9)
- Test: `test/helpers/agentPlainTextSuffix.test.js`

**Interfaces:**

- Produces: `export const PLAIN_TEXT_RESPONSE_SUFFIX: string` (registry) and `export function appendPlainTextResponseSuffix(prompt: string): string` (index, re-exported from `src/config/prompts.ts`). Task 7 imports the function from `"../../config/prompts"`.

- [ ] **Step 1: Write the failing tests**

Create `test/helpers/agentPlainTextSuffix.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const promptsModule = import("../../src/config/prompts.ts");
const registryModule = import("../../src/config/prompts/registry.ts");

test("the plain-text suffix is appended once, at the very end", async () => {
  const { appendPlainTextResponseSuffix } = await promptsModule;
  const { PLAIN_TEXT_RESPONSE_SUFFIX } = await registryModule;

  const result = appendPlainTextResponseSuffix("BASE PROMPT");

  assert.ok(result.startsWith("BASE PROMPT"));
  assert.ok(result.endsWith(PLAIN_TEXT_RESPONSE_SUFFIX));
  assert.equal(result.split("OUTPUT FORMAT:").length, 2);
});

test("the suffix names every markdown construct the strip helper removes", async () => {
  const { PLAIN_TEXT_RESPONSE_SUFFIX } = await registryModule;
  for (const construct of ["asterisks", "backticks", "heading", "list", "tables", "link"]) {
    assert.match(PLAIN_TEXT_RESPONSE_SUFFIX, new RegExp(construct));
  }
});

// The panel renders markdown, so a panel-bound answer must never be asked
// for plain prose. Guards against someone "simplifying" the suffix into the
// default prompt later — that would also trip the prompt-hash protocol.
test("a panel-bound agent prompt carries no plain-text instruction", async () => {
  const { getAgentSystemPrompt } = await promptsModule;
  assert.ok(!getAgentSystemPrompt().includes("OUTPUT FORMAT:"));
  assert.ok(!getAgentSystemPrompt(["web_search"], "some note").includes("OUTPUT FORMAT:"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm exec 24 node --import tsx --test test/helpers/agentPlainTextSuffix.test.js`
Expected: the first two FAIL (`appendPlainTextResponseSuffix is not a function` / `PLAIN_TEXT_RESPONSE_SUFFIX` undefined); the third PASSES.

- [ ] **Step 3: Add the constant**

In `src/config/prompts/registry.ts`, directly after the `DEFAULT_CHAT_AGENT_PROMPT` constant (leave that constant and the comment above it byte-for-byte unchanged):

```ts
// Appended per request — never baked into the default above — when the
// answer is pasted at a caret that wants plain text. Conditional on purpose:
// the panel renders markdown, so panel answers keep it; markdown-friendly
// apps (see src/helpers/markdownTargets.js) keep it; a user's custom chat
// prompt still receives it; and the shipped default text (and its hash in
// retiredPrompts.js) stays unchanged. English-only because the chat-agent
// prompt it extends is English-only (i18nKey: null).
export const PLAIN_TEXT_RESPONSE_SUFFIX =
  "\n\nOUTPUT FORMAT: Your answer will be inserted as plain text exactly where the user is typing, " +
  "inside another application. Write plain prose with no markdown: no asterisks, underscores, " +
  "backticks, heading marks, bullet or numbered-list markers, tables, or link syntax. " +
  "Use ordinary sentences and paragraphs. If several items must be listed, put each on its " +
  "own line with no marker.";
```

- [ ] **Step 4: Add the append helper and re-export it**

In `src/config/prompts/index.ts`, change the registry import (line 5) to:

```ts
import { PROMPT_KINDS, PLAIN_TEXT_RESPONSE_SUFFIX, type PromptKind } from "./registry";
```

and add, directly after `appendDictionarySuffix`:

```ts
// Appended last, after every other suffix, when the answer will be pasted at
// a plain-text caret — trailing instructions are the ones models weight most
// (the same reason wrapCleanupTranscript re-anchors the contract after the
// transcript).
export function appendPlainTextResponseSuffix(prompt: string): string {
  return prompt + PLAIN_TEXT_RESPONSE_SUFFIX;
}
```

In `src/config/prompts.ts`, add `appendPlainTextResponseSuffix,` to the export block so it reads:

```ts
export {
  resolvePrompt,
  getDefaultPromptText,
  appendDictionarySuffix,
  appendScreenContextSuffix,
  appendPlainTextResponseSuffix,
  wrapCleanupTranscript,
} from "./prompts/index";
```

- [ ] **Step 5: Run the new tests and the hash-protocol test**

Run: `nvm exec 24 node --import tsx --test test/helpers/agentPlainTextSuffix.test.js test/helpers/retiredPrompts.test.js`
Expected: all PASS. `retiredPrompts.test.js` passing unchanged is the proof the default prompt's hash did not move.

- [ ] **Step 6: Format, lint, commit**

```bash
npx prettier --write src/config/prompts/registry.ts src/config/prompts/index.ts src/config/prompts.ts test/helpers/agentPlainTextSuffix.test.js
npx eslint src/config/prompts/registry.ts src/config/prompts/index.ts src/config/prompts.ts
npx eslint test/helpers/agentPlainTextSuffix.test.js
git status --short
git add src/config/prompts/registry.ts src/config/prompts/index.ts src/config/prompts.ts test/helpers/agentPlainTextSuffix.test.js
git commit -m "feat(assistant): plain-prose prompt suffix for plain-text caret answers

A conditional suffix rather than an edit to DEFAULT_CHAT_AGENT_PROMPT, so
panel answers keep markdown, custom prompts are covered, and the
prompt-hash snapshot is untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: wire the suffix to plain-text caret sends

**Files:**

- Modify: `src/components/chat/useChatStreaming.ts` (import block lines 13–17; `SendToAIOptions` lines 78–92; suffix application after the screen-context block around line 356)
- Modify: `src/components/dictation/AssistantPanel.tsx` (lines 203–210, the pending-command effect)

**Interfaces:**

- Consumes: `appendPlainTextResponseSuffix` (Task 6), `delivery.plainText` (Task 4).
- Produces: `SendToAIOptions.plainTextResponse?: boolean`.

This task has no unit test: the hook is React-bound and the change is a few lines of plumbing. Its verification is `npm run typecheck` here and the manual dev-build check in Task 9.

- [ ] **Step 1: Add the option**

In `src/components/chat/useChatStreaming.ts`, inside `SendToAIOptions`, directly after the `suppressResponseContent` entry:

```ts
  /** Asks the model for plain prose because the answer will be pasted into a plain-text app. */
  plainTextResponse?: boolean;
```

- [ ] **Step 2: Import and apply the suffix last**

Change the prompts import to:

```ts
import {
  appendDictionarySuffix,
  appendPlainTextResponseSuffix,
  appendScreenContextSuffix,
  getAgentSystemPrompt,
} from "../../config/prompts";
```

Directly after the block that ends with `systemPrompt = appendScreenContextSuffix(systemPrompt, settings.uiLanguage);` and its closing `}` (and before the `if (attachment) { transformLastUserMessage(` block), add:

```ts
if (options?.plainTextResponse) {
  // Last on purpose: trailing instructions are the ones models weight most.
  systemPrompt = appendPlainTextResponseSuffix(systemPrompt);
}
```

- [ ] **Step 3: Pass the flag from the panel**

In `src/components/dictation/AssistantPanel.tsx`, the pending-command effect currently has:

```ts
const delivery = pendingCommand.delivery;
const targetsCapturedInput = delivery?.mode === "paste";
```

Add directly after those two lines:

```ts
// Suppressing the panel content and asking for prose are different
// decisions: a caret in Obsidian still keeps the compact pill, but the
// model writes markdown for it.
const plainTextResponse = delivery?.mode === "paste" && delivery.plainText;
```

and in the `sendMessage` call change:

```ts
      suppressResponseContent: targetsCapturedInput,
```

to:

```ts
      suppressResponseContent: targetsCapturedInput,
      plainTextResponse,
```

- [ ] **Step 4: Typecheck**

Run: `nvm exec 24 npm run typecheck`
Expected: exits 0 with no output.

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write src/components/chat/useChatStreaming.ts src/components/dictation/AssistantPanel.tsx
npx eslint src/components/chat/useChatStreaming.ts src/components/dictation/AssistantPanel.tsx
git status --short
git add src/components/chat/useChatStreaming.ts src/components/dictation/AssistantPanel.tsx
git commit -m "feat(assistant): ask for plain prose when the answer targets a plain-text caret

plainTextResponse follows delivery.plainText and appends the suffix last
in the system prompt. Reaches every route: the cloud stream forwards the
client system prompt on every tool-loop step.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: log every declined paste

**Files:**

- Modify: `src/helpers/selectionManager.js` (`pasteAtCapturedTarget`; new private method after it)
- Test: `test/helpers/selectionManager.test.js` (loader at lines 10–25; new tests appended)

**Interfaces:**

- Consumes: `session.acceptsMarkdown` (Task 3).
- Produces: no change to return values. New log lines, scope `"clipboard"`:
  - `info` `"Assistant response paste declined"` with meta `{ code, platform, sessionFound, sessionKind?, probeStatus?, probeCode? }`
  - `debug` `"Assistant response pasted"` with meta `{ targetKind, acceptsMarkdown, platform }`

- [ ] **Step 1: Stub the logger in the test loader**

In `test/helpers/selectionManager.test.js`, directly above `const originalLoad = Module._load;` add:

```js
// selectionManager requires "./debugLogger" at load; the stub records every
// line so tests can assert what a declined paste leaves in the debug log.
const logged = [];
const debugLoggerStub = {
  debug: (message, meta, scope) => logged.push({ level: "debug", message, meta, scope }),
  info: (message, meta, scope) => logged.push({ level: "info", message, meta, scope }),
  warn: (message, meta, scope) => logged.push({ level: "warn", message, meta, scope }),
  trace: () => {},
  log: () => {},
  error: () => {},
};
const declines = () =>
  logged.filter((entry) => entry.message === "Assistant response paste declined");
```

Inside `loadWithElectronMock`, directly after the `if (request === "electron")` block, add:

```js
if (request === "./debugLogger") {
  return debugLoggerStub;
}
```

Run the existing file to confirm the stub did not break anything:
`nvm exec 24 node --import tsx --test test/helpers/selectionManager.test.js` → all existing tests PASS.

- [ ] **Step 2: Write the failing tests**

Append to `test/helpers/selectionManager.test.js`:

```js
test("a paste declined by a changed target logs the code and the probe verdict", async () => {
  logged.length = 0;
  const { manager } = makeHarness({
    selections: [
      { state: "none", editable: true },
      { state: "selected", text: "new selection" },
    ],
  });
  const capture = await manager.captureSelectedText({ probeEditable: true });
  await manager.pasteAtCapturedTarget(capture.sessionId, "Agent response");

  assert.equal(declines().length, 1);
  const [entry] = declines();
  assert.equal(entry.level, "info");
  assert.equal(entry.scope, "clipboard");
  assert.equal(entry.meta.code, "target_changed");
  assert.equal(entry.meta.platform, "darwin");
  assert.equal(entry.meta.sessionFound, true);
  assert.equal(entry.meta.sessionKind, "caret");
  assert.equal(entry.meta.probeStatus, "selected");
});

test("a paste against a missing or expired session logs session_expired", async () => {
  logged.length = 0;
  const { manager, pastes } = makeHarness();

  assert.deepEqual(await manager.pasteAtCapturedTarget("missing-session", "Agent response"), {
    success: false,
    code: "session_expired",
  });
  assert.equal(pastes.length, 0);
  const [entry] = declines();
  assert.equal(entry.meta.code, "session_expired");
  assert.equal(entry.meta.sessionFound, false);
});

test("a selection session offered as a caret target logs its kind", async () => {
  logged.length = 0;
  const { manager } = makeHarness({ selections: ["some selected text"] });
  const capture = await manager.captureSelectedText();

  assert.equal(
    (await manager.pasteAtCapturedTarget(capture.sessionId, "x")).code,
    "session_expired"
  );
  const [entry] = declines();
  assert.equal(entry.meta.sessionFound, true);
  assert.equal(entry.meta.sessionKind, "selection");
});

test("empty text logs invalid_replacement before any clipboard work", async () => {
  logged.length = 0;
  const { manager, pastes } = makeHarness();

  assert.deepEqual(await manager.pasteAtCapturedTarget("any-session", ""), {
    success: false,
    code: "invalid_replacement",
  });
  assert.equal(pastes.length, 0);
  assert.equal(declines()[0].meta.code, "invalid_replacement");
});

test("a paste the clipboard helper reports as not pasted logs paste_failed", async () => {
  logged.length = 0;
  const { manager } = makeHarness({
    selections: [
      { state: "none", editable: true },
      { state: "none", editable: true },
    ],
    pasteResult: { pasted: false, restoreComplete: Promise.resolve() },
  });
  const capture = await manager.captureSelectedText({ probeEditable: true });

  assert.deepEqual(await manager.pasteAtCapturedTarget(capture.sessionId, "Agent response"), {
    success: false,
    code: "paste_failed",
  });
  const [entry] = declines();
  assert.equal(entry.meta.code, "paste_failed");
  assert.equal(entry.meta.probeStatus, "editable");
});

test("a successful paste logs no decline and one debug line carrying the markdown verdict", async () => {
  logged.length = 0;
  const { manager } = makeHarness({
    selections: [
      { state: "none", editable: true },
      { state: "none", editable: true },
    ],
  });
  manager._readExecutablePath = async () => "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
  const capture = await manager.captureSelectedText({ probeEditable: true });

  assert.deepEqual(await manager.pasteAtCapturedTarget(capture.sessionId, "Agent response"), {
    success: true,
  });
  assert.equal(declines().length, 0);
  const successes = logged.filter((entry) => entry.message === "Assistant response pasted");
  assert.equal(successes.length, 1);
  assert.equal(successes[0].level, "debug");
  assert.equal(successes[0].meta.platform, "darwin");
  assert.equal(successes[0].meta.acceptsMarkdown, true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `nvm exec 24 node --import tsx --test test/helpers/selectionManager.test.js`
Expected: the six new tests FAIL (`declines()` is empty / `entry` is undefined); every pre-existing test still PASSES.

- [ ] **Step 4: Add the logging**

In `src/helpers/selectionManager.js`, replace `pasteAtCapturedTarget` with:

```js
  async pasteAtCapturedTarget(sessionId, text, options = {}) {
    if (typeof text !== "string" || text.length === 0) {
      return this._declineAssistantPaste("invalid_replacement", {
        sessionFound: this.sessions.has(sessionId),
      });
    }

    return this.clipboardManager.runClipboardOperation(async () => {
      this._pruneSessions();
      const session = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);
      if (!session || session.kind !== "caret") {
        return this._declineAssistantPaste("session_expired", {
          sessionFound: Boolean(session),
          sessionKind: session?.kind ?? null,
        });
      }

      const current = await this._readCurrentSelection(session.target, { probeEditable: true });
      if (current.status !== "editable") {
        return this._declineAssistantPaste("target_changed", {
          sessionFound: true,
          sessionKind: "caret",
          probeStatus: current.status,
          probeCode: current.code ?? null,
        });
      }

      try {
        const pasteResult = await this.clipboardManager._pasteText(text, {
          ...options,
          restoreClipboard: options.restoreClipboard !== false,
          ...(session.target?.kind === "win-hwnd" ? { targetWindow: session.target.id } : {}),
        });
        await pasteResult?.restoreComplete;
        if (pasteResult?.pasted === false) {
          return this._declineAssistantPaste("paste_failed", {
            sessionFound: true,
            sessionKind: "caret",
            probeStatus: "editable",
          });
        }
        debugLogger.debug(
          "Assistant response pasted",
          {
            targetKind: session.target?.kind ?? null,
            acceptsMarkdown: session.acceptsMarkdown === true,
            platform: this.platform,
          },
          "clipboard"
        );
        return { success: true };
      } catch (error) {
        debugLogger.warn("Assistant response paste failed", { error: error.message }, "clipboard");
        return { success: false, code: "paste_failed", error: error.message };
      }
    });
  }

  // One line per refusal. The renderer discards the code it receives, so the
  // debug log is the only place a declined assistant paste can be diagnosed.
  _declineAssistantPaste(code, details = {}) {
    debugLogger.info(
      "Assistant response paste declined",
      { code, platform: this.platform, ...details },
      "clipboard"
    );
    return { success: false, code };
  }
```

The returned objects are identical to before (`{ success: false, code }`), so no caller changes.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nvm exec 24 node --import tsx --test test/helpers/selectionManager.test.js`
Expected: all PASS, including the six new ones.

- [ ] **Step 6: Format, lint, commit**

```bash
npx prettier --write src/helpers/selectionManager.js test/helpers/selectionManager.test.js
npx eslint src/helpers/selectionManager.js test/helpers/selectionManager.test.js
git status --short
git add src/helpers/selectionManager.js test/helpers/selectionManager.test.js
git commit -m "fix(assistant): log every declined caret paste with its probe verdict

pasteAtCapturedTarget returned four refusal codes and logged none of
them. Each decline now leaves one info line (code, session state, probe
status/code, platform) and a success leaves one debug line that also
records whether the target was judged markdown-friendly.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: full verification, manual check, PR

**Files:** none new. Uses the `openwhispr-dev-build` skill for the manual check.

- [ ] **Step 1: Full suite and quality gate**

```bash
nvm exec 24 npm test
nvm exec 24 npm run quality-check
```

Expected: `npm test` reports 0 failures (about 169 Electron-ABI skips are normal locally). `quality-check` (format check + typecheck) exits 0. If Prettier reflows a file, run `npx prettier --write` on it and amend the relevant commit.

- [ ] **Step 2: Push the branch**

```bash
git status --short          # empty, and never lists node_modules
git log --oneline origin/main..HEAD   # the spec, the plan, and eight implementation commits
git push -u origin fix/agent-paste-plain-text
```

- [ ] **Step 3: Manual verification on a dev build (macOS)**

Stand the branch up with the `openwhispr-dev-build` skill (it isolates a throwaway profile against the production API). Enable debug logging in the app's settings and note the log file it names. Then:

1. **Plain-text target.** Open TextEdit in plain-text mode (Format → Make Plain Text) and place the caret in the document. Trigger a voice command that invites structure, e.g. "give me three reasons to drink more water". **Pass:** prose lands at the caret with no `*`, `#`, `` ` `` or `|`; items, if listed, sit on their own lines without markers; the log carries `Assistant response pasted` with `acceptsMarkdown: false`.
2. **Markdown-friendly target.** Open the ChatGPT desktop app (native, so paste works today; Obsidian and other Electron apps do not receive agent paste on macOS until PR #1952 lands) and place the caret in its prompt box. Trigger "give me a markdown table of three fruits and their colours". **Pass:** the table lands with its pipes intact and no stripping; the log carries `acceptsMarkdown: true`. Do not send the prompt.
3. **Declined paste.** Trigger another command in TextEdit and, while the answer streams, click the Finder desktop. **Pass:** the answer is not pasted, it lands on the clipboard, and the log carries `Assistant response paste declined` with `code: target_changed` and a `probeStatus` / `probeCode`.
4. **History and Copy.** Open the panel's conversation for the step 1 turn. **Pass:** the stored answer is the model's prose, and the panel's Copy button copies it unchanged. For the step 2 turn the stored answer is the markdown table.

Record the outcome of each step in the PR body. If step 1 pastes markdown while the log says `acceptsMarkdown: false`, the strip did not run: check that `delivery.plainText` reached `deliverAssistantResponse`. If step 2 pastes stripped text, check the log's verdict first: a `false` there means the identity string did not match, so add the exact `"<bundle> <executable>"` the log implies to the matcher test and fix the entry.

Tear the dev build down when finished (the skill's `teardown`), and never trust a teardown OK without `git status` in the shared clone coming back clean.

- [ ] **Step 4: Open the PR, never merge it**

```bash
gh pr create --repo OpenWhispr/openwhispr --base main --head fix/agent-paste-plain-text \
  --title "fix(assistant): paste caret-bound answers as plain text unless the app keeps markdown" \
  --body-file - <<'PRBODY'
## Problem

When a voice-command answer pastes at the caret, it arrives with markdown intact: `**bold**` lands as literal asterisks in a plain document. Nothing told the model to write prose and nothing in the delivery path touched the text. At the same time, plain text is the wrong answer for markdown editors, AI prompt boxes, standard-markdown chat tools and code editors, which many of our users live in. Separately, `pasteAtCapturedTarget` returned four refusal codes and logged none of them, so a declined paste was undiagnosable.

## Fix

- **Decide at capture:** `captureSelectedText` judges the app under the caret against `src/helpers/markdownTargets.js` (a researched allowlist matched by whole token on the identity each platform already exposes: `.app` name and executable on macOS, exe name on Windows, WM_CLASS on Linux) and returns `acceptsMarkdown`. Plain text is the default for anything unlisted or unreadable. The list, the evidence per app, and the apps deliberately excluded (Slack, Teams, WhatsApp and Telegram use dialects where `**bold**` leaves stray asterisks) are in the design spec's appendices.
- **Instruct:** for a plain-text caret, `plainTextResponse` appends `PLAIN_TEXT_RESPONSE_SUFFIX` last in the system prompt. Conditional rather than an edit to `DEFAULT_CHAT_AGENT_PROMPT`, so panel answers keep rendered markdown, users' custom chat prompts are covered, and `retiredPrompts.js` is untouched.
- **Strip:** `markdownToPlainText` (new, newline-preserving — deliberately not `stripMarkdownPreview`, which collapses newlines) runs inside `deliverAssistantResponse` for plain-text paste deliveries and their clipboard fallback. Markdown-friendly targets and clipboard-only deliveries stay verbatim. History stores what the model wrote; the strip only touches the pasted bytes.
- **Log:** each of the four refusals in `pasteAtCapturedTarget` emits one `info` line with the code, session state and probe verdict; a success emits one `debug` line that also records the markdown verdict. Return values unchanged.

Design: `docs/superpowers/specs/2026-09-10-agent-paste-plain-text-design.md`. Out of scope, on purpose: rich-text clipboard, per-site detection for web apps in a browser (needs the window title; the natural follow-up once #1952 makes browser targets reachable), a user setting, and PR #1952 itself (Chromium/Electron targets never paste at all today — once it lands the allowlist becomes load-bearing, because most markdown-friendly apps are Electron).

## Tests

- `test/helpers/markdownToPlainText.test.js` — one case per strip rule plus the must-not-alter cases (`2 * 3`, snake_case, `#hashtag`, `x > y`, `\*`) and a two-paragraph answer.
- `test/helpers/markdownTargets.test.js` — every platform identity shape for listed apps matches; plain-text apps, own-dialect chat tools, browsers, `Xcode` and the vetoes never match; no generic tokens.
- `test/helpers/selectionManager.test.js` — verdict on the capture result and session for macOS, Windows, Linux and unreadable pids; one test per refusal code; success logs the verdict.
- `test/helpers/audioManagerAssistantDirective.test.js` — the verdict rides with the session id and is absent without a caret delivery.
- `test/helpers/assistantResponseDelivery.test.js` — `plainText` derivation; stripped vs verbatim per delivery.
- `test/helpers/agentPlainTextSuffix.test.js` — suffix appends once at the end; panel prompt never carries it.
- `test/helpers/retiredPrompts.test.js` unchanged and green: the prompt-hash protocol was not triggered.
- Manual on a macOS dev build: (results of Task 9 step 3 go here — TextEdit plain, ChatGPT app markdown, declined paste logged, history and Copy untouched)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PRBODY
```

Stop here. Do not merge, do not enable auto-merge, do not request a merge.

- [ ] **Step 5: Clean up the worktree**

```bash
rm <worktree>/node_modules            # the symlink only
git -C ~/dev/openwhispr-desktop worktree remove <worktree>
git -C ~/dev/openwhispr-desktop status --short   # must be clean
```

---

## Self-review against the spec

- **Spec §0 (decide once at capture):** Task 2 (list and matcher) and Task 3 (resolution per platform, stored on the session, returned on the result, plain text on any miss or error).
- **Spec §1 (tell the model, per request):** Task 6 (constant + helper) and Task 7 (option, applied last, gated on `delivery.plainText`). Task 4 carries the verdict the gate reads.
- **Spec §2 (strip as the floor):** Task 1 (helper, every rule in the spec's table has a test) and Task 5 (plain-text paste and its fallback only; markdown-friendly and clipboard-only verbatim).
- **Spec §3 (the allowlist):** Task 2 carries exactly the Appendix A tokens, grouped as the spec groups them, with the vetoes and the generic-token ban tested.
- **Spec §4 (history and panel copy):** no code; Task 5 strips only the delivered bytes, and Task 9 step 3.4 verifies history and Copy are untouched.
- **Spec §5 (log the refusal):** Task 8, all four codes plus the probe verdict and the debug success line with `acceptsMarkdown`.
- **Spec "what this does not do":** enforced by Global Constraints (no rich text, no browser-tab detection, no setting, no #1952, no default-prompt edit).
- **Spec "testing":** every listed file has a task; the manual steps are Task 9 step 3.
- **Type consistency:** `markdownToPlainText` (Tasks 1, 5); `isMarkdownTargetSignature` (Tasks 2, 3); `_readTargetNames`, `_targetAcceptsMarkdown`, `acceptsMarkdown` on the capture result and session (Tasks 3, 4, 8); `deliveryAcceptsMarkdown` (Task 4 only, audio manager to hook); `plainText` on the paste delivery (Tasks 4, 5, 7); `PLAIN_TEXT_RESPONSE_SUFFIX`, `appendPlainTextResponseSuffix` (Tasks 6, 7); `plainTextResponse` (Task 7); `_declineAssistantPaste` (Task 8). Named identically everywhere they appear.
