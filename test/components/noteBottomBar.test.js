const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Assertions are class-based, so the untranslated i18n fallback (raw keys) is fine.
async function renderBottomBar(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-bottom-bar-test-",
    mockModules: {
      "/ui/useToast": `export const useToast = () => ({ toast: () => {} });`,
      "/useVoiceDraft": `
        export const useVoiceDraft = () => ({ status: "idle", streamingOnlyProvider: false });
      `,
      "/stores/meetingRecordingStore": `
        export const getMicAnalyser = () => null;
        export const useMeetingRecordingStore = { getState: () => ({ currentMicLevel: 0 }) };
      `,
    },
  });
  const mod = await vite.ssrLoadModule("/components/notes/NoteBottomBar.tsx");
  return renderToStaticMarkup(
    createElement(mod.default, {
      isRecording: false,
      draftText: "",
      onDraftChange: () => {},
      onAskSubmit: () => {},
      ...props,
    })
  );
}

test("recording state renders no backdrop-filter surface over the live transcript", async (t) => {
  const html = await renderBottomBar(t, { isRecording: true });

  // The 1.9.0 CPU regression: every transcript partial re-blurred the strip.
  assert.ok(!html.includes("backdrop-blur"), "no backdrop-blur while recording");
  assert.ok(!html.includes("backdrop-saturate"), "no backdrop-saturate while recording");
  assert.ok(html.includes("bg-surface-2/95"), "capsules use the near-opaque surface");
  assert.ok(html.includes("shadow-(--shadow-glass)"), "capsules keep the glass rim shadow");
});

test("in-view chat expands the existing capsule around one composer", async (t) => {
  const html = await renderBottomBar(t, {
    chatOpen: true,
    chatContent: createElement("div", null, "Chat"),
  });

  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
});

test("the action chips sit above the composer, inside the chat once it opens", async (t) => {
  const props = {
    chatContent: createElement("div", null, "Previous conversation"),
    actionChips: createElement("button", null, "All actions"),
    callout: createElement("button", null, "Generate summary"),
  };
  const closed = await renderBottomBar(t, { ...props, chatOpen: false });

  assert.ok(closed.includes("Generate summary"));
  assert.ok(
    closed.indexOf("All actions") < closed.indexOf("<textarea"),
    "the chips sit above the composer"
  );

  const open = await renderBottomBar(t, { ...props, chatOpen: true });
  assert.equal(open.split("All actions").length, 2, "the chips show once");
  assert.ok(
    open.indexOf("Previous conversation") < open.indexOf("All actions") &&
      open.indexOf("All actions") < open.indexOf("<textarea"),
    "an open chat keeps the chips, between its messages and the composer"
  );
});
