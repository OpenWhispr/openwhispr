# Agent answers paste as plain text — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A voice-command answer pasted at the caret arrives as plain prose, never as raw markdown, and every declined paste leaves one diagnosable line in the debug log.

**Architecture:** Three independent changes on one branch. (1) A per-request prompt suffix asks the model for plain prose only when the answer targets the caret. (2) A newline-preserving `markdownToPlainText` helper is applied inside `deliverAssistantResponse` for `paste` deliveries as the floor under a drifting model. (3) `SelectionManager.pasteAtCapturedTarget` logs each of its four refusal codes with the probe verdict that produced it.

**Tech Stack:** Electron desktop app; TypeScript renderer, CommonJS main process; tests are `node --test` files under `test/` that dynamically import `.ts` through `tsx`; Prettier + ESLint.

**Spec:** `docs/superpowers/specs/2026-09-10-agent-paste-plain-text-design.md` — read it first; every decision below argues from it.

## Global Constraints

- Branch `fix/agent-paste-plain-text`, based on `origin/main` at `a2c76ef9`. Work in the scratchpad worktree, never by switching branches in the shared `~/dev/openwhispr-desktop` clone.
- **Never merge.** Open the PR, stop. (Josh's standing rule.)
- **Do not edit `DEFAULT_CHAT_AGENT_PROMPT`** in `src/config/prompts/registry.ts`, and do not touch `src/config/retiredPrompts.js`. The instruction is a conditional suffix; the hash protocol is deliberately not triggered.
- **Do not reuse or "generalise" `stripMarkdownPreview`** in `src/components/CommandSearch.tsx`. It collapses newlines into spaces.
- **Do not touch PR #1952** or anything under the Chromium/Electron paste probe. Independent defect.
- **No rich-text clipboard work.** Plain text only; the spec scopes rich text out.
- Run the suite with `nvm exec 24 npm test` — Node 25 (the shell default) fakes one unrelated failure. About 169 Electron-ABI skips are normal locally.
- The worktree's `node_modules` is a symlink to the clone's. It is excluded via `.git/info/exclude`, but still confirm `git status --short` never lists it before every commit.
- Commit messages: conventional commits, and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Before every commit: `npx prettier --write <touched files>`, then `npx eslint <touched files>` from the repo root. Two ESLint configs exist: the root one and `src/eslint.config.js`, which ignores `helpers/**` and `utils/**`. If a file comes back "ignored because of a matching ignore pattern", lint it from the other config (`cd src && npx eslint <path relative to src>`). Either way the gate is `npm run quality-check` in Task 6.

---

## File map

| File                                                      | Responsibility                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/helpers/markdownToPlainText.ts` (create)             | Pure function: markdown → plain text, every line break preserved        |
| `test/helpers/markdownToPlainText.test.js` (create)       | One test per strip rule, plus the must-not-alter cases                  |
| `src/helpers/assistantResponseDelivery.ts` (modify)       | Apply the strip to `paste` deliveries and their clipboard fallback      |
| `test/helpers/assistantResponseDelivery.test.js` (modify) | Paste gets plain text; clipboard-only delivery stays verbatim           |
| `src/config/prompts/registry.ts` (modify)                 | `PLAIN_TEXT_RESPONSE_SUFFIX` constant beside the chat-agent prompt      |
| `src/config/prompts/index.ts` (modify)                    | `appendPlainTextResponseSuffix(prompt)` beside the other suffix helpers |
| `src/config/prompts.ts` (modify)                          | Re-export the new helper                                                |
| `test/helpers/agentPlainTextSuffix.test.js` (create)      | Suffix appends once at the end; panel prompt never carries it           |
| `src/components/chat/useChatStreaming.ts` (modify)        | `plainTextResponse` option; append the suffix last                      |
| `src/components/dictation/AssistantPanel.tsx` (modify)    | Pass `plainTextResponse` from `targetsCapturedInput`                    |
| `src/helpers/selectionManager.js` (modify)                | Log every refusal of `pasteAtCapturedTarget`                            |
| `test/helpers/selectionManager.test.js` (modify)          | Logger stub in the loader; one test per refusal code                    |

---

### Task 1: the newline-preserving strip helper

**Files:**

- Create: `src/helpers/markdownToPlainText.ts`
- Test: `test/helpers/markdownToPlainText.test.js`

**Interfaces:**

- Produces: `export function markdownToPlainText(markdown: string): string` — pure, synchronous, never throws on any string input.

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
Expected: 11 tests PASS. If the emphasis or table test fails, fix the regex rather than the expectation: the expectations are the spec's table.

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write src/helpers/markdownToPlainText.ts test/helpers/markdownToPlainText.test.js
npx eslint src/helpers/markdownToPlainText.ts
npx eslint test/helpers/markdownToPlainText.test.js
git status --short   # must list only the two files, never node_modules
git add src/helpers/markdownToPlainText.ts test/helpers/markdownToPlainText.test.js
git commit -m "feat(assistant): newline-preserving markdown-to-plain-text helper

Pure helper for text that is about to be pasted into another app. Keeps
every line break, which is why stripMarkdownPreview (search previews,
collapses newlines) is not reused.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: strip before pasting

**Files:**

- Modify: `src/helpers/assistantResponseDelivery.ts` (the `deliverAssistantResponse` function, currently lines 66–90)
- Test: `test/helpers/assistantResponseDelivery.test.js`

**Interfaces:**

- Consumes: `markdownToPlainText(markdown: string): string` from Task 1.
- Produces: no signature change. `deliverAssistantResponse(delivery, content, dependencies)` still returns `{ pasted: boolean; copied: boolean }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/helpers/assistantResponseDelivery.test.js` (after the existing tests; reuse its `createDeliveryHarness`, `PASTE_DELIVERY` and `deliveryModule`):

```js
const MARKDOWN_RESPONSE = "**Bold** start.\n\n* item one\n* item two";
const PLAIN_RESPONSE = "Bold start.\n\n- item one\n- item two";

test("a caret-bound response is pasted as plain text", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, pastes, writes } = createDeliveryHarness(true);

  assert.deepEqual(
    await deliverAssistantResponse(PASTE_DELIVERY, MARKDOWN_RESPONSE, dependencies),
    { pasted: true, copied: false }
  );
  assert.equal(pastes[0].text, PLAIN_RESPONSE);
  assert.deepEqual(writes, []);
});

