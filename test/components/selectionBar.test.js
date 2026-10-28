const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

async function loadBar(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-selection-bar-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
        }
      `,
    },
  });
  return vite.ssrLoadModule("/components/workspace/SelectionBar.tsx");
}

const buttons = (markup) => markup.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];

test("renders nothing with no selection", async (t) => {
  const { SelectionBar } = await loadBar(t);

  const markup = renderToStaticMarkup(
    React.createElement(SelectionBar, {
      count: 0,
      onClear: () => {},
      actions: [{ label: "Remove", onClick: () => {} }],
    })
  );

  assert.equal(markup, "");
});

test("shows the count, Clear and the actions", async (t) => {
  const { SelectionBar } = await loadBar(t);

  const markup = renderToStaticMarkup(
    React.createElement(SelectionBar, {
      count: 3,
      onClear: () => {},
      actions: [
        { label: "Resend invites", onClick: () => {} },
        { label: "Cancel invites", onClick: () => {}, tone: "destructive" },
      ],
    })
  );

  assert.match(
    markup,
    /role="region"[^>]*aria-label="settingsPage\.workspace\.people\.selection\.label"/
  );
  assert.match(
    markup,
    /settingsPage\.workspace\.people\.selection\.count\|\{&quot;count&quot;:3\}/
  );
  const labels = buttons(markup).map((button) => button.replace(/<[^>]+>/g, ""));
  assert.deepEqual(labels, [
    "settingsPage.workspace.people.selection.clear",
    "Resend invites",
    "Cancel invites",
  ]);
  assert.match(buttons(markup)[2], /destructive/);
  assert.doesNotMatch(buttons(markup)[1], /destructive/);
  assert.doesNotMatch(markup, /disabled=""/);
});

test("a busy action disables every action", async (t) => {
  const { SelectionBar } = await loadBar(t);

  const markup = renderToStaticMarkup(
    React.createElement(SelectionBar, {
      count: 2,
      onClear: () => {},
      actions: [
        { label: "Resending…", onClick: () => {}, busy: true },
        { label: "Cancel invites", onClick: () => {}, tone: "destructive" },
      ],
    })
  );

  const [, busy, other] = buttons(markup);
  assert.match(busy, /disabled=""/);
  assert.match(busy, /animate-spin/);
  assert.match(other, /disabled=""/);
  assert.doesNotMatch(other, /animate-spin/);
});

function findNode(node, predicate) {
  if (node.nodeType === 1 && predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

test("the mixed checkbox is indeterminate", async (t) => {
  let root;
  // Registered first so it runs before the browser globals are taken down.
  t.after(async () => React.act(async () => root?.unmount()));
  const { RowCheckbox } = await loadBar(t);
  const container = installHostDom(t);
  root = createRoot(container);
  const render = (checked) =>
    React.act(async () =>
      root.render(
        React.createElement(RowCheckbox, { checked, onChange: () => {}, label: "Select all" })
      )
    );

  await render("mixed");
  const input = findNode(container, (node) => node.localName === "input");
  assert.ok(input, "native checkbox");
  assert.equal(input.type, "checkbox");
  assert.equal(input.getAttribute("aria-label"), "Select all");
  assert.equal(input.indeterminate, true);

  await render(true);
  assert.equal(input.indeterminate, false);
  assert.equal(input.checked, true);
});
