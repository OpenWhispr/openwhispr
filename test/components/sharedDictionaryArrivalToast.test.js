const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The listener takes the arrival SyncService recorded (the real store helpers
// run) only while the control panel is in front of the user, so a pass that
// lands while it is closed or in the tray still gets its toast later.

const PENDING_KEY = "sharedDictionaryPendingArrival";
const ACCOUNT = "user-a";

async function mountListener(
  t,
  {
    workspaces = [{ id: "ws-1", name: "Acme" }],
    activeWorkspaceId = "ws-1",
    accountId = ACCOUNT,
    focused = true,
    pending = null,
  } = {}
) {
  let root;
  // The main process's sync-event rebroadcast, as preload exposes it.
  const syncListeners = new Set();
  const windowListeners = new Map();
  const authListeners = new Set();
  const calls = { toasts: [], viewWordsClicks: 0 };
  globalThis.__arrival = {
    calls,
    workspaces,
    activeWorkspaceId,
    accountId,
    authListeners,
  };
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__arrival;
  });
  const { storage } = installBrowserGlobals(t, {
    initialStorage: pending ? { [PENDING_KEY]: JSON.stringify(pending) } : {},
    window: {
      addEventListener: (type, listener) => windowListeners.set(type, listener),
      removeEventListener: (type) => windowListeners.delete(type),
      electronAPI: {
        onSyncEvent: (callback) => {
          syncListeners.add(callback);
          return () => syncListeners.delete(callback);
        },
      },
    },
  });
  const container = installHookDom(t);
  const documentListeners = new Map();
  let hasFocus = focused;
  Object.assign(globalThis.document, {
    visibilityState: "visible",
    hasFocus: () => hasFocus,
    addEventListener: (type, listener) => documentListeners.set(type, listener),
    removeEventListener: (type) => documentListeners.delete(type),
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-shared-dictionary-arrival-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export const useTranslation = () => ({
          t: (key, values) => (values ? key + " " + JSON.stringify(values) : key),
        });
      `,
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (props) => globalThis.__arrival.calls.toasts.push(props),
        });
      `,
      // Matches "./workspaceStore" from the shared store and "../stores/…" here.
      "/workspaceStore": `
        export const ACTIVE_WORKSPACE_KEY = "activeWorkspaceId";
        export const readActiveWorkspaceId = () => globalThis.__arrival.activeWorkspaceId;
        export const useWorkspaceStore = {
          getState: () => ({
            workspaces: globalThis.__arrival.workspaces,
            activeWorkspaceId: globalThis.__arrival.activeWorkspaceId,
          }),
          subscribe: () => () => {},
        };
      `,
      "/settingsStore": `
        export const useSettingsStore = {
          getState: () => ({ setSharedDictionaryHints: () => {} }),
        };
      `,
      "/lib/authRequestContext": `
        export const getAuthRequestContextSnapshot = () => ({
          sessionUserId: globalThis.__arrival.accountId,
        });
        export const subscribeAuthRequestContext = (listener) => {
          globalThis.__arrival.authListeners.add(listener);
          return () => globalThis.__arrival.authListeners.delete(listener);
        };
      `,
    },
  });
  const sharedStore = await vite.ssrLoadModule("/stores/sharedDictionaryStore.ts");
  const { default: Listener } = await vite.ssrLoadModule(
    "/components/SharedDictionaryArrivalToastListener.tsx"
  );
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(Listener, {
        onViewWords: () => {
          calls.viewWordsClicks += 1;
        },
      })
    )
  );
  const emit = (name, payload) =>
    React.act(async () => {
      for (const listener of syncListeners) listener({ name, payload });
    });
  // What SyncService does in whichever window ran the pass.
  const arrive = (arrival) => {
    sharedStore.recordSharedDictionaryArrival(arrival);
    return emit("shared-dictionary-arrived", arrival);
  };
  const focus = () =>
    React.act(async () => {
      hasFocus = true;
      windowListeners.get("focus")?.();
    });
  const blur = () => {
    hasFocus = false;
  };
  const resolveAccount = (id) =>
    React.act(async () => {
      globalThis.__arrival.accountId = id;
      for (const listener of authListeners) listener();
    });
  return {
    calls,
    storage,
    sharedStore,
    syncListeners,
    documentListeners,
    windowListeners,
    authListeners,
    arrive,
    emit,
    focus,
    blur,
    resolveAccount,
    unmount: () => React.act(async () => root.unmount()),
  };
}

const arrival = (overrides = {}) => ({
  accountId: ACCOUNT,
  workspaceId: "ws-1",
  count: 127,
  ...overrides,
});

