const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

const KEY = "settingsPage.workspace.guests.remove";
const WORKSPACE = { id: "w1", name: "Acme" };
const note = (id, visibility = "invited") => ({ id, title: id, permission: "viewer", visibility });
const guest = (email, name, notes = [note("n1")]) => ({ email, name, image: null, notes });
const GLOBALS = ["__actionDialogProps", "__toasts", "__removeCalls", "__removeImpl"];

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.childNodes].map(textOf).join("");
}

async function loadDialog(t) {
  const roots = [];
  t.after(async () => {
    for (const root of roots) await React.act(async () => root.unmount());
    for (const key of GLOBALS) delete globalThis[key];
  });
  installBrowserGlobals(t);
  globalThis.__toasts = [];
  globalThis.__removeCalls = [];
  globalThis.__removeImpl = async (_id, input) => ({
    removed: input.emails,
    not_found: [],
    skipped_members: [],
    link_shared_note_ids: [],
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-remove-guests-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
        }
      `,
      "/i18n": "export default { t: (key) => key };",
      "/ui/useToast": `
        export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });
      `,
      "/services/GuestsService": `
        export const GuestsService = {
          remove: (workspaceId, input) => {
            globalThis.__removeCalls.push([workspaceId, input]);
            return globalThis.__removeImpl(workspaceId, input);
          },
        };
      `,
      "/WorkspaceActionDialog": `
        import React from "react";
        export function WorkspaceActionDialog(props) {
          globalThis.__actionDialogProps = props;
          return React.createElement(
            "div",
            { "data-icon": props.icon },
            React.createElement("h2", null, props.title),
            React.createElement("p", null, props.body),
            props.error ? React.createElement("p", { role: "alert" }, "!" + props.error) : null,
            React.createElement("button", null, "[" + props.primary.label + "]"),
            props.cancelLabel && !props.busy
              ? React.createElement("button", null, "{" + props.cancelLabel + "}")
              : null
          );
        }
      `,
    },
  });
  const { RemoveGuestsDialog } = await vite.ssrLoadModule(
    "/components/workspace/RemoveGuestsDialog.tsx"
  );
  const mount = async (guests) => {
    const removed = [];
    const openChanges = [];
    const container = installHostDom(t);
    const root = createRoot(container);
    roots.push(root);
    await React.act(async () =>
      root.render(
        React.createElement(RemoveGuestsDialog, {
          open: true,
          onOpenChange: (open) => openChanges.push(open),
          workspace: WORKSPACE,
          guests,
          onRemoved: (result) => removed.push(result),
        })
      )
    );
    return {
      removed,
      openChanges,
      text: () => textOf(container),
      clickPrimary: () => React.act(async () => globalThis.__actionDialogProps.primary.onClick()),
      dismiss: () => React.act(async () => globalThis.__actionDialogProps.onDismiss()),
    };
  };
  return { mount };
}

test("remove asks first and names the guest", async (t) => {
  const { mount } = await loadDialog(t);
  const view = await mount([guest("jin@x.com", "Jin")]);
  const text = view.text();
  assert.match(text, new RegExp(`${KEY}\\.titleOne\\|\\{"name":"[^"]*Jin[^"]*","workspace"`));
  assert.match(text, new RegExp(`${KEY}\\.body`));
  assert.match(text, new RegExp(`\\[${KEY}\\.confirmOne\\]`));
  assert.equal(globalThis.__actionDialogProps.primary.tone, "destructive");
  assert.equal(globalThis.__removeCalls.length, 0);
});

test("several guests use the count title", async (t) => {
  const { mount } = await loadDialog(t);
  const view = await mount([guest("a@x.com", "A"), guest("b@x.com", null)]);
  assert.match(view.text(), new RegExp(`${KEY}\\.title\\|\\{"count":2,`));
});

test("the link line shows only when a note is shared by link", async (t) => {
  const { mount } = await loadDialog(t);
  const plain = await mount([guest("a@x.com", "A")]);
  assert.doesNotMatch(plain.text(), /remove\.linkShared/);
  const linked = await mount([guest("a@x.com", "A", [note("n1", "link")])]);
  assert.match(linked.text(), /remove\.linkShared/);
});

test("confirming removes, toasts, reports and closes", async (t) => {
  const { mount } = await loadDialog(t);
  const view = await mount([guest("a@x.com", "A"), guest("b@x.com", "B")]);
  await view.clickPrimary();
  assert.deepEqual(globalThis.__removeCalls, [["w1", { emails: ["a@x.com", "b@x.com"] }]]);
  assert.equal(view.removed.length, 1);
  assert.deepEqual(view.removed[0].removed, ["a@x.com", "b@x.com"]);
  assert.deepEqual(view.openChanges, [false]);
  assert.match(globalThis.__toasts[0].title, new RegExp(`${KEY}\\.done\\|\\{"count":2\\}`));
});

test("skipped members aren't counted as removed in the toast", async (t) => {
  const { mount } = await loadDialog(t);
  globalThis.__removeImpl = async () => ({
    removed: ["a@x.com"],
    not_found: [],
    skipped_members: ["b@x.com"],
    link_shared_note_ids: [],
  });
  const view = await mount([guest("a@x.com", "A"), guest("b@x.com", "B")]);
  await view.clickPrimary();
  assert.match(globalThis.__toasts[0].title, /"count":1\}/);
});

test("a failure keeps the dialog with Try again", async (t) => {
  const { mount } = await loadDialog(t);
  globalThis.__removeImpl = async () => {
    throw new Error("offline");
  };
  const view = await mount([guest("a@x.com", "A")]);
  await view.clickPrimary();
  const text = view.text();
  assert.match(text, new RegExp(`!${KEY}\\.failed`));
  assert.match(text, /\[workspaces\.exit\.tryAgain\]/);
  assert.deepEqual(view.openChanges, []);
  assert.equal(view.removed.length, 0);
  assert.equal(globalThis.__toasts.length, 0);

  globalThis.__removeImpl = async (_id, input) => ({
    removed: input.emails,
    not_found: [],
    skipped_members: [],
    link_shared_note_ids: [],
  });
  await view.clickPrimary();
  assert.equal(globalThis.__removeCalls.length, 2);
  assert.deepEqual(view.openChanges, [false]);
});

test("Cancel sends nothing", async (t) => {
  const { mount } = await loadDialog(t);
  const view = await mount([guest("a@x.com", "A")]);
  assert.match(view.text(), /\{common\.cancel\}/);
  await view.dismiss();
  assert.equal(globalThis.__removeCalls.length, 0);
  assert.deepEqual(view.openChanges, [false]);
});
