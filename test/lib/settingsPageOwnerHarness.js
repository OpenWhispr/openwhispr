const { mountAuditDom } = require("./settingsAuditHarness");
const { createRendererServer } = require("./rendererTestHarness");

// Keep SettingsPage, its dialogs, ProfileSection and settings-store actions real.
// Unvisited feature surfaces and external account/policy services are boundaries.
const STUBBED_SURFACES = [
  "/ui/MicPermissionWarning",
  "/ui/MicrophoneSettings",
  "/ui/PermissionCard",
  "/ui/PasteToolsInfo",
  "/ui/NixOsPasteInfo",
  "/ui/LanguageSelector",
  "/DeveloperSection",
  "/settings/GpuDeviceSelector",
  "/settings/LlmsSection",
  "/settings/SystemUpdates",
  "/settings/HotkeysSection",
  "/settings/WorkspaceSection",
  "/settings/WorkspaceBillingOverview",
  "/settings/EnterpriseCheckoutDialog",
  "/CreateWorkspaceDialog",
  "/SelfHostedPanel",
  "/TranscriptionModelPicker",
];

// Speech-section probes: real TranscriptionModelPicker/HotkeysSection mounts with observable props and speech-store writers behind the shared observed bag.
const SPEECH_MOCKS = {
  "react-i18next": `
    import { create } from "zustand";
    const useLocale = create(() => ({ t: key => key }));
    globalThis.__settingsPageOwner.locale = useLocale;
    export function useTranslation() { return { t: useLocale(s => s.t), i18n: { language: "en" } }; }
  `,
  "/stores/settingsStore": `
    import { create } from "zustand";
    export const useSettingsStore = create(set => ({
      isSignedIn: true, customDictionary: [], activationMode: "tap",
      dictationKey: "F8", meetingKey: "F7", voiceAgentKey: "F6", translationKey: "F5",
      meetingHotkeyLayoutMode: "side-panel",
      setActivationMode: value => set({activationMode: value}),
      setDictationKey: value => set({dictationKey: value}),
      setMeetingKey: value => set({meetingKey: value}),
      setMeetingHotkeyLayoutMode: value => set({meetingHotkeyLayoutMode: value}),
      setVoiceAgentKey: async value => {
        const result = await globalThis.__settingsPageOwner.agentWrite(value);
        if (result.success) set({voiceAgentKey: value});
        return result;
      },
      setTranslationKey: async value => {
        const result = await globalThis.__settingsPageOwner.translationWrite(value);
        if (result.success) set({translationKey: value});
        return result;
      },
      transcriptionMode: "local", localTranscriptionProvider: "whisper", whisperModel: "base",
      useLocalWhisper: true, showTranscriptionPreview: false,
      meetingTranscriptionMode: "local", meetingLocalTranscriptionProvider: "whisper", meetingWhisperModel: "base",
      uploadTranscriptionMode: "local", uploadLocalTranscriptionProvider: "whisper", uploadWhisperModel: "base",
      whisperVadThreshold: 0.5, whisperVadMinSpeechDurationMs: 250,
      whisperVadMinSilenceDurationMs: 100, whisperVadMaxSpeechDurationS: 30,
      whisperVadSpeechPadMs: 30, whisperVadSamplesOverlap: 0.1,
      updateTranscriptionSettings: values => set(values),
      setWhisperModel: value => set({ whisperModel: value }),
      setWhisperVadThreshold: value => set({ whisperVadThreshold: value }),
    }));
    globalThis.__settingsPageOwner.store = useSettingsStore;
    export const TRANSCRIPTION_ENTERPRISE_POLICY_PROVIDER_IDS = [];
    export const TRANSCRIPTION_POLICY_PROVIDER_IDS = [];
    export const clearMissingLocalModelSelections = () => {};
    export const reconcileLocalModelSelections = async () => {};
  `,
  "/hooks/usePolicy": `
    import { create } from "zustand";
    const usePolicy = create(() => ({ status: "unmanaged", policy: null, appVersion: null }));
    globalThis.__settingsPageOwner.policy = usePolicy;
    export const usePolicySnapshot = () => usePolicy();
    export function usePolicyModeOptions(modes, scope, current) {
      const policy = usePolicy();
      return { modes, effectiveMode: policy.forcedMode ?? current, isModeAllowed: () => true };
    }
  `,
  "/stores/policyStore": `export const usePolicyStore = select => globalThis.__settingsPageOwner.policy(select); usePolicyStore.getState = () => globalThis.__settingsPageOwner.policy.getState();`,
  "/stores/meetingRecordingStore": `export const stopRecording = () => globalThis.__settingsPageOwner.stopRecording?.();`,
  "/services/SyncService.js": `export const syncService = { purgeTeamSpacesForSignOut: () => globalThis.__settingsPageOwner.purgeTeamSpaces?.(), scheduleSettingsPush() {} };`,
  "/lib/auth": `
    export const AUTH_URL = "https://auth.example.test";
    export const signOut = () => globalThis.__settingsPageOwner.signOut?.();
    export const hasCredentialAccount = () => globalThis.__settingsPageOwner.hasCredentialAccount?.() ?? Promise.resolve(false);
    export const updateDisplayName = name => globalThis.__settingsPageOwner.updateDisplayName(name);
    export const changePassword = values => globalThis.__settingsPageOwner.changePassword(values);
  `,
  "/hooks/useDialogs": `const noop = () => {}; const showAlertDialog = value => globalThis.__settingsPageOwner.alerts.push(value); export const useDialogs = () => ({ confirmDialog: {}, alertDialog: {}, showConfirmDialog: noop, showAlertDialog, hideConfirmDialog: noop, hideAlertDialog: noop });`,
  "/ui/HotkeyListInput": `
    import React from "react";
    export function HotkeyListInput(props) {
      globalThis.__settingsPageOwner.hotkeys[props.ariaLabel] = props;
      React.useEffect(() => {
        globalThis.__settingsPageOwner.hotkeyMounts++;
        return () => { globalThis.__settingsPageOwner.hotkeyDisposed++; };
      }, []);
      return React.createElement("div", {"data-hotkey": props.ariaLabel}, props.footerEnd);
    }
  `,
  "/ui/LinuxPttSetupInfo": `export default function Info(props) { globalThis.__settingsPageOwner.ptt = props; return null; }`,
  "/ui/button": `import React from "react"; export function Button(props) { globalThis.__settingsPageOwner.buttons.push(props); return React.createElement("button", {onClick: props.onClick, disabled: props.disabled}, props.children); }`,
  "/ui/dialog": `export const ConfirmDialog = props => { if (props.title === "settingsPage.account.deleteAccount.title") {globalThis.__settingsPageOwner.deleteDialog = props; return props.open ? props.children : null;} return null; }; export const AlertDialog = ConfirmDialog; export const Dialog = ConfirmDialog; export const DialogContent = ConfirmDialog; export const DialogHeader = ConfirmDialog; export const DialogTitle = ConfirmDialog; export const DialogDescription = ConfirmDialog; export const DialogFooter = ConfirmDialog;`,
  "/ui/popover": `export const Popover = ({children}) => children; export const PopoverTrigger = Popover; export const PopoverContent = () => null;`,
  "/ui/select": `import React from "react"; export const Select = ({children}) => children; export const SelectTrigger = ({children, ...props}) => React.createElement("button", props, children); export const SelectValue = () => null; export const SelectContent = () => null; export const SelectItem = ({children}) => children;`,
  "/ui/SettingsSection": `
    import React from "react";
    export const SettingsPanel = ({children}) => children;
    export const SettingsPanelRow = SettingsPanel;
    export function SettingsRow(props) { globalThis.__settingsPageOwner.rows.push(props); return props.children; }
    export function SectionHeader({title}) {
      return React.createElement("h3", null, title);
    }
    export function InferenceModeSelector(props) {
      globalThis.__settingsPageOwner.modes.push(props);
      return null;
    }
  `,
  "/ui/input": `export function Input(props) { globalThis.__settingsPageOwner.inputs.push(props); return null; }`,
  "/utils/platform": `export const getPlatform = () => "linux"; export const getCachedPlatform = getPlatform;`,
  "/ui/ProviderTabs": `export function ProviderTabs(props) { globalThis.__settingsPageOwner.tabs = props; return null; }`,
  "/TranscriptionModelPicker": `
    import React from "react";
    import { useSettingsModelVisible } from "/stores/settingsNavigationStore.ts";
    function Status({context, navigation}) {
      const visible = useSettingsModelVisible(navigation, "speechToText", context === "meeting" ? "noteRecording" : context);
      globalThis.__settingsPageOwner.activity ??= {};
      globalThis.__settingsPageOwner.activity[context] = visible;
      return null;
    }
    export default function Picker(props) {
      const context = props.transcriptionContext ?? "dictation";
      const [draft, setDraft] = React.useState("");
      const [progress, setProgress] = React.useState(0);
      const observed = globalThis.__settingsPageOwner;
      observed.pickers[context] = {props, draft, setDraft, progress, setProgress};
      React.useEffect(() => { observed.mounted++; return () => observed.disposed++; }, []);
      return React.createElement(Status, {context, navigation: props.settingsNavigation});
    }
  `,
};

