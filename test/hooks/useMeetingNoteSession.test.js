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
