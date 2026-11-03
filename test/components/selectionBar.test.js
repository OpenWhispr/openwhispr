const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

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
      actions: [{ id: "Remove", label: "Remove", onClick: () => {} }],
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
        { id: "Resend invites", label: "Resend invites", onClick: () => {} },
        { id: "Cancel invites", label: "Cancel invites", onClick: () => {}, tone: "destructive" },
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
  const labels = buttons(markup).map((button) => button.replace(/<[^>]*>/g, ""));
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
        { id: "Resending…", label: "Resending…", onClick: () => {}, busy: true },
        { id: "Cancel invites", label: "Cancel invites", onClick: () => {}, tone: "destructive" },
      ],
    })
  );

  const [, busy, other] = buttons(markup);
  // Not `disabled`, which would drop focus from the button that was just pressed.
  assert.match(busy, /aria-disabled="true"/);
  assert.doesNotMatch(busy, /\sdisabled=""/);
  assert.match(busy, /animate-spin/);
  assert.match(other, /aria-disabled="true"/);
  assert.doesNotMatch(other, /animate-spin/);
});

test("the mixed checkbox announces itself and draws a dash", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-row-checkbox-" });
  const { RowCheckbox } = await vite.ssrLoadModule("/components/dictionary/RowCheckbox.tsx");
  const render = (checked) =>
    renderToStaticMarkup(
      React.createElement(RowCheckbox, { checked, onToggle: () => {}, label: "Select all" })
    );

  assert.match(render("mixed"), /role="checkbox"/);
  assert.match(render("mixed"), /aria-checked="mixed"/);
  assert.match(render("mixed"), /aria-label="Select all"/);
  assert.match(render("mixed"), /d="M4 8H12"/);

  assert.match(render(true), /aria-checked="true"/);
  assert.doesNotMatch(render(true), /M4 8H12/);
  assert.match(render(false), /aria-checked="false"/);
  assert.doesNotMatch(render(false), /<svg/);
});

test("the bar wraps inside a narrow pane and its labels never truncate", async (t) => {
  const { SelectionBar } = await loadBar(t);

  const markup = renderToStaticMarkup(
    React.createElement(SelectionBar, {
      count: 2,
      onClear: () => {},
      actions: [
        { id: "Einladungen erneut senden", label: "Einladungen erneut senden", onClick: () => {} },
      ],
    })
  );

  const bar = markup.match(/<div[^>]*role="region"[^>]*class="([^"]*)"/)?.[1] ?? "";
  const classes = bar.split(/\s+/);
  for (const name of ["flex-wrap", "justify-center", "max-w-full", "rounded-2xl", "ps-4", "pe-1"]) {
    assert.ok(classes.includes(name), `missing ${name} in "${bar}"`);
  }
  assert.ok(!classes.includes("rounded-full"), "a wrapped pill's radius reads as a blob");
  assert.doesNotMatch(markup, /truncate/);
});
