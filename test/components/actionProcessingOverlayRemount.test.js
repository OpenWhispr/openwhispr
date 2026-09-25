const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// PersonalNotesView keys NoteEditor by note id, so leaving a note whose action
// is still running and coming back mounts this overlay fresh, already in the
// "processing" state. A run that takes minutes (#2142 part 3) is exactly when
// people switch notes, so the overlay must show on a mid-run mount too.
// The harness renders i18n keys verbatim, so assertions match on the keys.
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
  assert.match(html, />notes\.actions\.chunkProgress</);
});

test("a single-request action shows no part progress", async (t) => {
  const html = await renderOverlay(t, { state: "processing", actionName: "Generate Notes" });

  assert.doesNotMatch(html, /chunkProgress/);
});

test("a running action offers a cancel control", async (t) => {
  const html = await renderOverlay(t, {
    state: "processing",
    actionName: "Generate Notes",
    onCancel: () => {},
  });

  assert.match(html, /<button[^>]*>common\.cancel</);
});

test("the success state offers no cancel control", async (t) => {
  const html = await renderOverlay(t, {
    state: "success",
    actionName: "Generate Notes",
    onCancel: () => {},
  });

  assert.doesNotMatch(html, /common\.cancel/);
});

test("an idle mount renders nothing", async (t) => {
  const html = await renderOverlay(t, { state: "idle", actionName: null });

  assert.equal(html, "");
});
