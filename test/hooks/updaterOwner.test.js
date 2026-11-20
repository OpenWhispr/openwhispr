const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { installBrowserGlobals, installHookDom } = require("../lib/rendererTestHarness");

test("update hook shares listeners, but each mounted owner reads initial status", async (t) => {
  const calls = { status: 0, info: 0, listen: 0, dispose: 0 };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getUpdateStatus: async () => {
          calls.status++;
          return {
            updateAvailable: false,
            updateDownloaded: false,
            isDevelopment: false,
            isSupported: true,
          };
        },
        getUpdateInfo: async () => {
          calls.info++;
          return null;
        },
        onUpdateAvailable: () => {
          calls.listen++;
          return () => calls.dispose++;
        },
      },
    },
  });
  const container = installHookDom(t);
  const { useUpdater } = require("../../src/hooks/useUpdater.ts");
  let root = createRoot(container);
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  function Owner() {
    useUpdater();
    return null;
  }
  const render = (second) =>
    React.act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Owner, { key: "control" }),
          second && React.createElement(Owner, { key: "settings" })
        )
      )
    );

  await render(false);
  assert.deepEqual(calls, { status: 1, info: 1, listen: 1, dispose: 0 });
  await render(true);
  assert.deepEqual(calls, { status: 2, info: 2, listen: 1, dispose: 0 });
  await render(false);
  assert.equal(calls.dispose, 0, "the control owner keeps the shared listener");
  await React.act(async () => root.unmount());
  root = null;
  assert.equal(calls.dispose, 1);
});

test("late StrictMode update snapshots cannot undo a downloaded event", async (t) => {
  const statusReplies = [];
  const infoReplies = [];
  let downloadedListener;
  let disposals = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getUpdateStatus: () => new Promise((resolve) => statusReplies.push(resolve)),
        getUpdateInfo: () => new Promise((resolve) => infoReplies.push(resolve)),
        onUpdateDownloaded: (listener) => {
          downloadedListener = listener;
          return () => disposals++;
        },
      },
    },
  });
  const container = installHookDom(t);
  const { useUpdater } = require("../../src/hooks/useUpdater.ts");
  let current;
  function Owner() {
    const { status, info } = useUpdater();
    current = { status, info };
    return null;
  }
  let root = createRoot(container);
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  await React.act(async () =>
    root.render(React.createElement(React.StrictMode, null, React.createElement(Owner)))
  );
  assert.equal(statusReplies.length, 2, "StrictMode restarts the request Effect");
  assert.equal(disposals, 1, "the first setup releases its listener");

  await React.act(async () => downloadedListener(null, { version: "new" }));
  assert.equal(current.status.updateDownloaded, true);
  await React.act(async () => {
    for (const reply of statusReplies) {
      reply({
        updateAvailable: false,
        updateDownloaded: false,
        isDevelopment: false,
        isSupported: true,
      });
    }
  });
  assert.equal(current.status.updateDownloaded, true, "late status must not roll back the event");
  assert.equal(infoReplies.length, 1, "an unmounted setup must not chain another request");
  await React.act(async () => infoReplies[0]({ version: "old" }));
  assert.equal(current.info.version, "new", "late info must not replace event info");
  await React.act(async () => root.unmount());
  root = null;
  assert.equal(disposals, 2);
});