test("the clipboard fallback of a refused paste carries the same plain text", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, writes } = createDeliveryHarness(false);

  assert.deepEqual(
    await deliverAssistantResponse(PASTE_DELIVERY, MARKDOWN_RESPONSE, dependencies),
    { pasted: false, copied: true }
  );
  assert.deepEqual(writes, [PLAIN_RESPONSE]);
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
Expected: "a caret-bound response is pasted as plain text" FAILS (`pastes[0].text` still equals the markdown), "the clipboard fallback…" FAILS (writes still hold the markdown), "a clipboard-only delivery…" PASSES already. The three pre-existing tests still pass.

- [ ] **Step 3: Apply the strip in the delivery helper**

In `src/helpers/assistantResponseDelivery.ts`, add the import at the top:

```ts
import { markdownToPlainText } from "./markdownToPlainText";
```

Replace the body of `deliverAssistantResponse` with:

```ts
export async function deliverAssistantResponse(
  delivery: AssistantResponseDelivery,
  content: string,
  dependencies: AssistantResponseDeliveryDependencies = {}
): Promise<{ pasted: boolean; copied: boolean }> {
  const electronAPI = dependencies.electronAPI ?? window.electronAPI;
  const clipboard = dependencies.clipboard ?? navigator.clipboard;

  if (delivery.mode === "paste") {
    // The model was asked for plain prose (plainTextResponse); this is the
    // floor under a model that drifts back to markdown. It covers the
    // clipboard fallback too: a refused paste leaves the user about to paste
    // the same text by hand into the same plain-text field.
    const plainText = markdownToPlainText(content);
    try {
      const result = await electronAPI?.pasteAtCapturedTarget?.(delivery.sessionId, plainText, {
        restoreClipboard: delivery.restoreClipboard,
        allowClipboardFallback: delivery.allowClipboardFallback,
      });
      if (result?.success === true) return { pasted: true, copied: false };
    } catch {}
    return {
      pasted: false,
      copied: await copyAssistantResponse(plainText, electronAPI, clipboard),
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
Expected: 6 tests PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write src/helpers/assistantResponseDelivery.ts test/helpers/assistantResponseDelivery.test.js
npx eslint src/helpers/assistantResponseDelivery.ts
npx eslint test/helpers/assistantResponseDelivery.test.js
git status --short
git add src/helpers/assistantResponseDelivery.ts test/helpers/assistantResponseDelivery.test.js
git commit -m "fix(assistant): paste caret-bound answers as plain text

A paste delivery, and the clipboard fallback of a refused paste, now go
through markdownToPlainText. Clipboard-only deliveries stay verbatim so
they match the panel's Copy button.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: the plain-prose prompt suffix

**Files:**

- Modify: `src/config/prompts/registry.ts` (after `DEFAULT_CHAT_AGENT_PROMPT`, lines 3–8)
- Modify: `src/config/prompts/index.ts` (import on line 5; new function after `appendDictionarySuffix`, which ends at line 59)
- Modify: `src/config/prompts.ts` (export block, lines 3–9)
- Test: `test/helpers/agentPlainTextSuffix.test.js`

**Interfaces:**

- Produces: `export const PLAIN_TEXT_RESPONSE_SUFFIX: string` (registry) and `export function appendPlainTextResponseSuffix(prompt: string): string` (index, re-exported from `src/config/prompts.ts`). Task 4 imports the function from `"../../config/prompts"`.

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
// answer is pasted at the caret in another app. Conditional on purpose: the
// panel renders markdown, so panel answers keep it; a user's custom chat
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
// the caret — trailing instructions are the ones models weight most (the same
// reason wrapCleanupTranscript re-anchors the contract after the transcript).
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
git commit -m "feat(assistant): plain-prose prompt suffix for caret-bound answers

A conditional suffix rather than an edit to DEFAULT_CHAT_AGENT_PROMPT, so
panel answers keep markdown, custom prompts are covered, and the
prompt-hash snapshot is untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: wire the suffix to caret-bound sends

**Files:**

- Modify: `src/components/chat/useChatStreaming.ts` (import block lines 13–17; `SendToAIOptions` lines 78–92; suffix application after the screen-context block around line 356)
- Modify: `src/components/dictation/AssistantPanel.tsx` (line 209, inside the `sendMessage` call)

**Interfaces:**

- Consumes: `appendPlainTextResponseSuffix(prompt: string): string` from `"../../config/prompts"` (Task 3).
- Produces: `SendToAIOptions.plainTextResponse?: boolean`.

This task has no unit test: the hook is React-bound and the change is two lines of plumbing. Its verification is `npm run typecheck` here and the manual dev-build check in Task 6.

- [ ] **Step 1: Add the option**

In `src/components/chat/useChatStreaming.ts`, inside `SendToAIOptions`, directly after the `suppressResponseContent` entry:

```ts
  /** Asks the model for plain prose because the answer will be pasted into another app. */
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

