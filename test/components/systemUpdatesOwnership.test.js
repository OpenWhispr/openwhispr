const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

test("System update owner mounts on first visit and retains live state and install alert while hidden", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__systemUpdateStore;
    delete globalThis.__systemToggleValues;
    delete globalThis.__systemInstallButton;
    delete globalThis.__systemUpdateLocale;
  });
  const calls = { status: 0, info: 0, listen: 0, dispose: 0, alerts: [], toggles: [] };
  let onAvailable;
  let onDownloaded;
  let onProgress;
  let installButton;
  let confirmed;
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
        getAppVersion: async () => ({ version: "1.2.3" }),
        installUpdate: async () => {},
        onUpdateAvailable: (callback) => {
          onAvailable = callback;
          calls.listen++;
          return () => calls.dispose++;
        },
        onUpdateDownloaded: (callback) => {
          onDownloaded = callback;
          calls.listen++;
          return () => calls.dispose++;
        },
        onUpdateDownloadProgress: (callback) => {
          onProgress = callback;
          calls.listen++;
          return () => calls.dispose++;
        },
      },
    },
  });
  const container = installHostDom(t);
  // Release notes are parsed inertly; the host DOM stub has no parser of its own.
  const { Window } = await import("happy-dom");
  const parserWindow = new Window();
  globalThis.DOMParser = parserWindow.DOMParser;
  t.after(async () => {
    delete globalThis.DOMParser;
    await parserWindow.happyDOM.close();
  });
  globalThis.__systemUpdateLocale = require("zustand").create(() => ({ language: "en" }));
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-system-updates-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export function useTranslation() { const language=globalThis.__systemUpdateLocale(s=>s.language);
          return { t: (key, opts) => language + ":" + key + (opts?.progress ?? "") }; }`,
      "/stores/settingsStore": `
        import { create } from "zustand";
        export const useSettingsStore = create((set) => ({
          autoUpdatesEnabled: true,
          setAutoUpdatesEnabled: (value) => set({ autoUpdatesEnabled: value }),
        }));
        globalThis.__systemUpdateStore = useSettingsStore;
      `,
      "/ui/SettingsSection": `
        import React from "react";
        export const SettingsPanel = ({children}) => React.createElement("div", null, children);
        export const SettingsPanelRow = SettingsPanel;
        export const SettingsRow = ({children, label}) => React.createElement("div", null, label, children);
        export const SectionHeader = ({title}) => React.createElement("h3", null, title);
      `,
      "/ui/button": `
        import React from "react";
        export function Button(props) {
          if (props.className === "w-full" && !props.variant) globalThis.__systemInstallButton = props.onClick;
          return React.createElement("button", null, props.children);
        }
      `,
      "/ui/badge": `export function Badge({children}) { return children; }`,
      "/ui/toggle": `export function Toggle({checked}) {
        globalThis.__systemToggleValues.push(checked);
        return null;
      }`,
      "/ui/useToast": `export function useToast() { return { toast() {} }; }`,
      "/ui/BidiInterpolatedText": `export const BIDI_VALUE_TOKEN = "{value}";
        export function BidiInterpolatedText() { return null; }`,
      "/components/icons": `export const Download = () => null; export const RefreshCw = () => null;`,
    },
  });
  globalThis.__systemToggleValues = calls.toggles;
  const { default: SystemUpdatesKeepAlive } = await vite.ssrLoadModule(
    "/components/settings/SystemUpdates.tsx"
  );
  root = createRoot(container);
  const showAlertDialog = (alert) => calls.alerts.push(alert);
  const showConfirmDialog = (confirm) => {
    confirmed = confirm;
  };
  const render = (active) =>
    React.act(async () =>
      root.render(
        React.createElement(SystemUpdatesKeepAlive, { active, showAlertDialog, showConfirmDialog })
      )
    );

  await render(false);
  assert.deepEqual([calls.status, calls.info, calls.listen], [0, 0, 0]);
  await render(true);
  assert.deepEqual([calls.status, calls.info, calls.listen], [1, 1, 3]);
  assert.match(container.textContent, /settingsPage.general.updates.title/);
  const toggleRenders = calls.toggles.length;
  await React.act(async () => globalThis.__systemUpdateStore.setState({ unrelated: 1 }));
  assert.equal(calls.toggles.length, toggleRenders, "unrelated settings leave System alone");
  await render(false);
  assert.equal(container.firstChild.getAttribute("hidden"), "");
  await React.act(async () =>
    globalThis.__systemUpdateStore.setState({ autoUpdatesEnabled: false })
  );
  assert.equal(calls.toggles.at(-1), false, "hidden update control receives store changes");
  await React.act(async () => onAvailable(null, { version: "2.0" }));
  await React.act(async () => onProgress(null, { percent: 42 }));
  assert.equal(calls.status, 1, "section changes do not reread status");
  assert.match(container.textContent, /42/);
  await render(true);
  assert.deepEqual([calls.status, calls.info, calls.listen], [1, 1, 3]);

  // Update metadata is untrusted: every releaseNotes shape renders as inert text.
  const collectRendered = (root) => {
    const notes = [];
    let hostile = false;
    const walk = (node) => {
      if (["SCRIPT", "IMG", "IFRAME", "A"].includes(node.nodeName)) hostile = true;
      if (String(node.attributes?.class ?? "").includes("whitespace-pre-wrap"))
        notes.push(node.textContent);
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return { notes: notes.join(""), hostile };
  };
  const malicious =
    '<img src="bad" onerror="bad()"><a href="javascript:bad()">run</a><iframe srcdoc="bad"></iframe><script>window.bad=true</script>';
  for (const [notes, expected] of [
    [malicious, "runwindow.bad=true"],
    ["<ul><li>Ordinary <strong>notes</strong></li></ul>\nnext line", "Ordinary notes\nnext line"],
    [
      "<h2>What's new</h2>\n<ul>\n<li>Fix A</li>\n<li>Fix B</li>\n</ul>\n<p>One<br>Two</p>",
      "What's new\nFix A\nFix B\nOne\nTwo",
    ],
    [
      [
        { version: "2", note: "<p>First</p>" },
        { version: "1", note: "Second" },
        { note: null },
        { note: { bad: true } },
        null,
      ],
      "First\nSecond",
    ],
    [null, ""],
    ["", ""],
    ["  ", ""],
    [{ bad: true }, ""],
  ]) {
    await React.act(async () => onAvailable(null, { version: "2", releaseNotes: notes }));
    const rendered = collectRendered(container);
    assert.equal(rendered.notes, expected);
    assert.equal(rendered.hostile, false);
  }

  await React.act(async () => onDownloaded(null, { version: "2.0" }));
  installButton = globalThis.__systemInstallButton;
  assert.equal(typeof installButton, "function");
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let now = 0;
  let nextTimer = 0;
  const advance = async (target) => {
    while (true) {
      const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > target) break;
      now = next[1].due;
      timers.delete(next[0]);
      await React.act(async () => next[1].callback());
    }
    now = target;
  };
  try {
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay !== 10000) return realSetTimeout(callback, delay, ...args);
      const id = ++nextTimer;
      timers.set(id, { callback, due: now + delay });
      return id;
    };
    globalThis.clearTimeout = (id) => {
      if (timers.has(id)) timers.delete(id);
      else realClearTimeout(id);
    };
    await React.act(async () => installButton());
    assert.equal(typeof confirmed?.onConfirm, "function");
    await React.act(async () => confirmed.onConfirm());
    assert.equal(timers.size, 1, "the updater owns the only install deadline");
    await render(false);
    await advance(5000);
    await React.act(async () => globalThis.__systemUpdateLocale.setState({ language: "fr" }));
    assert.match(container.textContent, /fr:settingsPage.general.updates.title/);
    await advance(9999);
    assert.equal(calls.alerts.length, 0, "no alert before the original deadline");
    await advance(10000);
    assert.equal(calls.alerts.length, 1);
    assert.equal(
      calls.alerts[0].title,
      "fr:settingsPage.general.updates.dialogs.almostThere.title"
    );
    assert.equal(
      calls.alerts[0].description,
      "fr:settingsPage.general.updates.dialogs.almostThere.description"
    );
    assert.doesNotMatch(container.textContent, /updates.restarting/);
    assert.equal(timers.size, 0);
    await React.act(async () => globalThis.__systemUpdateLocale.setState({ language: "de" }));
    assert.equal(calls.alerts.length, 1, "locale changes cannot replay the stalled alert");
    await React.act(async () => root.unmount());
    root = null;
    assert.equal(calls.dispose, 3, "last owner releases all update listeners");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  root = createRoot(container);
  await render(false);
  assert.equal(calls.status, 1);
  await render(true);
  // Reopen must not replay a consumed stall alert.
  assert.equal(calls.alerts.length, 1, "a consumed stall alert does not replay on reopen");
});
