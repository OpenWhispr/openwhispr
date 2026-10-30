const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { createElement } = React;
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

const MOCKS = {
  "react-i18next": `
    const t = (key, options) => (options ? key + JSON.stringify(options) : key);
    export const useTranslation = () => ({ t, i18n: { language: "en" } });
  `,
};

const ROW_HEIGHT = 38;

const personalRow = (index) => ({
  key: `personal:word-${index}`,
  word: `word-${index}`,
  kind: "personal",
  entryId: null,
  entryIds: [],
  badge: null,
  otherLists: 0,
  attribution: null,
  createdAt: null,
  addedIndex: index,
  usedInDictation: true,
});

// A scroller with a fixed 380px viewport, the only layout the virtualizer reads.
function fakeScroller(container) {
  const scroller = container.ownerDocument.createElement("div");
  scroller.offsetHeight = 380;
  scroller.offsetWidth = 600;
  scroller.scrollTop = 0;
  scroller.scrollLeft = 0;
  scroller.getBoundingClientRect = () => ({ top: 0 });
  return scroller;
}

async function renderList(t, props) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  // The virtualizer debounces scroll-end through the scroller's window.
  installBrowserGlobals(t, { window: { setTimeout, clearTimeout } });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictionary-word-list-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const module = await vite.ssrLoadModule("/components/dictionary/DictionaryWordList.tsx");
  const { createRoot } = require("react-dom/client");
  const scroller = fakeScroller(container);
  root = createRoot(container);
  const base = {
    hiddenList: false,
    onEdit: async () => null,
    onDelete() {},
    onHide() {},
    onDeleteForEveryone() {},
    onUnhide() {},
    getScrollElement: () => scroller,
  };
  let current = { ...base, ...props };
  const render = (next = {}) => {
    current = { ...current, ...next };
    return React.act(async () => root.render(createElement(module.DictionaryWordList, current)));
  };
  await render();
  return { container, scroller, render, VIRTUALIZE_AFTER_ROWS: module.VIRTUALIZE_AFTER_ROWS };
}

const renderedWords = (container) =>
  container.querySelectorAll("li").map((node) => node.getAttribute("data-word"));

