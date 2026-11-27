const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function renderMuteButton(t, micMuted, micCaptureStatus = "active") {
  installBrowserGlobals(t);
  globalThis.__micMuted = micMuted;
  globalThis.__micCaptureStatus = micCaptureStatus;
  t.after(() => {
    delete globalThis.__micMuted;
    delete globalThis.__micCaptureStatus;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-mic-mute-button-test-",
    mockModules: {
      "/stores/meetingRecordingStore": `
        const state = {
          get micMuted() { return globalThis.__micMuted; },
          get micCaptureStatus() { return globalThis.__micCaptureStatus; },
        };
        export const setMicMuted = () => {};
        export const useMeetingRecordingStore = (selector) => selector(state);
        useMeetingRecordingStore.getState = () => state;
      `,
    },
  });
  const mod = await vite.ssrLoadModule("/components/notes/MicMuteButton.tsx");
  return renderToStaticMarkup(createElement(mod.default));
}

test("offers to mute while the microphone is live", async (t) => {
  const html = await renderMuteButton(t, false);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /aria-label="notes.editor.muteMic"/);
  assert.match(html, /data-icon="mic"/);
});

test("shows the muted state and offers to unmute", async (t) => {
  const html = await renderMuteButton(t, true);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /aria-label="notes.editor.unmuteMic"/);
  assert.match(html, /data-icon="mic-off"/);
});

test("hides while no microphone is open", async (t) => {
  const html = await renderMuteButton(t, false, "inactive");
  assert.equal(html, "");
});
