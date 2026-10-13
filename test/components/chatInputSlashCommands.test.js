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
    label: option.textContent.trim(),
    selected: option.getAttribute("aria-selected") === "true",
  }));
};

test("typing / in the composer runs an action from the keyboard", async (t) => {
  const { root, container, ChatInput } = await mountChatInput(t);
  const ran = [];
  const drafts = [];
  const submitted = [];
  const menuOpen = [];
  const icon = () => null;
  const commands = [
    {
      id: "email",
      label: "Follow-up email",
      icon,
      description: "Draft it from the note",
      run: () => ran.push("email"),
    },
    { id: "todos", label: "Create to-dos", icon, run: () => ran.push("todos") },
    {
      id: "tldr",
      label: "Add TL;DR",
      icon,
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
          focusOnIdle: false,
          slashCommands: commands,
          onSlashMenuOpenChange: (open) => menuOpen.push(open),
        })
      )
    );

  await render("/");
  assert.deepEqual(options(container), [], "the menu waits for the composer to have focus");
  const textarea = findElement(container, (el) => el.tagName === "TEXTAREA");
  await React.act(async () => textarea.dispatchEvent({ type: "focusin", bubbles: true }));
  assert.deepEqual(
    options(container).map((option) => option.label),
    ["Follow-up emailDraft it from the note", "Create to-dos", "Add TL;DRAI summary"],
    "each command shows its description"
  );
  assert.equal(menuOpen.at(-1), true, "the host hears the menu open, to hide the chat");
  const listbox = findElement(container, (el) => el.getAttribute?.("role") === "listbox");
  const pressBetweenRows = listbox.dispatchEvent({
    type: "mousedown",
    bubbles: true,
    preventDefault() {
      this.defaultPrevented = true;
    },
  });
  assert.equal(pressBetweenRows, false, "a press between the rows keeps focus in the composer");

  const row = (index) =>
    findElement(container, (el) => el.getAttribute?.("role") === "listbox").childNodes[index];
  const selected = () => options(container).map((option) => option.selected);
  await React.act(async () =>
    row(2).dispatchEvent({ type: "mouseover", bubbles: true, relatedTarget: null })
  );
  assert.deepEqual(selected(), [true, false, false], "a row sliding under a resting pointer");
  await React.act(async () => row(1).dispatchEvent({ type: "mousemove", bubbles: true }));
  assert.deepEqual(selected(), [false, true, false], "moving the pointer picks the row");
  await key(textarea, "ArrowUp");

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

  await render("/");
  await key(textarea, "Tab", { shiftKey: true });
  assert.deepEqual(ran, ["todos"], "Shift+Tab leaves the composer without running anything");
  await key(textarea, "ArrowUp");
  await key(textarea, "Tab");
  assert.deepEqual(ran, ["todos", "email"], "Tab runs the highlighted command");

  await render("/zzz");
  assert.deepEqual(options(container), []);
  assert.equal(menuOpen.at(-1), false, "and close, to show the chat again");
  await key(textarea, "Enter");
  assert.deepEqual(submitted, ["/zzz"], "a draft no command matches is sent as typed");
});

test("a / filter ranks labels with a word starting with it first", async () => {
  const { matchSlashCommands } = await import("../../src/components/chat/slashCommands.ts");
  const commands = ["Create to-dos", "Shorten", "Slack update", "全部操作"].map((label) => ({
    id: label,
    label,
    run: () => {},
  }));
  const labels = (draft) => matchSlashCommands(commands, draft).map((command) => command.label);

  assert.deepEqual(labels("/s"), ["Shorten", "Slack update", "Create to-dos"]);
  assert.deepEqual(labels("/DOS"), ["Create to-dos"]);
  assert.deepEqual(labels("/操作"), ["全部操作"], "a label without spaces matches mid-word");
  assert.deepEqual(labels("／操作"), ["全部操作"], "a CJK input method's full-width slash counts");
  assert.deepEqual(labels("/"), ["Create to-dos", "Shorten", "Slack update", "全部操作"]);
  assert.deepEqual(labels("Summarize /s"), [], "only a draft that starts with / asks");
  assert.deepEqual(labels("/s\nmore"), [], "nor one that runs onto a new line");
});

test("each / row shows its command's icon in the tile", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-slash-menu-icons-test-" });
  const SlashCommandMenu = (await vite.ssrLoadModule("/components/chat/SlashCommandMenu.tsx"))
    .default;
  const { Mail } = await vite.ssrLoadModule("/components/icons/index.ts");
  const { renderToStaticMarkup } = require("react-dom/server");
  const html = renderToStaticMarkup(
    React.createElement(SlashCommandMenu, {
      id: "menu",
      label: "Commands",
      commands: [{ id: "email", label: "Follow-up email", icon: Mail, run: () => {} }],
      activeIndex: 0,
      onActiveIndexChange: () => {},
      onRun: () => {},
    })
  );
  assert.ok(html.includes('data-icon="mail"'));
});