In `src/components/dictation/AssistantPanel.tsx`, the `sendMessage` call currently reads:

```ts
      suppressResponseContent: targetsCapturedInput,
```

Make it:

```ts
      suppressResponseContent: targetsCapturedInput,
      plainTextResponse: targetsCapturedInput,
```

Keep both flags. They come from the same boolean but mean different things: one is what the panel shows, the other is what the model writes.

- [ ] **Step 4: Typecheck**

Run: `nvm exec 24 npm run typecheck`
Expected: exits 0 with no output.

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write src/components/chat/useChatStreaming.ts src/components/dictation/AssistantPanel.tsx
npx eslint src/components/chat/useChatStreaming.ts src/components/dictation/AssistantPanel.tsx
git status --short
git add src/components/chat/useChatStreaming.ts src/components/dictation/AssistantPanel.tsx
git commit -m "feat(assistant): ask for plain prose when the answer targets the caret

plainTextResponse rides alongside suppressResponseContent from the same
targetsCapturedInput boolean and appends the suffix last in the system
prompt. Reaches every route: the cloud stream forwards the client system
prompt on every tool-loop step.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: log every declined paste

**Files:**

- Modify: `src/helpers/selectionManager.js` (`pasteAtCapturedTarget`, lines 257–291; new private method after it)
- Test: `test/helpers/selectionManager.test.js` (loader at lines 10–25; new tests appended)

