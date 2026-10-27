const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const MEMBER = { user_id: "u-mia", name: "Mia Member", email: "mia@example.com", role: "member" };

async function loadDialog(t) {
  t.after(() => {
    for (const key of ["__actionDialogProps", "__toasts", "__removeCalls", "__removeImpl"]) {
      delete globalThis[key];
    }
  });
  installBrowserGlobals(t);
  globalThis.__toasts = [];
  globalThis.__removeCalls = [];
  globalThis.__removeImpl = async () => "removed";
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-remove-member-dialog-",
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
      "/services/workspaceActions": `
        export const removeMember = (workspaceId, userId) => {
          globalThis.__removeCalls.push([workspaceId, userId]);
          return globalThis.__removeImpl();
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
            props.error ? React.createElement("p", { role: "alert" }, props.error) : null,
            React.createElement(
              "button",
              { id: "primary", disabled: props.busy || props.primary.disabled || undefined },
              props.primary.label
            ),
            props.cancelLabel && !props.busy
              ? React.createElement("button", { id: "cancel" }, props.cancelLabel)
              : null
          );
        }
      `,
    },
  });
  const { RemoveMemberDialog } = await vite.ssrLoadModule(
    "/components/workspace/RemoveMemberDialog.tsx"
  );
  const { CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts");
  const { confirmActionReducer } = await vite.ssrLoadModule("/lib/confirmActionFlow.ts");
  const events = [];
  const render = (state, overrides = {}) =>
    renderToStaticMarkup(
      createElement(RemoveMemberDialog, {
        workspaceId: "w1",
        workspaceName: "Acme",
        state,
        dispatch: (event) => events.push(event),
        ...overrides,
      })
    );
  return { render, events, CloudApiError, confirmActionReducer };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const subject = (overrides = {}) => ({ ...MEMBER, ...overrides });

test("closed renders nothing", async (t) => {
  const { render } = await loadDialog(t);

  assert.equal(render({ kind: "closed" }), "");
});

test("confirm shows the name and workspace", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "confirm", subject: subject() });

  assert.match(
    markup,
    /workspaces\.removeMember\.title\|\{&quot;name&quot;:&quot;Mia Member&quot;,&quot;workspace&quot;:&quot;Acme&quot;\}/
  );
  assert.match(markup, /workspaces\.removeMember\.body/);
  assert.match(markup, /workspaces\.removeMember\.confirm</);
  assert.match(markup, /common\.cancel/);
  assert.equal(globalThis.__actionDialogProps.icon, "trash");
  assert.equal(globalThis.__actionDialogProps.primary.tone, "destructive");
});

test("a member without a name is shown by email", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "confirm", subject: subject({ name: "" }) });

  assert.match(markup, /mia@example\.com/);
});

test("running is busy", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "running", subject: subject() });

  assert.match(markup, /workspaces\.removeMember\.removing/);
  assert.doesNotMatch(markup, /common\.cancel/);
  assert.equal(globalThis.__actionDialogProps.busy, true);
});

test("confirming runs the action, toasts and closes", async (t) => {
  const { render, events } = await loadDialog(t);

  render({ kind: "confirm", subject: subject() });
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  assert.deepEqual(globalThis.__removeCalls, [["w1", "u-mia"]]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["confirm", "succeeded"]
  );
  assert.equal(globalThis.__toasts.length, 1);
  assert.match(globalThis.__toasts[0].title, /settingsPage\.workspace\.members\.removed\|/);
});

test("a member already removed toasts the already-removed copy", async (t) => {
  const { render, events } = await loadDialog(t);
  globalThis.__removeImpl = async () => "alreadyRemoved";

  render({ kind: "confirm", subject: subject() });
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  assert.match(globalThis.__toasts[0].title, /workspaces\.removeMember\.alreadyRemoved\|/);
  assert.deepEqual(
    events.map((event) => event.type),
    ["confirm", "succeeded"]
  );
});

test("a rejected removal dispatches failed with the classified error", async (t) => {
  const { render, events, CloudApiError } = await loadDialog(t);
  globalThis.__removeImpl = async () => {
    throw new CloudApiError("Cannot remove the last owner", 400);
  };

  render({ kind: "confirm", subject: subject() });
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  assert.deepEqual(events[1], {
    type: "failed",
    error: { kind: "refused", message: "Cannot remove the last owner" },
  });
  assert.equal(globalThis.__toasts.length, 0);
});

test("a refusal shows the server's message", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({
    kind: "failed",
    subject: subject(),
    error: { kind: "refused", message: "Owners can't be removed" },
  });

  assert.match(markup, /role="alert"[^>]*>Owners can&#x27;t be removed</);
  assert.doesNotMatch(markup, /workspaces\.removeMember\.failed/);
});

test("losing the right to remove people shows the not-allowed copy", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({
    kind: "failed",
    subject: subject(),
    error: { kind: "notAllowed" },
  });

  assert.match(markup, /role="alert"[^>]*>workspaces\.invite\.errors\.notAllowed\|/);
  assert.match(markup, /Acme/);
});

test("a network failure shows the failed copy with Try again", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "failed", subject: subject(), error: { kind: "failed" } });

  assert.match(markup, /role="alert"[^>]*>workspaces\.removeMember\.failed\|/);
  assert.match(markup, /Mia Member/);
  assert.match(markup, /workspaces\.exit\.tryAgain/);
  assert.match(markup, /common\.cancel/);
  assert.equal(globalThis.__actionDialogProps.primary.tone, "destructive");
});

test("a successful removal closes the dialog", async (t) => {
  const { render, events, confirmActionReducer } = await loadDialog(t);
  const open = { kind: "confirm", subject: subject() };

  render(open);
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  // The events the dialog dispatched, folded through the real reducer.
  assert.deepEqual(events.reduce(confirmActionReducer, open), { kind: "closed" });
});
