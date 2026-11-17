const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadDialog(t) {
  t.after(() => {
    delete globalThis.__onOpenChange;
    delete globalThis.__onOpenAutoFocus;
  });
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-action-dialog-",
    mockModules: {
      // Renders the dialog open and hands the test its dismissal callback.
      "/ui/dialog": `
        import React from "react";
        export const Dialog = ({ children, onOpenChange }) => {
          globalThis.__onOpenChange = onOpenChange;
          return React.createElement("div", null, children);
        };
        export const DialogContent = ({ children, onOpenAutoFocus }) => {
          globalThis.__onOpenAutoFocus = onOpenAutoFocus;
          return React.createElement("div", null, children);
        };
        export const DialogTitle = ({ children }) => React.createElement("h2", null, children);
        export const DialogDescription = ({ children }) => React.createElement("p", null, children);
      `,
    },
  });
  const { WorkspaceActionDialog } = await vite.ssrLoadModule(
    "/components/workspace/WorkspaceActionDialog.tsx"
  );
  const render = (overrides = {}) =>
    renderToStaticMarkup(
      createElement(WorkspaceActionDialog, {
        open: true,
        icon: "info",
        title: "Leave Acme?",
        body: "You will lose access.",
        primary: { label: "Leave workspace", onClick: () => {}, tone: "primary" },
        cancelLabel: "common.cancel",
        onDismiss: () => {},
        ...overrides,
      })
    );
  return { render };
}

const primaryButton = (markup) => markup.match(/<button[^>]*>Leave workspace<\/button>/)?.[0] ?? "";

test("renders title, body and both buttons", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render();

  assert.match(markup, /Leave Acme\?/);
  assert.match(markup, /You will lose access\./);
  assert.match(markup, /Leave workspace/);
  assert.match(markup, /common\.cancel/);
});

test("busy hides Cancel and disables the primary", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ busy: true });

  assert.doesNotMatch(markup, /common\.cancel/);
  assert.match(primaryButton(markup), /disabled=""/);
});

test("busy blocks dismissal", async (t) => {
  const { render } = await loadDialog(t);
  let dismissed = 0;
  const onDismiss = () => dismissed++;

  render({ busy: true, onDismiss });
  globalThis.__onOpenChange(false);
  assert.equal(dismissed, 0);

  render({ busy: false, onDismiss });
  globalThis.__onOpenChange(false);
  assert.equal(dismissed, 1);
});

test("error renders as an alert", async (t) => {
  const { render } = await loadDialog(t);

  assert.match(render({ error: "boom" }), /role="alert"[^>]*>boom/);
  assert.doesNotMatch(render({ error: null }), /role="alert"/);
});

test("destructive tone uses the destructive fill", async (t) => {
  const { render } = await loadDialog(t);

  const destructive = primaryButton(
    render({ primary: { label: "Leave workspace", onClick: () => {}, tone: "destructive" } })
  );
  const plain = primaryButton(render());

  assert.match(destructive, /bg-destructive/);
  assert.doesNotMatch(plain, /bg-destructive/);
  assert.match(plain, /bg-primary/);
});

test("omitting cancelLabel renders no Cancel button", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ cancelLabel: undefined });

  assert.equal((markup.match(/<button/g) ?? []).length, 1);
});

test("a destructive dialog moves initial focus off the primary", async (t) => {
  const { render } = await loadDialog(t);
  const destructive = { label: "Leave workspace", onClick: () => {}, tone: "destructive" };
  const openEvent = () => {
    const event = { prevented: false, preventDefault: () => (event.prevented = true) };
    return event;
  };

  // The handler takes over Radix's default (first focusable = the primary), so
  // Enter on a fresh dialog can't confirm a delete or leave.
  render({ primary: destructive });
  const event = openEvent();
  globalThis.__onOpenAutoFocus(event);
  assert.equal(event.prevented, true);

  // Without a Cancel to land on, or with a non-destructive primary, Radix keeps its default.
  render({ primary: destructive, cancelLabel: undefined });
  assert.equal(globalThis.__onOpenAutoFocus, undefined);
  render();
  assert.equal(globalThis.__onOpenAutoFocus, undefined);
  render({ primary: destructive, busy: true });
  assert.equal(globalThis.__onOpenAutoFocus, undefined);
});

test("a pending primary shows a spinner before its label", async (t) => {
  const { render } = await loadDialog(t);
  const primary = { label: "Leave workspace", onClick: () => {}, tone: "primary" };

  const pending = render({ primary: { ...primary, pending: true } });

  assert.match(
    pending,
    /<button[^>]*><svg[^>]*animate-spin[\s\S]*?<\/svg>Leave workspace<\/button>/
  );
  assert.doesNotMatch(render({ primary }), /animate-spin/);
});
