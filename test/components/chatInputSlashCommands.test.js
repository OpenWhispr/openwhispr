const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

async function mountChatInput(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-input-slash-test-",
    mockModules: {
      "/ui/useToast": `export const useToast = () => ({ toast: () => {} });`,
      "/useVoiceDraft": `export const useVoiceDraft = () => ({ status: "idle", streamingOnlyProvider: false });`,
      "/stores/meetingRecordingStore": `
        export const getMicAnalyser = () => null;
        export const useMeetingRecordingStore = { getState: () => ({ currentMicLevel: 0 }) };
      `,
      // Radix positions the menu with real layout; render it in place instead.
      "/ui/popover": `
        import { createContext, createElement, useContext } from "react";
        const Open = createContext(false);
        export const Popover = ({ open, children }) =>
          createElement(Open.Provider, { value: open }, children);
        export const PopoverAnchor = () => null;
        export const PopoverContent = ({ children }) => (useContext(Open) ? children : null);
      `,
    },
  });
  const { ChatInput } = await vite.ssrLoadModule("/components/chat/ChatInput.tsx");
  // Loaded after the DOM is installed, so react-dom detects native input events.
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  return { root, container, ChatInput };
}

const key = (target, name, modifiers = {}) =>
  React.act(async () =>
    target.dispatchEvent({
      type: "keydown",
      key: name,
      ...modifiers,
      bubbles: true,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.cancelBubble = true;
      },
    })
  );

const options = (container) => {
  const listbox = findElement(container, (el) => el.getAttribute?.("role") === "listbox");
  if (!listbox) return [];
  return listbox.childNodes.map((option) => ({
    label: option.textContent,
    selected: option.getAttribute("aria-selected") === "true",
  }));
};

test("typing / in the composer runs an action from the keyboard", async (t) => {
  const { root, container, ChatInput } = await mountChatInput(t);
  const ran = [];
  const drafts = [];
  const submitted = [];
  let escaped = 0;
  const commands = [
    { id: "email", label: "Follow-up email", run: () => ran.push("email") },
    { id: "todos", label: "Make to-dos", run: () => ran.push("todos") },
    {
      id: "tldr",
      label: "Add TL;DR",
      hint: "AI summary",
      disabled: true,
      run: () => ran.push("tldr"),
    },
  ];
  const render = (draftText) =>
    React.act(async () =>
      root.render(
        React.createElement(ChatInput, {
          variant: "note",
          agentState: "idle",
          partialTranscript: "",
          draftText,
          onDraftChange: (text) => drafts.push(text),
          onTextSubmit: (text) => submitted.push(text),
          onEscape: () => escaped++,
          focusOnIdle: false,
          slashCommands: commands,
        })
      )
    );

  await render("/");
  assert.deepEqual(options(container), [], "the menu waits for the composer to have focus");
  const textarea = findElement(container, (el) => el.tagName === "TEXTAREA");
  await React.act(async () => textarea.dispatchEvent({ type: "focusin", bubbles: true }));
  assert.deepEqual(
    options(container).map((option) => option.label),
    ["Follow-up email", "Make to-dos", "Add TL;DRAI summary"]
  );

  await key(textarea, "ArrowDown");
  assert.deepEqual(
    options(container).map((option) => option.selected),
    [false, true, false]
  );
  await key(textarea, "Enter");
  assert.deepEqual(ran, ["todos"]);
  assert.equal(drafts.at(-1), "", "running a command clears the draft");

  await render("/tl");
  assert.deepEqual(
    options(container).map((option) => option.label),
    ["Add TL;DRAI summary"]
  );
  await key(textarea, "Enter");
  assert.deepEqual(ran, ["todos"], "a disabled command doesn't run");
  assert.deepEqual(submitted, [], "nor is its filter sent as a message");

  await key(textarea, "Tab");
  assert.deepEqual(ran, ["todos"], "nor does Tab run it");

  drafts.length = 0;
  await key(textarea, "Escape");
  assert.deepEqual(drafts, [""], "Escape clears the filter");
  assert.equal(escaped, 0, "Escape dismisses the menu, not the composer");

  await render("/");
  await key(textarea, "Tab", { shiftKey: true });
  assert.deepEqual(ran, ["todos"], "Shift+Tab leaves the composer without running anything");
  await key(textarea, "ArrowUp");
  await key(textarea, "Tab");
  assert.deepEqual(ran, ["todos", "email"], "Tab runs the highlighted command");

  await render("/zzz");
  assert.deepEqual(options(container), []);
  await key(textarea, "Enter");
  assert.deepEqual(submitted, ["/zzz"], "a draft no command matches is sent as typed");
});

test("a / filter ranks labels with a word starting with it first", async () => {
  const { matchSlashCommands } = await import("../../src/components/chat/slashCommands.ts");
  const commands = ["Make to-dos", "Shorten", "Slack update", "全部操作"].map((label) => ({
    id: label,
    label,
    run: () => {},
  }));
  const labels = (draft) => matchSlashCommands(commands, draft).map((command) => command.label);

  assert.deepEqual(labels("/s"), ["Shorten", "Slack update", "Make to-dos"]);
  assert.deepEqual(labels("/DOS"), ["Make to-dos"]);
  assert.deepEqual(labels("/操作"), ["全部操作"], "a label without spaces matches mid-word");
  assert.deepEqual(labels("／操作"), ["全部操作"], "a CJK input method's full-width slash counts");
  assert.deepEqual(labels("/"), ["Make to-dos", "Shorten", "Slack update", "全部操作"]);
  assert.deepEqual(labels("Summarize /s"), [], "only a draft that starts with / asks");
  assert.deepEqual(labels("/s\nmore"), [], "nor one that runs onto a new line");
});