async function mountSettingsPageOwner(
  t,
  { section = "system", extraMocks = {}, speech = false } = {}
) {
  const navigatorBefore = speech
    ? Object.getOwnPropertyDescriptor(globalThis, "navigator")
    : null;
  const mounted = await mountAuditDom(t);
  const observed = (globalThis.__settingsPageOwner = { toasts: [] });
  if (speech) {
    // Real platform-dependent validation (hotkey reserved lists) reads
    // Happy-dom reports a Linux UA, which would reserve F5 before the cross-slot check; the platform
    // surfaces under test come from the /utils/platform mock, so restore the pre-mount navigator.
    if (navigatorBefore) Object.defineProperty(globalThis, "navigator", navigatorBefore);
    else delete globalThis.navigator;
    Object.assign(observed, {
      pickers: {},
      mounted: 0,
      disposed: 0,
      inputs: [],
      modes: [],
      buttons: [],
      rows: [],
      registered: [],
      hotkeys: {},
      hotkeyMounts: 0,
      hotkeyDisposed: 0,
      alerts: [],
    });
    observed.agentWrite = async () => ({ success: true });
    observed.translationWrite = async () => ({ success: true });
  }
  t.after(() => delete globalThis.__settingsPageOwner);
  const empty = "export default function Stub() { return null; }";
  const mockModules = {
    ...Object.fromEntries(STUBBED_SURFACES.map((suffix) => [suffix, empty])),
    "react-i18next": `const t = (key, options) => options?.returnObjects ? [] : key; export const useTranslation = () => ({t, i18n: {language: "en"}});`,
    "/i18n": `export const normalizeUiLanguage = value => value || "en"; export default {language: "en", changeLanguage: async () => {}};`,
    "/hooks/useAuth": `
      import { create } from "zustand";
      const useAuthState = create(() => ({isSignedIn: true, isLoaded: true, user: {id: "account-a", name: "Same name"}, refetch: () => globalThis.__settingsPageOwner.refetch?.()}));
      globalThis.__settingsPageOwner.auth = useAuthState;
      export const useAuth = () => useAuthState();
    `,
    "/hooks/usePolicy": `export const usePolicySnapshot = () => ({status: "unmanaged", policy: null}); export const usePolicyModeOptions = modes => ({modes});`,
    "/stores/policyStore": `const state = {status: "unmanaged", policy: null}; export const usePolicyStore = select => select(state); usePolicyStore.getState = () => state;`,
    "/stores/enterpriseIdentityStore": `export const useManagedScopeResolution = () => ({kind: "unmanaged"}); export const getManagedScopeResolution = () => ({kind: "unmanaged"});`,
    "/stores/workspaceStore": `const state = {workspaces: [], loaded: false}; export const useWorkspaceStore = select => select(state);`,
    "/stores/noteStore.js": `export const useMigration = () => null; export const startMigration = async () => {}; export const loadFolders = () => {}; export const initializeNotesTree = () => {};`,
    "/stores/meetingRecordingStore": `export const stopRecording = async () => {};`,
    "/services/SyncService.js": `export const syncService = {purgeTeamSpacesForSignOut: async () => {}, scheduleSettingsPush() {}};`,
    "/lib/auth": `
      export const AUTH_URL = "https://auth.example.test";
      export const signOut = async () => {};
      export const hasCredentialAccount = () => globalThis.__settingsPageOwner.hasCredentialAccount?.() ?? Promise.resolve(false);
      export const updateDisplayName = name => globalThis.__settingsPageOwner.updateDisplayName(name);
      export const changePassword = values => globalThis.__settingsPageOwner.changePassword(values);
    `,
    "/lib/authRequestContext": `export const getValidatedAuthGeneration = () => globalThis.__settingsPageOwner.authGeneration ?? null; export const getBoundSessionGeneration = id => id === globalThis.__settingsPageOwner.auth.getState().user?.id ? getValidatedAuthGeneration() : null;`,
    "/hooks/useSettings": `export const useAutoLearnCorrections = () => ({});`,
    "/hooks/usePermissions": `export const usePermissions = () => ({});`,
    "/hooks/useSystemAudioPermission": `export const useSystemAudioPermission = () => ({});`,
    "/hooks/useInsightsSyncOptIn": `export const useInsightsSyncOptIn = () => ({});`,
    "/hooks/useLeaderboardParticipation": `export const useLeaderboardParticipation = () => ({});`,
    "/hooks/useBillingPortal": `export const useBillingPortal = () => ({});`,
    "/hooks/useUsage": `export const useUsage = () => globalThis.__settingsPageOwner.usage ?? {};`,
    "/hooks/useTheme": `export const useTheme = () => ({});`,
    "/ui/useToast": `const toast = value => globalThis.__settingsPageOwner.toasts.push(value); export const useToast = () => ({toast});`,
    "/ui/useSettingsLayout": `export const useSettingsLayout = () => ({isCompact: false});`,
    "/models/ModelRegistry": `export const getTranscriptionProvider = () => null; export const enterpriseProviderName = id => id; export const getMeetingStreamingTranscriptionProviders = () => [];`,
    "/utils/logger": `export default {info() {}, warn() {}, error() {}, debug() {}};`,
    ...(speech ? SPEECH_MOCKS : {}),
    ...extraMocks,
  };
  if (speech) {
    // The probe above replaces the stubbed picker; the real HotkeysSection mounts.
    delete mockModules["/settings/HotkeysSection"];
  }
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-page-owner-",
    noExternal: ["react-i18next"],
    mockModules,
  });
  const { default: SettingsPage } = await vite.ssrLoadModule("/components/SettingsPage.tsx");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { createSettingsNavigationStore } = await vite.ssrLoadModule(
    "/stores/settingsNavigationStore.ts"
  );
  const navigation = createSettingsNavigationStore();
  navigation.getState().openSettings(section);
  return {
    ...mounted,
    observed,
    store: useSettingsStore,
    navigation,
    SettingsPage,
    vite,
  };
}

module.exports = { mountSettingsPageOwner };
