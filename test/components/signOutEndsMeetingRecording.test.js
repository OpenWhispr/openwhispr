const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom } = require("../lib/settingsAuditHarness");

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
  assert.deepEqual(
    calls,
    ["invitation kept: invite-token", "stop requested"],
    "account scope must remain until the meeting stop settles"
  );
  await React.act(async () => finishStop());
  assert.deepEqual(calls, [
    "invitation kept: invite-token",
    "stop requested",
    "meeting stopped",
    "team spaces purged",
    "signed out",
  ]);
});
