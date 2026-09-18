const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// PersonalNotesView keys NoteEditor by note id, so leaving a note whose action
// is still running and coming back mounts this overlay fresh, already in the
// "processing" state. A run that takes minutes (#2142 part 3) is exactly when
// people switch notes, so the overlay must show on a mid-run mount too.
async function renderOverlay(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-action-overlay-remount-test-",
  });
  const mod = await vite.ssrLoadModule("/components/notes/ActionProcessingOverlay.tsx");
  return renderToStaticMarkup(createElement(mod.default, props));
}

test("a mount during a running action shows the action and its progress", async (t) => {
  const html = await renderOverlay(t, {
    state: "processing",
    actionName: "Generate Notes",
    progress: { step: 2, total: 5 },
  });

  assert.match(html, />Generate Notes</);
  assert.match(html, /2/);
  assert.match(html, /5/);
});

test("an idle mount renders nothing", async (t) => {
  const html = await renderOverlay(t, { state: "idle", actionName: null });

  assert.equal(html, "");
});