// Waits out the virtualizer's 150ms scroll-end timer, so it never fires after the test.
const scrollTo = (scroller, top) =>
  React.act(async () => {
    scroller.scrollTop = top;
    scroller.dispatchEvent({ type: "scroll", bubbles: false });
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

test("a long list renders only the rows near the viewport, and keeps the one being edited", async (t) => {
  const rows = Array.from({ length: 2000 }, (_, index) => personalRow(index));
  const { container, scroller } = await renderList(t, { rows });

  const first = renderedWords(container);
  assert.ok(first.includes("word-0"));
  assert.ok(first.length < 60, `rendered ${first.length} rows`);
  const item = findElement(container, (node) => node.getAttribute?.("data-word") === "word-0");
  assert.equal(item.getAttribute("aria-setsize"), "2000");
  assert.equal(item.getAttribute("aria-posinset"), "1");

  // Start editing the first row, then scroll far away from it.
  const edit = findElement(
    item,
    (node) => node.getAttribute?.("aria-label") === 'dictionary.editWord{"word":"word-0"}'
  );
  await React.act(async () => edit.dispatchEvent({ type: "click", bubbles: true }));
  await scrollTo(scroller, ROW_HEIGHT * 1000);

  const later = renderedWords(container);
  assert.ok(later.includes("word-1000"));
  assert.ok(later.includes("word-0"), "the row being edited stays rendered");
  assert.ok(
    findElement(container, (node) => node.tagName === "INPUT"),
    "its editor kept its state"
  );
  assert.ok(later.length < 60);
});

test("a short list renders every row without virtualizing", async (t) => {
  const { container, VIRTUALIZE_AFTER_ROWS } = await renderList(t, {
    rows: Array.from({ length: 50 }, (_, index) => personalRow(index)),
  });
  assert.equal(renderedWords(container).length, 50);
  assert.ok(VIRTUALIZE_AFTER_ROWS > 50);
  const item = findElement(container, (node) => node.getAttribute?.("data-word") === "word-0");
  assert.equal(item.getAttribute("aria-setsize"), null);
});

test("⌘A selects all by physical key, whatever the layout types", async (t) => {
  const calls = [];
  const selection = {
    isSelected: () => false,
    active: false,
    onToggle() {},
    onSelectAll: () => calls.push("selectAll"),
    onClear() {},
  };
  const { container } = await renderList(t, {
    rows: [personalRow(0), personalRow(1)],
    selection,
  });
  const list = container.querySelector("ul");
  const keyDown = (extra) =>
    React.act(async () => {
      const event = {
        type: "keydown",
        bubbles: true,
        metaKey: true,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
        ...extra,
      };
      list.dispatchEvent(event);
      return event;
    });
  const arabic = await keyDown({ key: "ش", code: "KeyA" });
  assert.deepEqual(calls, ["selectAll"]);
  assert.equal(arabic.defaultPrevented, true, "the page's own Select All doesn't run too");
  // AZERTY types "a" on the KeyQ position, and "q" on KeyA, where ⌘Q must still quit.
  await keyDown({ key: "a", code: "KeyQ" });
  assert.deepEqual(calls, ["selectAll", "selectAll"]);
  const quit = await keyDown({ key: "q", code: "KeyA" });
  assert.deepEqual(calls, ["selectAll", "selectAll"]);
  assert.notEqual(quit.defaultPrevented, true);
});

test("⌘A in the Hidden list, which has no selection, doesn't select the page's text", async (t) => {
  const { container } = await renderList(t, {
    rows: [personalRow(0)],
    hiddenList: true,
  });
  const keyDown = (node) =>
    React.act(async () => {
      const event = {
        type: "keydown",
        bubbles: true,
        metaKey: true,
        key: "a",
        code: "KeyA",
        target: node,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
      };
      node.dispatchEvent(event);
      return event;
    });
  const list = container.querySelector("ul");
  const onList = await keyDown(list);
  assert.equal(onList.defaultPrevented, true);
});

const sharedRow = (index) => ({
  ...personalRow(index),
  key: `shared:e-${index}`,
  kind: "shared",
  entryId: `e-${index}`,
  entryIds: [`e-${index}`],
});

const rowNode = (container, word) =>
  findElement(
    container,
    (node) => node.tagName === "LI" && node.getAttribute("data-word") === word
  );

const actionButton = (container, word, key) =>
  findElement(
    rowNode(container, word),
    (node) => node.getAttribute?.("aria-label") === `${key}{"word":"${word}"}`
  );

// A click focuses the button it lands on, which this DOM leaves to the test.
const press = (button) =>
  React.act(async () => {
    button.focus();
    button.dispatchEvent({ type: "click", bubbles: true });
  });

const focusedRow = (container) => {
  for (let node = container.ownerDocument.activeElement; node; node = node.parentNode) {
    if (node.tagName === "LI") return node.getAttribute("data-word");
  }
  return null;
};

test("after a delete, focus moves to the next row, else the previous, else the list", async (t) => {
  const rows = [personalRow(0), personalRow(1), personalRow(2)];
  const { container, render } = await renderList(t, { rows });
  const deleteWord = "dictionary.shared.actions.deleteWord";

  await press(actionButton(container, "word-1", deleteWord));
  await render({ rows: [rows[0], rows[2]] });
  assert.equal(focusedRow(container), "word-2");

  await press(actionButton(container, "word-2", deleteWord));
  await render({ rows: [rows[0]] });
  assert.equal(focusedRow(container), "word-0");

  await press(actionButton(container, "word-0", deleteWord));
  await render({ rows: [] });
  assert.equal(container.ownerDocument.activeElement, container.querySelector("ul"));
});

test("Hide waits for the row to leave, and focus the user moved stays put", async (t) => {
  const rows = [sharedRow(0), sharedRow(1)];
  const { container, render } = await renderList(t, { rows });
  const hideWord = "dictionary.shared.actions.hideWord";

  const hide = actionButton(container, "word-0", hideWord);
  await press(hide);
  // The round trip hasn't finished: the row and its focused button are still there.
  await render({ rows: [...rows] });
  assert.equal(container.ownerDocument.activeElement, hide);
  await render({ rows: [rows[1]] });
  assert.equal(focusedRow(container), "word-1");

  // Unhide in the Hidden list works the same way.
  await render({ rows, hiddenList: true });
  await press(actionButton(container, "word-0", "dictionary.shared.actions.unhideWord"));
  const elsewhere = container.ownerDocument.createElement("input");
  container.appendChild(elsewhere);
  elsewhere.focus();
  await render({ rows: [rows[1]] });
  assert.equal(container.ownerDocument.activeElement, elsewhere);
});

test("a committed edit leaves focus on the row, following a renamed personal word", async (t) => {
  const type = (input, value) =>
    React.act(async () => {
      input.type ??= "text";
      input.value = value;
      input.dispatchEvent({ type: "input", bubbles: true });
    });
  const enter = (input) =>
    React.act(async () =>
      input.dispatchEvent({
        type: "keydown",
        key: "Enter",
        bubbles: true,
        preventDefault() {},
        stopPropagation() {},
      })
    );
  const editWord = "dictionary.editWord";

  const shared = [sharedRow(0), sharedRow(1)];
  const { container, render } = await renderList(t, { rows: shared });
  await press(actionButton(container, "word-1", editWord));
  const editor = findElement(container, (node) => node.tagName === "INPUT");
  assert.equal(container.ownerDocument.activeElement, editor);
  await type(editor, "word-1b");
  await enter(editor);
  assert.equal(
    findElement(container, (node) => node.tagName === "INPUT"),
    null
  );
  assert.equal(focusedRow(container), "word-1");

  const personal = [personalRow(0), personalRow(1)];
  await render({ rows: personal });
  await press(actionButton(container, "word-0", editWord));
  const renameEditor = findElement(container, (node) => node.tagName === "INPUT");
  await type(renameEditor, "word-9");
  await enter(renameEditor);
  const renamed = { ...personalRow(9), addedIndex: 0 };
  await render({ rows: [personal[1], renamed] });
  assert.equal(focusedRow(container), "word-9");
});
