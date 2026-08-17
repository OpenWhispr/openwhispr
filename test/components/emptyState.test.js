const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

// tsx resolves tsconfig from the cwd, where none sets the automatic JSX runtime,
// so compiled .tsx uses the classic transform and needs a global React.
globalThis.React = require("react");

async function loadEmptyState() {
  const mod = await import("../../src/components/ui/EmptyState.tsx");
  return mod.EmptyState ?? mod.default?.EmptyState ?? mod.default;
}

async function render(props) {
  const EmptyState = await loadEmptyState();
  return renderToStaticMarkup(createElement(EmptyState, props));
}

test("renders title, description and actions together", async () => {
  const html = await render({
    title: "Nothing here",
    description: "Add something to get started",
    actions: createElement("button", { type: "button" }, "Add first item"),
  });

  assert.ok(html.includes("Nothing here"));
  assert.ok(html.includes("Add something to get started"));
  assert.ok(html.includes("Add first item"));
});

test("renders nothing at all when every slot is empty", async () => {
  const html = await render({});
  assert.equal(html, "");
});

test("default mode wraps the icon in a soft circle, compact mode does not", async () => {
  const { Mic } = require("lucide-react");
  const withCircle = await render({ icon: Mic, description: "d" });
  const compact = await render({ icon: Mic, description: "d", compact: true });

  assert.ok(withCircle.includes("rounded-full"));
  assert.ok(!compact.includes("rounded-full"));
  assert.ok(compact.includes("<svg"));
});

test("description accepts arbitrary react nodes, not just strings", async () => {
  const html = await render({
    description: createElement(
      "span",
      null,
      "Press ",
      createElement("kbd", null, "F8"),
      " to start"
    ),
  });

  assert.ok(html.includes("<kbd>F8</kbd>"));
});

test("a custom className padding overrides the default via tailwind-merge", async () => {
  const html = await render({ description: "d", className: "py-16" });

  assert.ok(html.includes("py-16"));
  assert.ok(!html.includes("py-12"));
});

test("a falsy actions value renders no actions row", async () => {
  const html = await render({ description: "d", actions: false });

  assert.ok(!html.includes("mt-4"));
});

test("the actions slot renders caller elements unmodified", async () => {
  const action = createElement("button", { type: "button", "data-testid": "cta" }, "Go");
  const html = await render({ description: "d", actions: action });

  assert.ok(html.includes('data-testid="cta"'));
});
