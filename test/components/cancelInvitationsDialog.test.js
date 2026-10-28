const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

const WORKSPACE = { id: "w1", name: "Acme" };
const invitation = (id) => ({
  id,
  email: `${id}@example.com`,
  workspace_role: "member",
  team_ids: [],
  invited_by_user_id: "u1",
  expires_at: "2027-01-01T00:00:00.000Z",
  created_at: "2026-10-01T00:00:00.000Z",
  accepted_at: null,
  revoked_at: null,
});
const INVITATIONS = [invitation("a"), invitation("b"), invitation("c")];
const outcome = ({ done = [], failed = [] } = {}) => ({ done, noEmail: [], failed });
const failure = (id, kind = "failed") => ({ id, error: { kind } });

const GLOBALS = ["__actionDialogProps", "__toasts", "__cancelCalls", "__cancelImpl"];

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.childNodes].map(textOf).join("");
}

async function loadDialog(t) {
  // Registered before the browser globals, so roots unmount while `window` still exists.
  const roots = [];
  t.after(async () => {
    for (const root of roots) await React.act(async () => root.unmount());
    for (const key of GLOBALS) delete globalThis[key];
  });
  installBrowserGlobals(t);
  globalThis.__toasts = [];
  globalThis.__cancelCalls = [];
  globalThis.__cancelImpl = async (ids) => outcome({ done: ids });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cancel-invitations-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
        }
      `,
      "/ui/useToast": `
        export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });
      `,
      "/services/bulkInvitationActions": `
        export const bulkInvitationActions = {
          cancelInvitations: (workspaceId, ids, signal) => {
            globalThis.__cancelCalls.push([workspaceId, ids, signal]);
            return globalThis.__cancelImpl(ids);
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
  const { CancelInvitationsDialog } = await vite.ssrLoadModule(
    "/components/workspace/CancelInvitationsDialog.tsx"
  );
  const { confirmActionReducer } = await vite.ssrLoadModule("/lib/confirmActionFlow.ts");

  // Drives the dialog with the real reducer, as the Invitations tab does.
  const mount = async (initial) => {
    const events = [];
    const canceled = [];
    let send;
    function Harness() {
      const [state, dispatch] = React.useReducer(confirmActionReducer, initial);
      const record = React.useCallback((event) => {
        events.push(event);
        dispatch(event);
      }, []);
      send = record;
      return React.createElement(CancelInvitationsDialog, {
        workspace: WORKSPACE,
        state,
        dispatch: record,
        onCanceled: (ids) => canceled.push(ids),
      });
    }
    const container = installHostDom(t);
    const root = createRoot(container);
    roots.push(root);
    await React.act(async () => root.render(React.createElement(Harness)));
    return {
      events,
      canceled,
      text: () => textOf(container),
      send: (event) => React.act(async () => send(event)),
      clickPrimary: () => React.act(async () => globalThis.__actionDialogProps.primary.onClick()),
    };
  };
  const confirming = (subject = INVITATIONS) => ({ kind: "confirm", subject });
  return { mount, confirming };
}

test("closed renders nothing", async (t) => {
  const { mount } = await loadDialog(t);

  const view = await mount({ kind: "closed" });

  assert.equal(view.text(), "");
});

test("confirm offers Keep invitations", async (t) => {
  const { mount, confirming } = await loadDialog(t);

  const view = await mount(confirming());

  const text = view.text();
  assert.match(text, /workspaces\.cancelInvitations\.title\|\{"count":3\}/);
  assert.match(text, /workspaces\.cancelInvitations\.body/);
  assert.match(text, /\[workspaces\.cancelInvitations\.confirm\]/);
  assert.match(text, /\{workspaces\.cancelInvitations\.keep\}/);
  assert.doesNotMatch(text, /common\.cancel/);
  assert.equal(globalThis.__actionDialogProps.icon, "trash");
  assert.equal(globalThis.__actionDialogProps.primary.tone, "destructive");
});

test("canceling is busy", async (t) => {
  const { mount, confirming } = await loadDialog(t);
  let finish;
  globalThis.__cancelImpl = () => new Promise((resolve) => (finish = resolve));

  const view = await mount(confirming());
  await view.clickPrimary();

  assert.match(view.text(), /workspaces\.cancelInvitation\.canceling/);
  assert.doesNotMatch(view.text(), /workspaces\.cancelInvitations\.keep/);
  assert.equal(globalThis.__actionDialogProps.busy, true);
  await React.act(async () => finish(outcome({ done: ["a", "b", "c"] })));
});

test("partial failure keeps the dialog with the count and Try again", async (t) => {
  const { mount, confirming } = await loadDialog(t);
  globalThis.__cancelImpl = async () =>
    outcome({ done: ["a"], failed: [failure("b", "refused"), failure("c")] });

  const view = await mount(confirming());
  await view.clickPrimary();

  const text = view.text();
  assert.match(text, /!workspaces\.cancelInvitations\.partial\|\{"count":2\}/);
  assert.match(text, /\[workspaces\.exit\.tryAgain\]/);
  assert.match(text, /workspaces\.cancelInvitations\.title\|\{"count":2\}/);
  assert.match(text, /\{workspaces\.cancelInvitations\.keep\}/);
  assert.equal(globalThis.__toasts.length, 0);
  // The tab hears about the one that went through right away, so its list reloads.
  assert.deepEqual(view.canceled, [["a"]]);
  assert.deepEqual(
    view.events.map((event) => event.type),
    ["confirm", "failed"]
  );
});

test("try again cancels only what failed", async (t) => {
  const { mount, confirming } = await loadDialog(t);
  globalThis.__cancelImpl = async () =>
    outcome({ done: ["a"], failed: [failure("b"), failure("c")] });
  const view = await mount(confirming());
  await view.clickPrimary();
  globalThis.__cancelImpl = async (ids) => outcome({ done: ids });

  await view.clickPrimary();

  assert.deepEqual(
    globalThis.__cancelCalls.map(([workspaceId, ids]) => [workspaceId, ids]),
    [
      ["w1", ["a", "b", "c"]],
      ["w1", ["b", "c"]],
    ]
  );
});

test("all canceled toasts the total and reports the ids", async (t) => {
  const { mount, confirming } = await loadDialog(t);
  globalThis.__cancelImpl = async () =>
    outcome({ done: ["a"], failed: [failure("b"), failure("c")] });
  const view = await mount(confirming());
  await view.clickPrimary();
  globalThis.__cancelImpl = async (ids) => outcome({ done: ids });

  await view.clickPrimary();

  // The one from the first try and the two from the second.
  assert.deepEqual(globalThis.__toasts, [
    { title: 'workspaces.cancelInvitations.done|{"count":3}' },
  ]);
  assert.deepEqual(view.canceled, [["a"], ["b", "c"]]);
  assert.equal(view.text(), "");
  assert.deepEqual(
    view.events.map((event) => event.type),
    ["confirm", "failed", "confirm", "succeeded"]
  );
});

test("lost permission and required single sign-on say so instead of blaming the connection", async (t) => {
  const { mount, confirming } = await loadDialog(t);
  globalThis.__cancelImpl = async () =>
    outcome({ failed: [failure("a", "notAllowed"), failure("b", "notAllowed")] });
  const view = await mount(confirming([invitation("a"), invitation("b")]));
  await view.clickPrimary();

  assert.match(view.text(), /!workspaces\.cancelInvitation\.notAllowed\|/);
  assert.doesNotMatch(view.text(), /cancelInvitations\.partial/);
  assert.deepEqual(view.canceled, []);

  globalThis.__cancelImpl = async () =>
    outcome({ failed: [failure("a", "ssoRequired"), failure("b", "ssoRequired")] });
  await view.clickPrimary();

  assert.match(view.text(), /!workspaces\.ssoRequired\|/);
});

test("a dialog opened again starts from its own selection", async (t) => {
  const { mount, confirming } = await loadDialog(t);
  globalThis.__cancelImpl = async () => outcome({ failed: [failure("a")] });
  const view = await mount(confirming([invitation("a"), invitation("b")]));
  await view.clickPrimary();
  globalThis.__cancelImpl = async (ids) => outcome({ done: ids });

  await view.send({ type: "dismiss" });
  await view.send({ type: "open", subject: [invitation("x"), invitation("y"), invitation("z")] });

  assert.match(view.text(), /workspaces\.cancelInvitations\.title\|\{"count":3\}/);
  await view.clickPrimary();
  assert.deepEqual(globalThis.__cancelCalls.at(-1)[1], ["x", "y", "z"]);
  assert.deepEqual(globalThis.__toasts, [
    { title: 'workspaces.cancelInvitations.done|{"count":3}' },
  ]);
});
