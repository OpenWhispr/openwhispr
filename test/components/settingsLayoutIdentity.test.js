const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

test("sidebar layout context changes only when the compact breakpoint changes", async (t) => {
  let root;
  const resizeBefore = globalThis.ResizeObserver;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    if (resizeBefore === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = resizeBefore;
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(node) {
      this.node = node;
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next", "@radix-ui/react-dialog"],
    mockModules: {
      "react-i18next": `export const useTranslation=()=>({t:key=>key});`,
      "@radix-ui/react-dialog": `
        import React from "react";
        export const Root=({open,children})=>open?children:null;
        export const Portal=({children})=>children;
        export const Content=({children,ref})=>React.createElement("div",{ref},children);
        export const Overlay=()=>null;
        export const Close=({children})=>React.createElement("button",null,children);
        export const Title=({children})=>React.createElement("h2",null,children);
      `,
      "/components/icons": `export const X=()=>null;`,
      "/ui/useDismissGuard": `export const useDismissGuard=()=>({shouldBlockDismiss:()=>false});`,
    },
  });
  const { default: SidebarModal } = await vite.ssrLoadModule("/components/ui/SidebarModal.tsx");
  const { useSettingsLayout } = await vite.ssrLoadModule("/components/ui/useSettingsLayout.ts");
  const snapshots = [];
  function LayoutReader() {
    snapshots.push(useSettingsLayout());
    return null;
  }
  const children = React.createElement(LayoutReader);
  const noop = () => {};
  root = createRoot(container);
  const render = (section, open = true) =>
    React.act(async () =>
      root.render(
        React.createElement(SidebarModal, {
          open,
          onOpenChange: noop,
          title: "Settings",
          sidebarItems: [
            { id: "speech", label: "Speech", icon: noop },
            { id: "llms", label: "Models", icon: noop },
          ],
          activeSection: section,
          onSectionChange: noop,
          children,
        })
      )
    );
  const resize = (width) =>
    React.act(async () => observers.at(-1).callback([{ contentRect: { width } }]));
  await render("speech");
  const regular = snapshots.at(-1);
  assert.equal(regular.isCompact, false);
  assert.ok(observers[0].node);
  await render("llms");
  await resize(900);
  assert.deepEqual(
    snapshots,
    [regular],
    "navigation and same-mode resize do not broadcast a new context value"
  );
  assert.equal(observers.length, 1);
  await resize(799);
  const compact = snapshots.at(-1);
  assert.equal(compact.isCompact, true);
  assert.notEqual(compact, regular);
  await resize(800);
  assert.equal(snapshots.at(-1).isCompact, false);
  assert.notEqual(snapshots.at(-1), compact);
  const count = snapshots.length;
  await resize(0);
  assert.equal(snapshots.length, count, "zero width keeps the regular-mode rule");
  await render("speech", false);
  assert.equal(observers[0].disconnected, true);
  await render("speech");
  assert.equal(observers.length, 2);
  await React.act(async () => root.unmount());
  root = null;
  assert.equal(observers[1].disconnected, true);
});
