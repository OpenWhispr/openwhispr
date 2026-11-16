const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { ENGLISH_I18N_MOCK, installHappyDom, interactions, text } = require("../lib/happyDomDialog");

async function loadGuard() {
  const mod = await import("../../src/components/ui/useDismissGuard.ts");
  return mod.hasLayerAbove ?? mod.default.hasLayerAbove;
}

// A stand-in for the dialog's own content node. Radix writes `pointer-events`
// inline on it, so the style bag is all the probe reads.
function contentNode(pointerEvents) {
  return { style: { pointerEvents } };
}

function probe({ popper = false, openDialogs = [] } = {}) {
  return {
    querySelector: (sel) => (sel === "[data-radix-popper-content-wrapper]" && popper ? {} : null),
    querySelectorAll: () => openDialogs,
  };
}

test("nothing above the dialog is not a layer", async () => {
  const hasLayerAbove = await loadGuard();
  const content = contentNode("auto");
  assert.equal(hasLayerAbove(content, probe({ openDialogs: [content] })), false);
});

test("an inert content node means a layer above disabled its pointer events", async () => {
  const hasLayerAbove = await loadGuard();
  // This is the Select-open case: Radix sets `pointer-events: none` on the
  // dialog content, so the click that dismisses the Select lands on the
  // dialog's own overlay instead of on the panel the user aimed at.
  const content = contentNode("none");
  assert.equal(hasLayerAbove(content, probe({ openDialogs: [content] })), true);
});

test("a mounted radix popper is a layer above", async () => {
  const hasLayerAbove = await loadGuard();
  const content = contentNode("auto");
  assert.equal(hasLayerAbove(content, probe({ popper: true, openDialogs: [content] })), true);
});

test("a dialog opened later stacks above this one", async () => {
  const hasLayerAbove = await loadGuard();
  const content = contentNode("auto");
  const stacked = contentNode("auto");
  assert.equal(hasLayerAbove(content, probe({ openDialogs: [content, stacked] })), true);
});

test("the topmost open dialog has nothing above it", async () => {
  const hasLayerAbove = await loadGuard();
  const below = contentNode("auto");
  const content = contentNode("auto");
  assert.equal(hasLayerAbove(content, probe({ openDialogs: [below, content] })), false);
});

test("an unmounted content node reports no layer above", async () => {
  const hasLayerAbove = await loadGuard();
  assert.equal(hasLayerAbove(null, probe()), false);
});

test("pressing a toast leaves the dialog open, and pressing anywhere else closes it", async (t) => {
  const { happyWindow, createRoot } = await installHappyDom();
  const ui = interactions(happyWindow);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dismiss-guard-",
    noExternal: ["react-i18next"],
    mockModules: { "react-i18next": ENGLISH_I18N_MOCK },
  });
  const { Dialog, DialogContent, DialogDescription, DialogTitle } = await vite.ssrLoadModule(
    "/components/ui/dialog.tsx"
  );
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  const { useToast } = await vite.ssrLoadModule("/components/ui/useToast.ts");
  const h = React.createElement;

  const opens = [];
  let showToast;
  function Host() {
    showToast = useToast().toast;
    return h(
      Dialog,
      { open: true, onOpenChange: (open) => opens.push(open) },
      h(
        DialogContent,
        null,
        h(DialogTitle, null, "Settings"),
        h(DialogDescription, null, "Everything")
      )
    );
  }
  const doc = happyWindow.document;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    await happyWindow.happyDOM.close();
  });
  await React.act(async () => root.render(h(ToastProvider, null, h(Host))));
  await ui.act(() =>
    showToast({ title: "Deleted", duration: 0, actions: [{ label: "Undo", onClick: () => {} }] })
  );
  // Radix starts listening for outside presses a task after it mounts.
  await ui.settle();

  // Radix waits for the click before it dismisses.
  const press = async (element) => {
    await ui.act(() =>
      element.dispatchEvent(new happyWindow.PointerEvent("pointerdown", { bubbles: true }))
    );
    await ui.click(element);
  };
  await press([...doc.querySelectorAll("button")].find((button) => text(button) === "Undo"));
  assert.deepEqual(opens, []);

  await press(container);
  assert.deepEqual(opens, [false]);
});
