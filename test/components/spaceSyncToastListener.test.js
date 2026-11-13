const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("retired device-only migration events do not announce a backup policy change", async (t) => {
  let listener;
  let disposed = false;
  const toasts = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onSyncEvent(callback) {
          listener = callback;
          return () => {
            disposed = true;
          };
        },
      },
      recordToast: (toast) => toasts.push(toast),
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-private-retention-toast-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next":
        "const t=(key,options)=>({key,options}); export function useTranslation(){return {t,i18n:{resolvedLanguage:'en'}};}",
      "../ui/useToast": "export function useToast(){return {toast: window.recordToast};}",
      "../../stores/noteStore": "export function readPurgeDisplacedNote(){return null;}",
    },
  });
  const { default: Listener } = await vite.ssrLoadModule(
    "/components/notes/SpaceSyncToastListener.tsx"
  );
  const root = createRoot(container);
  t.after(() => React.act(async () => root.unmount()));
  await React.act(async () => root.render(React.createElement(Listener)));

  for (const purgeAfter of [null, "2026-12-01T00:00:00.000Z"]) {
    listener({ name: "private-notes-on-device", payload: { purgeAfter } });
  }
  assert.deepEqual(toasts, []);
  await React.act(async () => root.unmount());
  assert.equal(disposed, true);
});
