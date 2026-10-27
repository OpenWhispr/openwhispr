const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { mountAuditDom, deferred } = require("../lib/settingsAuditHarness");

test("invitation account switch awaits the meeting before signing out", async (t) => {
  const { container, render } = await mountAuditDom(t);
  const calls = [];
  let finishStop;
  globalThis.__invitationSignOut = {
    storeToken: (token) => calls.push(`invitation kept: ${token}`),
    stopRecording: () =>
      new Promise((resolve) => {
        calls.push("stop requested");
        finishStop = () => {
          calls.push("meeting stopped");
          resolve();
        };
      }),
    purge: async () => {
      calls.push("team spaces purged");
    },
    signOut: async () => {
      calls.push("signed out");
    },
  };
  t.after(() => delete globalThis.__invitationSignOut);
  const vite = await createRendererServer(t, {
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t, i18n: {language: "en"}});`,
      "/hooks/useAuth": `export const useAuth = () => ({isSignedIn: true, user: {email: "other@example.test"}});`,
      "/services/InvitationsService": `export const InvitationsService = {preview: async () => ({email: "invitee@example.test", workspace_name: "Workspace", workspace_role: "member"})};`,
      "/utils/pendingInvitationToken": `export const storePendingInvitationToken = token => globalThis.__invitationSignOut.storeToken(token); export const clearPendingInvitationToken = () => {};`,
      "/stores/meetingRecordingStore": `export const stopRecording = () => globalThis.__invitationSignOut.stopRecording();`,
      "/services/SyncService.js": `export const syncService = {purgeTeamSpacesForSignOut: () => globalThis.__invitationSignOut.purge()};`,
      "/lib/auth": `export const signOut = () => globalThis.__invitationSignOut.signOut();`,
      "/services/membershipActions": `export const afterWorkspaceJoined = async () => {};`,
      "/ui/useToast": `export const useToast = () => ({toast() {}});`,
      "/SignInDialog": `export default () => null;`,
      "/ui/button": `import React from "react"; export const Button = ({children, onClick, disabled}) => React.createElement("button", {onClick, disabled}, children);`,
      "/ui/dialog": `import React from "react"; const Part = ({children}) => React.createElement("div", null, children); export const Dialog = Part; export const DialogContent = Part; export const DialogHeader = Part; export const DialogTitle = Part; export const DialogDescription = Part; export const DialogFooter = Part;`,
    },
  });
  const { default: AcceptInvitationModal } = await vite.ssrLoadModule(
    "/components/AcceptInvitationModal.tsx"
  );
  await render(React.createElement(AcceptInvitationModal, { token: "invite-token", onClose() {} }));
  const button = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === "workspaces.accept.switchAccount"
  );
  assert.ok(button, "the real wrong-account branch offers Switch account");
  await React.act(async () => button.click());
  assert.deepEqual(calls, ["invitation kept: invite-token", "stop requested"]);
  await React.act(async () => finishStop());
  assert.deepEqual(calls, [
    "invitation kept: invite-token",
    "stop requested",
    "meeting stopped",
    "team spaces purged",
    "signed out",
  ]);
});

test("shared sign-out asks before ending a meeting and waits before clearing scope", async (t) => {
  const { container, render, dom } = await mountAuditDom(t);
  const stop = deferred();
  const calls = [];
  const state = (globalThis.__signOutOwner = { recording: true, stop, calls });
  t.after(() => delete globalThis.__signOutOwner);
  dom.location.reload = () => calls.push("reloaded");
  const vite = await createRendererServer(t, {
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({t: key => key});`,
      "/stores/meetingRecordingStore": `export const useMeetingRecordingStore = {getState: () => ({isRecording: globalThis.__signOutOwner.recording})}; export const stopRecording = () => {globalThis.__signOutOwner.calls.push("stop requested"); return globalThis.__signOutOwner.stop.promise;};`,
      "/services/SyncService.js": `export const syncService = {purgeTeamSpacesForSignOut: async () => {globalThis.__signOutOwner.calls.push("purged");}};`,
      "/lib/auth": `export const signOut = async () => {globalThis.__signOutOwner.calls.push("signed out");};`,
    },
  });
  const { useSignOut } = await vite.ssrLoadModule("/hooks/useSignOut.ts");
  const dialogs = {
    showConfirmDialog: (options) => {
      state.confirm = options;
    },
    showAlertDialog: () => assert.fail("sign-out should succeed"),
  };
  function Owner() {
    const { requestSignOut, isSigningOut } = useSignOut(dialogs);
    return React.createElement(
      "button",
      { onClick: requestSignOut, disabled: isSigningOut },
      "sign out"
    );
  }
  await render(React.createElement(Owner));
  await React.act(async () => container.querySelector("button").click());
  assert.deepEqual(calls, []);
  assert.equal(state.confirm.title, "settingsPage.account.signOut.endMeetingTitle");
  await React.act(async () => state.confirm.onConfirm());
  assert.deepEqual(calls, ["stop requested"]);
  assert.equal(container.querySelector("button").disabled, true);
  await React.act(async () => stop.resolve());
  assert.deepEqual(calls, ["stop requested", "purged", "signed out", "reloaded"]);
  state.recording = false;
  state.confirm = null;
  calls.length = 0;
  await React.act(async () => container.querySelector("button").click());
  assert.equal(state.confirm, null, "no recording means no confirmation");
  assert.deepEqual(calls, ["stop requested", "purged", "signed out", "reloaded"]);
});

test("auth sign-out closes activation before revoking credentials, even offline", async (t) => {
  const calls = [];
  const close = deferred();
  const { window, storage } = installBrowserGlobals(t, {
    window: {
      electronAPI: {
        closeActivationStream: () => {
          calls.push("activation closing");
          return close.promise;
        },
        authGetTokenState: async () => ({ token: "test-token", generation: 1 }),
        authClearSession: async () => {
          calls.push("local cleared");
        },
      },
    },
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(String(url), /\/sign-out$/);
    calls.push("remote revoked");
    throw new Error("offline");
  });
  const vite = await createRendererServer(t);
  const { signOut } = await vite.ssrLoadModule("/lib/auth.ts");
  const pending = signOut();
  assert.deepEqual(calls, ["activation closing"]);
  close.resolve();
  await pending;
  assert.deepEqual(calls, ["activation closing", "remote revoked", "local cleared"]);
  assert.equal(storage.getItem("isSignedIn"), "false");
  assert.equal(typeof window.electronAPI.authClearSession, "function");
});
