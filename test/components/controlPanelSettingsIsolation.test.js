const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom } = require("../lib/settingsAuditHarness");

test("the production host and ControlPanel isolate 150 History rows, and retry preserves cleanup and partial-result feedback", async (t) => {
  const { dom, container, render } = await mountAuditDom(t);
  const raw = "um can you send the report by friday";
  const clean = "Can you send the report by Friday?";
  const rows = Array.from({ length: 150 }, (_, id) => ({
    id,
    text: raw,
    raw_text: raw,
    timestamp: "2026-10-27T12:00:00Z",
  }));
  const seen = (globalThis.__controlPanelIsolation = { renders: 0, toasts: [] });
  t.after(() => delete globalThis.__controlPanelIsolation);
  let warning;
  let output = `${clean}\n\n${clean}`;
  dom.electronAPI = {
    getPlatform: () => "linux",
    getTranscriptions: async () => rows,
    retryTranscription: async () => ({ success: true, transcription: rows[0], warning }),
    processLocalReasoning: async () => ({ success: true, text: output }),
    updateTranscriptionText: async () =>
      assert.fail("rejected or unchanged cleanup must not overwrite the row"),
  };
  const empty = "export default () => null;";
  const mocks = Object.fromEntries(
    [
      "/CommandSearch",
      "/UpgradePrompt",
      "/PostMigrationOnboarding",
      "/MeetingRecordingMount",
      "/notes/MeetingRecordingPill",
      "/notes/NewNoteMenu",
      "/ProfileMenu",
      "/notes/BackgroundActionToastListener",
      "/notes/AssistantNoteUndoListener",
      "/notes/SpaceSyncToastListener",
      "/AcceptInvitationModal",
      "/JoinYourTeamModal",
      "/UpcomingMeetings",
      "/toneStyle/ToneStyleSetupDialog",
    ].map((name) => [name, empty])
  );
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      ...mocks,
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t, i18n: {language: "en"}}); export const initReactI18next = {type: "3rdParty", init() {}};`,
      "/hooks/useAuth": `export const useAuth = () => ({isSignedIn: false, isLoaded: true, user: null});`,
      "/hooks/useHotkey": `export const useHotkey = () => ({hotkey: "F8"});`,
      "/hooks/useUsage": `export const useUsage = () => null;`,
      "/hooks/useUpdater": `export const useUpdater = () => ({status: {isDevelopment: true}});`,
      "/hooks/useUpcomingEvents": `export const useUpcomingEvents = () => ({events: [], isConnected: false});`,
      "/hooks/useToneStylePrompt": `export const useToneStylePrompt = () => ({});`,
      "/hooks/useUiLocale": `export const useUiLocale = () => "en";`,
      "/hooks/useSignInCloudNudge": `export const useSignInCloudNudge = () => {};`,
      "/hooks/useJoinableWorkspaces": `export const useJoinableWorkspaces = () => ({});`,
      "/hooks/useCollapsibleSidebar": `export const useCollapsibleSidebar = () => ({collapsed: false, peek: false});`,
      "/hooks/useCreateNote": `export const useCreateNote = () => ({}); export const startRecordingForNote = async () => false;`,
      "/stores/noteStore": `export const subscribeMeetingNotificationFolders = () => () => {}; export const initializeNotes = async () => {}; export const useActiveNoteId = () => null; export const setActiveNoteId = () => {}; export const setActiveFolderId = () => {}; export const navigateToContainer = () => {};`,
      "/stores/streamingProvidersStore": `export const fetchProviders = async () => {};`,
      "/stores/meetingRecordingStore": `export const useIsMeetingMode = () => false; export const useIsNarrowWindow = () => false; const state = {isRecording: false}; export const useMeetingRecordingStore = fn => fn(state); useMeetingRecordingStore.getState = () => state; export const stopRecording = async () => {};`,
      "/RequiredModelsBanner": `export const RequiredModelsBanner = () => null;`,
      "/GpuAccelerationBanner": `export const GpuAccelerationBanner = () => null;`,
      "/ui/useToast": `const toast = value => globalThis.__controlPanelIsolation.toasts.push(value); export const useToast = () => ({toast});`,
      "/utils/logger": `export default {warn() {}, info() {}, debug() {}, error() {}, logReasoning() {}};`,
      "/ControlPanelSidebar": `import React from "react"; export default ({onOpenSettings}) => React.createElement("button", {onClick: onOpenSettings}, "settings");`,
      "/ControlPanelTopBar": empty,
      "/SettingsModal": `export default () => null;`,
      "/ui/TranscriptionItem": `import React from "react"; export default props => {globalThis.__controlPanelIsolation.renders++; return React.createElement("button", {"data-row": props.item.id, onClick: () => {globalThis.__controlPanelIsolation.pending = props.onRetryTranscription(props.item.id);}}, props.item.text);};`,
    },
  });
  const { useSettingsStore: store } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  store.setState({
    useCleanupModel: true,
    cleanupMode: "local",
    cleanupProvider: "local",
    cleanupModel: "test-model",
  });
  const { SettingsHost } = await vite.ssrLoadModule("/components/SettingsHost.tsx");
  const { default: ControlPanel } = await vite.ssrLoadModule("/components/ControlPanel.tsx");
  let navigation;
  await render(
    React.createElement(SettingsHost, null, (store) => {
      navigation = store;
      return React.createElement(ControlPanel, { settingsNavigation: store });
    })
  );
  assert.equal(container.querySelectorAll("[data-row]").length, 150);
  const before = seen.renders;
  await React.act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "settings")
      .click()
  );
  await React.act(async () => store.getState().setPreferredLanguage("fr"));
  await React.act(async () => navigation.getState().openSettings("noteFormatting"));
  await React.act(async () => navigation.getState().setSettingsOpen(false));
  assert.equal(
    seen.renders,
    before,
    "open, unrelated changes, navigation and close render no History rows"
  );
  const retry = () =>
    React.act(async () => {
      container.querySelector('[data-row="0"]').click();
      await seen.pending;
    });
  await retry();
  assert.ok(
    seen.toasts.some(
      (toast) => toast.description === "hooks.audioRecording.errorDescriptions.cleanupDuplicated"
    ),
    JSON.stringify(seen.toasts)
  );
  assert.equal(container.querySelector('[data-row="0"]').textContent, raw);
  output = raw;
  seen.toasts.length = 0;
  warning = "truncated";
  await retry();
  assert.deepEqual(seen.toasts, [
    {
      title: "controlPanel.history.retrySuccess",
      description: "hooks.audioRecording.partialTranscription.description",
    },
  ]);
  warning = undefined;
  seen.toasts.length = 0;
  await retry();
  assert.deepEqual(seen.toasts, [{ title: "controlPanel.history.retrySuccess" }]);
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  service.destroy();
  await render(null);
});
