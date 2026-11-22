const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const fs = require("node:fs");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The call's pill rendered with the English strings.
async function renderPill(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-voice-pill-" });
  const [{ default: i18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!i18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await i18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }
  const { VoicePill } = await vite.ssrLoadModule("/components/agent/VoicePill.tsx");
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(VoicePill, {
      status: "listening",
      readLevel: () => 0,
      waveformActive: true,
      micMuted: false,
      sessionControl: "end",
      settingsOpen: false,
      onSettings: noop,
      onTranscript: noop,
      onMic: noop,
      onEnd: noop,
      onStopReply: noop,
      onLeave: noop,
      ...props,
    })
  );
}

test("the compact pill expands to the transcript, and the transcript's pill minimizes it", async (t) => {
  const compact = await renderPill(t, {});
  assert.match(compact, /aria-label="Expand"/);
  assert.doesNotMatch(compact, /aria-label="Minimize"/);
  const inModal = await renderPill(t, { inModal: true });
  assert.match(inModal, /aria-label="Minimize"/);
  assert.doesNotMatch(inModal, /aria-label="Expand"/);
});

test("a stopped call shows Back to typing in place of its controls", async (t) => {
  const stopped = await renderPill(t, { status: "stopped", inModal: true });
  assert.match(stopped, />Back to typing</, "said in words, not only on hover");
  for (const label of ["Settings", "Minimize", "Turn microphone off", "End call"]) {
    assert.doesNotMatch(stopped, new RegExp(`aria-label="${label}"`));
  }
});
