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

test("idle state uses the compact outlined ask capsule", async (t) => {
  const html = await renderBottomBar(t, { isRecording: false });

  assert.ok(html.includes("bg-background shadow-sm"));
  assert.ok(html.includes("h-12"));
  assert.ok(!html.includes("backdrop-blur"));
});

test("the ask capsule never transitions its surface between the two states", async (t) => {
  // transition-all would tween backdrop-filter and background-color for 500ms
  // on every recording start and stop, re-paying the cost this change removes.
  for (const isRecording of [false, true]) {
    const html = await renderBottomBar(t, { isRecording });
    assert.ok(
      html.includes("transition-[height,box-shadow,max-width,opacity]"),
      `capsule transition is property-scoped (isRecording=${isRecording})`
    );
  }
});

test("in-view chat expands the existing capsule around one composer", async (t) => {
  const html = await renderBottomBar(t, {
    chatOpen: true,
    chatContent: createElement("div", null, "Chat"),
  });

  assert.ok(html.includes("rounded-3xl"));
  assert.ok(html.includes("max-w-[600px]"));
  assert.ok(!html.includes("rounded-full border-black/10"), "the panel keeps one radius throughout expansion");
  assert.ok(!html.includes("border-radius,box-shadow"), "height changes do not morph the corners");
  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
});