test("an arrival shows the toast with both actions, and View words sets requestedList to allShared", async (t) => {
  const ctx = await mountListener(t);

  await ctx.arrive(arrival());

  assert.equal(ctx.calls.toasts.length, 1);
  const [toast] = ctx.calls.toasts;
  assert.equal(toast.title, 'dictionary.shared.arrival.title {"count":127}');
  assert.equal(toast.description, 'dictionary.shared.arrival.description {"workspace":"Acme"}');
  assert.deepEqual(
    toast.actions.map((action) => action.label),
    ["dictionary.shared.arrival.viewWords", "common.dismiss"]
  );
  assert.equal(ctx.storage.getItem(`sharedDictionaryWelcomed.${ACCOUNT}.ws-1`), "true");
  assert.equal(ctx.storage.getItem(PENDING_KEY), null);
  const store = () => ctx.sharedStore.useSharedDictionaryStore.getState();
  assert.equal(store().requestedList, null, "nothing is requested before the user acts");

  toast.actions[0].onClick();
  assert.equal(store().requestedList, "allShared");
  assert.equal(ctx.calls.viewWordsClicks, 1, "the control panel is sent to the dictionary view");

  assert.doesNotThrow(() => toast.actions[1].onClick());
  assert.equal(ctx.calls.viewWordsClicks, 1, "Dismiss leaves the view alone");

  // Once per account and workspace.
  await ctx.arrive(arrival());
  assert.equal(ctx.calls.toasts.length, 1);
});

test("a workspace the store hasn't loaded gets the neutral description", async (t) => {
  const ctx = await mountListener(t, { workspaces: [], activeWorkspaceId: "ws-9" });

  await ctx.arrive(arrival({ workspaceId: "ws-9", count: 1 }));

  const [toast] = ctx.calls.toasts;
  assert.equal(toast.title, 'dictionary.shared.arrival.title {"count":1}');
  assert.equal(toast.description, "dictionary.shared.arrival.descriptionNoWorkspace");
});

test("an arrival recorded while the panel was closed shows when it mounts", async (t) => {
  const ctx = await mountListener(t, { pending: arrival({ count: 4 }) });

  assert.equal(ctx.calls.toasts.length, 1);
  assert.equal(ctx.calls.toasts[0].title, 'dictionary.shared.arrival.title {"count":4}');
});

test("an arrival waits while the panel is in the tray, and shows once it's focused", async (t) => {
  const ctx = await mountListener(t, { focused: false });

  await ctx.arrive(arrival());
  assert.equal(ctx.calls.toasts.length, 0);
  assert.ok(ctx.storage.getItem(PENDING_KEY), "still pending");
  assert.equal(ctx.storage.getItem(`sharedDictionaryWelcomed.${ACCOUNT}.ws-1`), null);

  await ctx.focus();
  assert.equal(ctx.calls.toasts.length, 1);

  ctx.blur();
  await ctx.focus();
  assert.equal(ctx.calls.toasts.length, 1, "shown once");
});

test("an arrival recorded before the account resolved waits for it", async (t) => {
  const ctx = await mountListener(t, { accountId: null, pending: arrival() });
  assert.equal(ctx.calls.toasts.length, 0);
  assert.ok(ctx.storage.getItem(PENDING_KEY));

  await ctx.resolveAccount(ACCOUNT);
  assert.equal(ctx.calls.toasts.length, 1);
});

test("another account's or workspace's arrival is dropped", async (t) => {
  const ctx = await mountListener(t, { pending: arrival({ accountId: "user-b" }) });
  assert.equal(ctx.calls.toasts.length, 0);
  assert.equal(ctx.storage.getItem(PENDING_KEY), null);

  await ctx.arrive(arrival({ workspaceId: "ws-2" }));
  assert.equal(ctx.calls.toasts.length, 0);
  assert.equal(ctx.storage.getItem(PENDING_KEY), null);
  assert.equal(ctx.storage.getItem(`sharedDictionaryWelcomed.${ACCOUNT}.ws-2`), null);
});

test("a malformed or unrelated event shows nothing, and unmounting stops listening", async (t) => {
  const ctx = await mountListener(t);

  await ctx.emit("shared-dictionary-arrived", undefined);
  await ctx.emit("shared-dictionary-changed", { workspaceId: "ws-1" });
  ctx.storage.setItem(PENDING_KEY, JSON.stringify(arrival({ count: 0 })));
  await ctx.emit("shared-dictionary-arrived", arrival({ count: 0 }));
  assert.equal(ctx.calls.toasts.length, 0);
  assert.equal(ctx.syncListeners.size, 1);

  await ctx.unmount();
  assert.equal(ctx.syncListeners.size, 0);
  assert.equal(ctx.authListeners.size, 0);
  assert.equal(ctx.documentListeners.has("visibilitychange"), false);
  assert.equal(ctx.windowListeners.has("focus"), false);
});
