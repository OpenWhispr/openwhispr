const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// A fresh mount *is* the note switch: PersonalNotesView keys NoteEditor by note
// id, so leaving a recording note and coming back remounts this control. While
// the elapsed seconds were counted interval ticks, that restarted the timer at
// 00:00; deriving them from the session's start timestamp does not.
async function renderRecordControl(t, { elapsedMs, isRecording = true }) {
  installBrowserGlobals(t);
  // The store's stamp is resolved when the component reads it, not when this
  // harness is built: standing up the renderer server takes seconds, and a
  // timestamp fixed here would drift the expected elapsed value.
  globalThis.__recordingElapsedMs = elapsedMs;
  t.after(() => {
    delete globalThis.__recordingElapsedMs;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-record-control-timer-test-",
    mockModules: {
      "/stores/meetingRecordingStore": `
        const state = {
          currentMicLevel: 0,
          get recordingStartedAt() {
            const elapsed = globalThis.__recordingElapsedMs;
            return elapsed == null ? null : Date.now() - elapsed;
          },
        };
        export const getMicAnalyser = () => null;
        export const useMeetingRecordingStore = (selector) => selector(state);
        useMeetingRecordingStore.getState = () => state;
      `,
    },
  });
  const mod = await vite.ssrLoadModule("/components/notes/NoteRecordControl.tsx");
  return renderToStaticMarkup(
    createElement(mod.default, {
      isRecording,
      isProcessing: false,
      onStart: () => {},
      onStop: () => {},
    })
  );
}

test("a remounted control shows the running session's real elapsed time", async (t) => {
  const html = await renderRecordControl(t, { elapsedMs: 65_000 });

  assert.match(html, />01:05</, "a remount keeps the session's elapsed time");
  assert.doesNotMatch(html, />00:00</, "a remount must not restart the timer at zero");
});

test("a session that has just started shows no elapsed time yet", async (t) => {
  const html = await renderRecordControl(t, { elapsedMs: 0 });

  assert.match(html, />00:00</);
});

test("an idle control renders no timer at all", async (t) => {
  const html = await renderRecordControl(t, { elapsedMs: null, isRecording: false });

  assert.ok(!html.includes("tabular-nums"), "the idle button is a mic, not a timer pill");
});