**Interfaces:**

- Produces: no change to return values. New log lines, scope `"clipboard"`:
  - `info` `"Assistant response paste declined"` with meta `{ code, platform, sessionFound, sessionKind?, probeStatus?, probeCode? }`
  - `debug` `"Assistant response pasted"` with meta `{ targetKind, platform }`

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

test("a successful paste logs no decline and one debug success line", async () => {
  logged.length = 0;
  const { manager } = makeHarness({
    selections: [
      { state: "none", editable: true },
      { state: "none", editable: true },
    ],
  });
  const capture = await manager.captureSelectedText({ probeEditable: true });

  assert.deepEqual(await manager.pasteAtCapturedTarget(capture.sessionId, "Agent response"), {
    success: true,
  });
  assert.equal(declines().length, 0);
  const successes = logged.filter((entry) => entry.message === "Assistant response pasted");
  assert.equal(successes.length, 1);
  assert.equal(successes[0].level, "debug");
  assert.equal(successes[0].meta.platform, "darwin");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `nvm exec 24 node --import tsx --test test/helpers/selectionManager.test.js`
Expected: the six new tests FAIL (`declines()` is empty / `entry` is undefined); every pre-existing test still PASSES.

- [ ] **Step 4: Add the logging**

In `src/helpers/selectionManager.js`, replace `pasteAtCapturedTarget` (lines 257–291) with:

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
          { targetKind: session.target?.kind ?? null, platform: this.platform },
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
npx eslint src/helpers/selectionManager.js
npx eslint test/helpers/selectionManager.test.js
git status --short
git add src/helpers/selectionManager.js test/helpers/selectionManager.test.js
git commit -m "fix(assistant): log every declined caret paste with its probe verdict

pasteAtCapturedTarget returned four refusal codes and logged none of
them. Each decline now leaves one info line (code, session state, probe
status/code, platform) and a success leaves one debug line.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: full verification, manual check, PR

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
git log --oneline origin/main..HEAD   # the spec, the plan, and five implementation commits
git push -u origin fix/agent-paste-plain-text
```

- [ ] **Step 3: Manual verification on a dev build (macOS)**

Stand the branch up with the `openwhispr-dev-build` skill (it isolates a throwaway profile against the production API). Then:

1. Open TextEdit in plain-text mode (Format → Make Plain Text). Place the caret in the document.
2. Trigger a voice command that invites structure, e.g. "give me three reasons to drink more water".
3. **Pass:** prose lands at the caret with no `*`, `#`, `` ` `` or `|`. Items, if listed, sit on their own lines without markers.
4. Open the app's debug log (Settings → debug logging, then the log file it names). **Pass:** a `debug` line `Assistant response pasted` with `targetKind` and `platform`.
5. Trigger another command, and while the answer streams, click into a non-editable window (Finder desktop). **Pass:** the answer is not pasted, it lands on the clipboard, and the log carries `Assistant response paste declined` with `code: target_changed` and a `probeStatus` / `probeCode`.
6. Open the panel's conversation history for that turn. **Pass:** the stored answer is the model's prose, and the panel's Copy button copies it unchanged.

Record the outcome of each step in the PR body. If step 3 fails while step 4 passes, the strip did not run: check `delivery.mode` reached `deliverAssistantResponse` as `"paste"`. If step 3 shows prose but with a stray marker, that is the strip's job: add the exact input as a test case in Task 1's file and fix the regex.

Tear the dev build down when finished (the skill's `teardown`), and never trust a teardown OK without `git status` in the shared clone coming back clean.

- [ ] **Step 4: Open the PR, never merge it**

```bash
gh pr create --repo OpenWhispr/openwhispr --base main --head fix/agent-paste-plain-text \
  --title "fix(assistant): paste caret-bound answers as plain text, and log declined pastes" \
  --body-file - <<'EOF'
## Problem

When a voice-command answer pastes at the caret, it arrives with markdown intact: `**bold**` lands as literal asterisks in a plain document. Nothing told the model to write prose and nothing in the delivery path touched the text. Separately, `pasteAtCapturedTarget` returned four refusal codes and logged none of them, so a declined paste was undiagnosable.

## Fix

- **Instruct:** a `plainTextResponse` send option appends `PLAIN_TEXT_RESPONSE_SUFFIX` last in the system prompt, only when the answer targets the caret. Conditional rather than an edit to `DEFAULT_CHAT_AGENT_PROMPT`, so panel answers keep rendered markdown, users' custom chat prompts are covered, and `retiredPrompts.js` is untouched.
- **Strip:** `markdownToPlainText` (new, newline-preserving — deliberately not `stripMarkdownPreview`, which collapses newlines) runs inside `deliverAssistantResponse` for paste deliveries and their clipboard fallback. Clipboard-only deliveries stay verbatim to match the panel's Copy button. History stores what the model wrote; the strip only touches the pasted bytes.
- **Log:** each of the four refusals in `pasteAtCapturedTarget` emits one `info` line with the code, session state and probe verdict; a success emits one `debug` line. Return values unchanged.

Design: `docs/superpowers/specs/2026-09-10-agent-paste-plain-text-design.md`. Out of scope, on purpose: rich-text clipboard (targets like Notes or Word could take real formatting), and PR #1952 (Chromium/Electron targets never paste at all, an independent defect — once it lands this fix becomes visible everywhere paste works).

## Tests

- `test/helpers/markdownToPlainText.test.js` — one case per strip rule plus the must-not-alter cases (`2 * 3`, snake_case, `#hashtag`, `x > y`) and a two-paragraph answer.
- `test/helpers/assistantResponseDelivery.test.js` — paste and its fallback receive plain text; clipboard-only stays verbatim.
- `test/helpers/agentPlainTextSuffix.test.js` — suffix appends once at the end; panel prompt never carries it.
- `test/helpers/selectionManager.test.js` — one test per refusal code, plus success logs no decline.
- `test/helpers/retiredPrompts.test.js` unchanged and green: the prompt-hash protocol was not triggered.
- Manual on a macOS dev build: (results of Task 6 step 3 go here)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
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

- **Spec §1 (tell the model, per request):** Task 3 (constant + helper) and Task 4 (option, applied last, passed from the panel). The cloud route needs nothing: verified in the spec.
- **Spec §2 (strip as the floor):** Task 1 (helper, every rule in the spec's table has a test) and Task 2 (applied to `paste` and its fallback, not to `clipboard`).
- **Spec §3 (history and panel copy):** no code; Task 2 strips only the delivered bytes, and Task 6 step 3.6 verifies history and Copy are untouched.
- **Spec §4 (log the refusal):** Task 5, all four codes plus the probe verdict and the debug success line.
- **Spec "what this does not do":** enforced by Global Constraints (no rich text, no #1952, no default-prompt edit).
- **Spec "testing":** every listed file has a task; the manual steps are Task 6 step 3.
- **Type consistency:** `markdownToPlainText` (Tasks 1, 2), `appendPlainTextResponseSuffix` and `PLAIN_TEXT_RESPONSE_SUFFIX` (Tasks 3, 4), `plainTextResponse` (Task 4), `_declineAssistantPaste` (Task 5) are named identically everywhere they appear.
