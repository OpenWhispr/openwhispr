const React = require("react");
const { createRendererServer } = require("./rendererTestHarness");
const { mountAuditDom } = require("./settingsAuditHarness");

// Shared fixture for the dialog-component tests (dialogReturnFocus,
// settingsAccessibility, dialogRefCleanup): one audit DOM mount
// (mountAuditDom → installBrowserGlobals) plus one Vite server with the common
// react-i18next key passthrough pre-mocked. Callers merge their own mock
// modules over the shared stub (e.g. the real-dictionary translation in
// dialogReturnFocus) and append extra noExternal entries.
async function mountDialogFixture(
  t,
  { cachePrefix, noExternal = [], mockModules = {} } = {}
) {
  const { dom, container, render } = await mountAuditDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: cachePrefix ?? "openwhispr-dialog-fixture-",
    noExternal: ["react-i18next", ...noExternal],
    mockModules: {
      "react-i18next": `export function useTranslation() { return { t: (key) => key }; }`,
      ...mockModules,
    },
  });
  // Radix dispatches its unmount autofocus and portal cleanup from
  // zero-delay timers; every dialog test flushes with the same 20 ms settle.
  const settle = () => React.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return { dom, container, render, vite, settle };
}

module.exports = { mountDialogFixture };
