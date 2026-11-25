const test = require("node:test");
const assert = require("node:assert/strict");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

test("the return-to-recording button describes the current microphone status", async (t) => {
  const browser = await installHappyDom(t);
  const { document } = browser;
  browser.happyDOM.setURL("http://localhost/?panel=true");
  const vite = await createRendererServer(t);
  const { useMeetingRecordingStore } = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { default: Pill } = await vite.ssrLoadModule("/components/notes/MeetingRecordingPill.tsx");
  useMeetingRecordingStore.setState({
    isRecording: true,
    recordingNoteTitle: "Standup",
    micMuted: true,
  });
  const root = createRoot(document.createElement("div"));
  try {
    await act(() =>
      root.render(
        createElement(Pill, { activeView: "home", activeNoteId: null, onReturnToNote() {} })
      )
    );
    const button = document.querySelector('button[aria-label="Return to recording"]');
    assert.ok(button);
    const description = () =>
      document.getElementById(button.getAttribute("aria-describedby"))?.textContent;
    assert.equal(description(), "Microphone muted");

    await act(() => useMeetingRecordingStore.setState({ micMuted: false }));
    assert.notEqual(description(), "Microphone muted");
    assert.equal(button.textContent, "Standup");
  } finally {
    await act(() => root.unmount());
  }
});
