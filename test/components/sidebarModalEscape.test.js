const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Mounts the real SidebarModal (Radix Dialog) in happy-dom and presses Escape in a field, which
// Radix sees on the document in the capture phase before the field's own key handler.

const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "getComputedStyle",
  "KeyboardEvent",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "HTMLInputElement",
  "ResizeObserver",
  "DOMRect",
];

let happyWindow;
let SidebarModal;
let escapeClearsAttribute;

test.before(async () => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window();
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of DOM_GLOBALS) define(name, happyWindow[name]);
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, happyWindow[name].bind(happyWindow));
  }
  define("IS_REACT_ACT_ENVIRONMENT", true);
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

async function loadModules(t) {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-sidebar-modal-escape-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
    },
  });
  ({ default: SidebarModal } = await vite.ssrLoadModule("/components/ui/SidebarModal.tsx"));
  ({ ESCAPE_CLEARS_ATTRIBUTE: escapeClearsAttribute } = await vite.ssrLoadModule(
    "/components/ui/escapeClears.ts"
  ));
}

// Presses Escape in an input inside the open modal; resolves to whether the modal asked to close.
async function pressEscapeInField(t, fieldAttributes) {
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  const root = createRoot(container);
  let closeRequests = 0;
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
  });

  await React.act(async () => {
    root.render(
      React.createElement(
        SidebarModal,
        {
          open: true,
          onOpenChange: (open) => {
            if (!open) closeRequests += 1;
          },
          title: "Settings",
          sidebarItems: [],
          activeSection: "a",
          onSectionChange: () => {},
        },
        React.createElement("input", { "data-testid": "field", ...fieldAttributes })
      )
    );
  });

  const field = happyWindow.document.querySelector("[data-testid='field']");
  assert.ok(field, "field is rendered inside the open modal");
  field.focus();
  await React.act(async () => {
    field.dispatchEvent(
      new happyWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
  });
  return closeRequests;
}

test("Escape in a field marked as clearing does not close the modal", async (t) => {
  await loadModules(t);
  assert.equal(await pressEscapeInField(t, { [escapeClearsAttribute]: "" }), 0);
});

test("Escape in an unmarked field still closes the modal", async (t) => {
  await loadModules(t);
  assert.equal(await pressEscapeInField(t, {}), 1);
});
