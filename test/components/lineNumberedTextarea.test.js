const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");
const { dispatch, typeInto } = require("../lib/skillsHarness");

async function renderEditor(t, props) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-line-editor-test-" });
  const { LineNumberedTextarea } = await vite.ssrLoadModule(
    "/components/ui/LineNumberedTextarea.tsx"
  );
  function Harness() {
    const [value, setValue] = React.useState(props.value);
    return React.createElement(LineNumberedTextarea, { ...props, value, onChange: setValue });
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const textarea = findElement(container, (node) => node.tagName === "TEXTAREA");
  const gutter = findElement(container, (node) => node.getAttribute("aria-hidden") === "true");
  return { textarea, gutter };
}

const numbers = (gutter) => gutter.childNodes.map((line) => line.textContent);

test("the gutter numbers every line and scrolls with the text", async (t) => {
  const { textarea, gutter } = await renderEditor(t, {
    id: "instructions",
    value: "one\ntwo\nthree",
    ariaLabel: "Instructions",
  });
  assert.deepEqual(numbers(gutter), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  // React writes the attribute as spellCheck; a real DOM folds attribute names to lowercase
  const attributes = ["id", "dir", "spellCheck"].map((name) => textarea.getAttribute(name));
  assert.deepEqual(attributes, ["instructions", "auto", "false"]);

  await typeInto(textarea, Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n"));
  assert.equal(numbers(gutter).length, 12);
  assert.equal(numbers(gutter).at(-1), "12");

  textarea.scrollTop = 40;
  await React.act(async () => dispatch(textarea, "scroll", { bubbles: false }));
  assert.equal(gutter.scrollTop, 40);
});

// The test DOM has no layout, so this pins the classes that give both columns one height:
// the box is fixed and the text fills it, so the numbers overflow and scroll with the text
// instead of growing the box.
test("the numbers and the text share one fixed-height box", async (t) => {
  const { textarea, gutter } = await renderEditor(t, { id: "instructions", value: "" });
  const classes = (node) => node.getAttribute("class").split(/\s+/);

  assert.equal(gutter.parentNode, textarea.parentNode);
  assert.ok(classes(textarea.parentNode).includes("h-56"));
  assert.ok(classes(textarea).includes("h-full"));
  assert.ok(classes(gutter).includes("overflow-hidden"));
});

// The numbers count lines, so no line may wrap onto a second row beside the next number: a
// long one scrolls sideways, and the gutter leaves room at the bottom for that scrollbar.
test("a long line scrolls sideways instead of wrapping beside the next number", async (t) => {
  const { textarea, gutter } = await renderEditor(t, { id: "instructions", value: "" });
  const classes = (node) => node.getAttribute("class").split(/\s+/);

  assert.equal(textarea.getAttribute("wrap"), "off");
  assert.ok(classes(textarea).includes("overflow-auto"));
  assert.ok(classes(gutter).includes("pb-3.5"));
});

// index.css gives every other field a border, a background and the sans font, which would
// draw a second box inside the editor and undo font-mono.
test("the text area opts out of the app's own field style", async (t) => {
  const { textarea } = await renderEditor(t, { id: "instructions", value: "" });
  assert.ok(textarea.getAttribute("class").split(/\s+/).includes("input-inline"));
});

test("an invalid editor says so and points at its message", async (t) => {
  const { textarea } = await renderEditor(t, {
    id: "instructions",
    value: "",
    invalid: true,
    describedBy: "instructions-error",
  });

  assert.deepEqual(
    [textarea.getAttribute("aria-invalid"), textarea.getAttribute("aria-describedby")],
    ["true", "instructions-error"]
  );
});
