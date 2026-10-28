const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const INVITATION = {
  id: "inv-1",
  email: "ada@example.com",
  workspace_role: "member",
  team_ids: [],
  invited_by_user_id: "u1",
  expires_at: "2027-01-01T00:00:00.000Z",
  created_at: "2026-10-01T00:00:00.000Z",
  accepted_at: null,
  revoked_at: null,
};

async function loadDialog(t) {
  t.after(() => {
    for (const key of ["__actionDialogProps", "__toasts", "__revokeCalls", "__revokeImpl"]) {
      delete globalThis[key];
    }
  });
  installBrowserGlobals(t);
  globalThis.__toasts = [];
  globalThis.__revokeCalls = [];
  globalThis.__revokeImpl = async () => undefined;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cancel-invitation-dialog-",
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
      "/services/InvitationsService": `
        export const InvitationsService = {
          revoke: (workspaceId, invitationId) => {
            globalThis.__revokeCalls.push([workspaceId, invitationId]);
            return globalThis.__revokeImpl();
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
  const { CancelInvitationDialog } = await vite.ssrLoadModule(
    "/components/workspace/CancelInvitationDialog.tsx"
  );
  const { CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts");
  const { confirmActionReducer } = await vite.ssrLoadModule("/lib/confirmActionFlow.ts");
  const events = [];
  const canceled = [];
  const render = (state) =>
    renderToStaticMarkup(
      createElement(CancelInvitationDialog, {
        workspaceId: "w1",
        workspaceName: "Acme",
        state,
        dispatch: (event) => events.push(event),
        onCanceled: (outcome) => canceled.push(outcome),
      })
    );
  return { render, events, canceled, CloudApiError, confirmActionReducer };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const confirmState = { kind: "confirm", subject: INVITATION };

test("closed renders nothing", async (t) => {
  const { render } = await loadDialog(t);

  assert.equal(render({ kind: "closed" }), "");
});

test("confirm offers Keep invitation", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render(confirmState);

  assert.match(
    markup,
    /workspaces\.cancelInvitation\.title\|\{&quot;email&quot;:&quot;\u2068ada@example\.com\u2069&quot;\}/
  );
  assert.match(markup, /workspaces\.cancelInvitation\.body/);
  assert.match(markup, />settingsPage\.workspace\.people\.invitations\.cancel</);
  assert.match(markup, />workspaces\.cancelInvitation\.keep</);
  assert.doesNotMatch(markup, /common\.cancel/);
  assert.equal(globalThis.__actionDialogProps.icon, "trash");
  assert.equal(globalThis.__actionDialogProps.primary.tone, "destructive");
});

test("canceling is busy", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "running", subject: INVITATION });

  assert.match(markup, /workspaces\.cancelInvitation\.canceling/);
  assert.doesNotMatch(markup, /workspaces\.cancelInvitation\.keep/);
  assert.equal(globalThis.__actionDialogProps.busy, true);
});

test("a failed cancel shows the error line and Try again", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "failed", subject: INVITATION, error: { kind: "failed" } });

  assert.match(markup, /role="alert"[^>]*>workspaces\.cancelInvitation\.failed</);
  assert.match(markup, /workspaces\.exit\.tryAgain/);
  assert.match(markup, /workspaces\.cancelInvitation\.keep/);
});

test("a refusal shows the server's message", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({
    kind: "failed",
    subject: INVITATION,
    error: { kind: "refused", message: "Invitation already accepted" },
  });

  assert.match(markup, /role="alert"[^>]*>Invitation already accepted</);
  assert.doesNotMatch(markup, /workspaces\.cancelInvitation\.failed/);
});

test("confirming revokes, toasts, closes and reports", async (t) => {
  const { render, events, canceled } = await loadDialog(t);

  render(confirmState);
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  assert.deepEqual(globalThis.__revokeCalls, [["w1", "inv-1"]]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["confirm", "succeeded"]
  );
  assert.equal(globalThis.__toasts.length, 1);
  assert.equal(globalThis.__toasts[0].title, "workspaces.cancelInvitation.done");
  assert.deepEqual(canceled, ["canceled"]);
});

test("an invitation no longer pending closes without claiming it was canceled", async (t) => {
  const { render, events, canceled, CloudApiError } = await loadDialog(t);
  globalThis.__revokeImpl = async () => {
    throw new CloudApiError("Invitation not found", 404);
  };

  render(confirmState);
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  assert.deepEqual(
    events.map((event) => event.type),
    ["confirm", "succeeded"]
  );
  // It may have been accepted, so the tab is told to read the members as well.
  assert.match(
    globalThis.__toasts[0].title,
    /^settingsPage\.workspace\.people\.invitations\.noLongerPending\|/
  );
  assert.deepEqual(canceled, ["gone"]);
});

test("a bare 404 is a failure, not a cancel", async (t) => {
  const { render, events, canceled, CloudApiError } = await loadDialog(t);
  globalThis.__revokeImpl = async () => {
    throw new CloudApiError("API error: 404", 404);
  };

  render(confirmState);
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  assert.deepEqual(events[1], { type: "failed", error: { kind: "failed" } });
  assert.equal(canceled.length, 0);
});

test("lost permission and required single sign-on say so instead of blaming the connection", async (t) => {
  const { render } = await loadDialog(t);

  const notAllowed = render({ kind: "failed", subject: INVITATION, error: { kind: "notAllowed" } });
  assert.match(notAllowed, /role="alert"[^>]*>workspaces\.cancelInvitation\.notAllowed\|/);
  const sso = render({ kind: "failed", subject: INVITATION, error: { kind: "ssoRequired" } });
  assert.match(sso, /role="alert"[^>]*>workspaces\.ssoRequired\|/);
});

test("any other rejection dispatches failed and leaves the list alone", async (t) => {
  const { render, events, canceled, CloudApiError } = await loadDialog(t);
  globalThis.__revokeImpl = async () => {
    throw new CloudApiError("Invitation already accepted", 400);
  };

  render(confirmState);
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  assert.deepEqual(events[1], {
    type: "failed",
    error: { kind: "refused", message: "Invitation already accepted" },
  });
  assert.equal(globalThis.__toasts.length, 0);
  assert.equal(canceled.length, 0);
});

test("a successful cancel closes the dialog", async (t) => {
  const { render, events, confirmActionReducer } = await loadDialog(t);

  render(confirmState);
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  // The events the dialog dispatched, folded through the real reducer.
  assert.deepEqual(events.reduce(confirmActionReducer, confirmState), { kind: "closed" });
});
