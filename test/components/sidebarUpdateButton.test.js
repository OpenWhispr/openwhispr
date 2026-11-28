const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { ENGLISH_I18N_MOCK } = require("../lib/happyDomDialog");

// The menu renders its items inline and hands the test the item's onSelect.
const MOCKS = {
  "react-i18next": ENGLISH_I18N_MOCK,
  "/ui/dropdown-menu": `
    import { createElement } from "react";
    const part = ({ children }) => createElement("div", null, children);
    export const DropdownMenu = part;
    export const DropdownMenuTrigger = part;
    export const DropdownMenuContent = part;
    export function DropdownMenuItem({ children, onSelect }) {
      globalThis.__skipSelect = onSelect;
      return createElement("div", { role: "menuitem" }, children);
    }
  `,
};

async function loadButton(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-sidebar-update-button-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  t.after(() => {
    delete globalThis.__skipSelect;
  });
  const { default: SidebarUpdateButton } = await vite.ssrLoadModule(
    "/components/SidebarUpdateButton.tsx"
  );
  return (props) =>
    renderToStaticMarkup(
      React.createElement(
        SidebarUpdateButton,
        { downloaded: false, disabled: false, onClick() {}, ...props },
        "Update Available"
      )
    );
}

test("an available release offers Skip this version behind the chevron", async (t) => {
  const render = await loadButton(t);
  const skipped = [];
  const markup = render({ onSkipVersion: () => skipped.push(true) });

  assert.match(markup, /aria-label="More update actions"/);
  assert.match(markup, /role="menuitem">Skip this version</);
  assert.match(markup, /Update Available/);
  globalThis.__skipSelect();
  assert.deepEqual(skipped, [true]);
});

test("a download or install in progress has no skip menu", async (t) => {
  const render = await loadButton(t);

  for (const props of [{ disabled: true }, { downloaded: true }]) {
    const markup = render(props);
    assert.doesNotMatch(markup, /menuitem/);
    assert.doesNotMatch(markup, /More update actions/);
    assert.match(markup, /Update Available/);
  }
  assert.match(render({ disabled: true }), /disabled=""/);
});
