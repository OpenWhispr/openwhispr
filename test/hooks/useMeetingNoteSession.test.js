const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("note session ownership survives rerenders and releases on navigation or unmount", async (t) => {
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const closed = [];
  globalThis.window.electronAPI.meetingNoteClosed = async (id) => {
    closed.push(id);
  };
  const vite = await createRendererServer(t, { cachePrefix: "meeting-note-session-" });
  const { useMeetingNoteSession } = await vite.ssrLoadModule("/hooks/useMeetingNoteSession.ts");
  let session;
  function Harness({ view, noteId }) {
    session = useMeetingNoteSession(view, noteId);
    return null;
  }
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
  });
  const render = async (view, noteId) => {
    await React.act(async () =>
      root.render(
        React.createElement(React.StrictMode, null, React.createElement(Harness, { view, noteId }))
      )
    );
  };
  await render("personal-notes", 1);
  session.current = { id: "first", noteId: 1 };
  await render("personal-notes", 1);
  assert.deepEqual(closed, []);
  await render("personal-notes", 2);
  assert.deepEqual(closed, ["first"]);
  session.current = { id: "second", noteId: 2 };
  await render("settings", 2);
  assert.deepEqual(closed, ["first", "second"]);
  await render("personal-notes", 3);
  session.current = { id: "third", noteId: 3 };
  await React.act(async () => root.unmount());
  assert.deepEqual(closed, ["first", "second", "third"]);
  assert.equal(session.current, null);
});

test("a start still running keeps its session until the recording settles", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const closed = [];
  globalThis.window.electronAPI.meetingNoteClosed = async (id) => {
    closed.push(id);
  };
  const vite = await createRendererServer(t, { cachePrefix: "meeting-note-session-start-" });
  const { useMeetingNoteSession } = await vite.ssrLoadModule("/hooks/useMeetingNoteSession.ts");
  const { useMeetingRecordingStore } = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  let session;
  function Harness({ noteId }) {
    session = useMeetingNoteSession("personal-notes", noteId);
    return null;
  }
  root = createRoot(container);
  const render = (noteId) =>
    React.act(async () => root.render(React.createElement(Harness, { noteId })));
  await render(1);
  session.current = { id: "starting", noteId: 1 };
  await React.act(async () => useMeetingRecordingStore.setState({ isRecording: true }));
  await render(2);
  assert.deepEqual(closed, [], "moving on mid-start must not release the hold");
  await React.act(async () => useMeetingRecordingStore.setState({ isRecording: false }));
  assert.deepEqual(closed, ["starting"], "a start that ended releases it");
});
