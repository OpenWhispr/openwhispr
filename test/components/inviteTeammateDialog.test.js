const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

async function mountDialog(t, props) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    for (const key of ["__viewProps", "__sendCalls"]) delete globalThis[key];
  });
  installBrowserGlobals(t, {
    window: { electronAPI: { searchContacts: async () => ({ success: true, contacts: [] }) } },
  });
  const container = installHostDom(t);
  globalThis.__sendCalls = [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-invite-teammate-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
        }
      `,
      "/ui/dialog": `
        import React from "react";
        export const Dialog = ({ children }) => React.createElement("div", null, children);
      `,
      // Records every render's props, so the test can read the state and press Send.
      "/InvitePeopleView": `
        export function InvitePeopleView(props) {
          (globalThis.__viewProps ??= []).push(props);
          return null;
        }
      `,
      "/services/invitePeople": `
        export const invitePeople = {
          async sendInvitations(input) {
            globalThis.__sendCalls.push(input);
            for (const email of input.emails) input.onResult(email, { ok: true, emailSent: true });
          },
        };
      `,
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) => selector({ workspaces: [] });
      `,
      "/services/WorkspacesService": `
        export const WorkspacesService = {
          previewSeats: () => Promise.reject(new Error("no subscription")),
          listMembers: async () => [],
        };
      `,
    },
  });
  const { default: InviteTeammateDialog } = await vite.ssrLoadModule(
    "/components/InviteTeammateDialog.tsx"
  );
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(InviteTeammateDialog, props)));
  return { latest: () => globalThis.__viewProps.at(-1) };
}

test("existing callers keep their props", async (t) => {
  const invited = [];
  const { latest } = await mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    teamIds: ["t1"],
    initialEmail: "a@x.com",
    cancelLabel: "Skip",
    onInvited: (email) => invited.push(email),
  });

  const first = globalThis.__viewProps[0];
  assert.deepEqual(
    first.state.recipients.map((recipient) => recipient.email),
    ["a@x.com"]
  );
  assert.equal(first.cancelLabel, "Skip");
  assert.equal(first.workspaceName, "Acme");

  await React.act(async () => latest().onSend());

  assert.equal(globalThis.__sendCalls.length, 1);
  const [call] = globalThis.__sendCalls;
  assert.equal(call.workspaceId, "w1");
  assert.deepEqual(call.emails, ["a@x.com"]);
  assert.deepEqual(call.teamIds, ["t1"]);
  assert.equal(call.role, "member");
  assert.deepEqual(invited, ["a@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.deepEqual(
    latest().state.sent.map((entry) => entry.email),
    ["a@x.com"]
  );
});

test("knownEmails blocks an address already in the workspace", async (t) => {
  const { latest } = await mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    initialEmail: "Mia@X.com",
    knownEmails: { members: ["mia@x.com"], invited: [] },
  });

  assert.deepEqual(latest().state.recipients, [
    { email: "mia@x.com", state: { status: "blocked", reason: "alreadyMember" } },
  ]);
});
