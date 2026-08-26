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
      isProcessing: false,
      onStartRecording: () => {},
      onStopRecording: () => {},
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

test("idle state keeps the liquid-glass capsule", async (t) => {
  const html = await renderBottomBar(t, { isRecording: false });

  assert.ok(html.includes("backdrop-blur-xl"));
  assert.ok(html.includes("backdrop-saturate-150"));
});

test("the ask capsule never transitions its surface between the two states", async (t) => {
  // transition-all would tween backdrop-filter and background-color for 500ms
  // on every recording start and stop, re-paying the cost this change removes.
  for (const isRecording of [false, true]) {
    const html = await renderBottomBar(t, { isRecording });
    assert.ok(
      html.includes("transition-[max-width,opacity,padding,border-color,box-shadow]"),
      `capsule transition is property-scoped (isRecording=${isRecording})`
    );
  }
});
