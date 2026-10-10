import React, { useState, useCallback, useEffect, useRef, useId, useMemo } from "react";
import { useStore } from "zustand";
import type { SettingsNavigationStore } from "../stores/settingsNavigationStore";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Mic,
  Shield,
  FolderOpen,
  LogOut,
  UserCircle,
  Sun,
  Moon,
  Monitor,
  Cloud,
  Key,
  Cpu,
  Network,
  ShieldCheck,
  Sparkles,
  AlertTriangle,
  Loader2,
  Check,
  Mail,
  CircleCheck,
  CircleX,
  RotateCw,
  BookOpen,
  Copy,
  Trash2,
} from "./icons";
import { useAuth } from "../hooks/useAuth";
import { AUTH_URL, signOut } from "../lib/auth";
import { deleteAccount } from "../lib/accountDeletionRequest";
import { executeAccountDeletion } from "../lib/accountDeletionFlow";
import { getValidatedAuthGeneration, getBoundSessionGeneration } from "../lib/authRequestContext";
import { useBillingPortal } from "../hooks/useBillingPortal";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import MicrophoneSettings from "./ui/MicrophoneSettings";
import PermissionCard from "./ui/PermissionCard";
import PasteToolsInfo from "./ui/PasteToolsInfo";
import NixOsPasteInfo from "./ui/NixOsPasteInfo";
import TranscriptionModelPicker from "./TranscriptionModelPicker";
import SelfHostedPanel from "./SelfHostedPanel";
import {
  ConfirmDialog,
  AlertDialog,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { useAutoLearnCorrections } from "../hooks/useSettings";
import { useDialogs } from "../hooks/useDialogs";
import { useInsightsSyncOptIn } from "../hooks/useInsightsSyncOptIn";
import { useLeaderboardParticipation } from "../hooks/useLeaderboardParticipation";
import { usePermissions } from "../hooks/usePermissions";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import SystemUpdates from "./settings/SystemUpdates";

import HotkeysSection from "./settings/HotkeysSection";
import { getCachedPlatform } from "../utils/platform";
import {
  getLinuxPasteInstallCommands,
  needsLinuxPasteToolGuidance,
} from "../utils/linuxPasteTools";
import { Toggle } from "./ui/toggle";
import DeveloperSection from "./DeveloperSection";
import GpuDeviceSelector from "./settings/GpuDeviceSelector";
import LlmsKeepAlive from "./settings/LlmsSection";
import SpeechToTextTabs from "./settings/SpeechToTextTabs";
import { KeepAlive } from "./settings/KeepAlive";
import { MeetingTranscriptionPanel } from "./settings/MeetingSettings";
import { UploadTranscriptionPanel } from "./settings/UploadSettings";
import LanguageSelector from "./ui/LanguageSelector";
import { Skeleton } from "./ui/skeleton";
import { Progress } from "./ui/progress";
import { useToast } from "./ui/useToast";
import { useTheme } from "../hooks/useTheme";
import type { ChineseScriptPreference, InferenceMode } from "../types/electron";
import logger from "../utils/logger";
import {
  SettingsPanel,
  SettingsPanelRow,
  SettingsRow,
  SectionHeader,
  InferenceModeSelector,
} from "./ui/SettingsSection";
import type { InferenceModeOption } from "./ui/SettingsSection";
import { useSettingsLayout } from "./ui/useSettingsLayout";
import { useUsage } from "../hooks/useUsage";
import { cn } from "./lib/utils";
import { GRADIENT_CIRCLE } from "./ui/gradientCircle";
import WhisperVadSettings from "./settings/WhisperVadSettings";
import {
  startMigration,
  useMigration,
  loadFolders,
  initializeNotesTree,
} from "../stores/noteStore.js";
import { syncService } from "../services/SyncService.js";
import { formatBytes } from "../utils/formatBytes";
import {
  clearMissingLocalModelSelections,
  reconcileLocalModelSelections,
  TRANSCRIPTION_ENTERPRISE_POLICY_PROVIDER_IDS,
  TRANSCRIPTION_POLICY_PROVIDER_IDS,
  useSettingsStore,
} from "../stores/settingsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { highestPlan } from "../lib/usageStore";
import { decideProPlanCardCta, resolveAccountPlan, storeSubscriptionsUrl } from "../lib/upsell";
import {
  canChangeCloudBackupPreference,
  effectiveAudioRetentionDays,
  effectiveLocalHistoryEnabled,
  isCloudBackupAllowed,
  isEnterpriseTranscriptionOfferable,
  lockedLocalHistoryValue,
  maxAudioRetentionDays,
} from "../stores/policyRules";
import { usePolicyModeOptions, usePolicySnapshot } from "../hooks/usePolicy";
import { stopRecording } from "../stores/meetingRecordingStore";
import { requestSignIn } from "../utils/requestSignIn";
import { canManageSystemAudioInApp } from "../utils/systemAudioAccess";
import WorkspaceSection from "./settings/WorkspaceSection";
import { enterpriseTileCta, type EnterpriseTileCta } from "../lib/workspaceBilling";
import WorkspaceBillingOverview from "./settings/WorkspaceBillingOverview";
import EnterpriseCheckoutDialog from "./settings/EnterpriseCheckoutDialog";
import CreateWorkspaceDialog from "./CreateWorkspaceDialog";
import ProfileSection from "./settings/ProfileSection";
import { formatAmount } from "../utils/formatAmount";
import { enterpriseProviderName, getTranscriptionProvider } from "../models/ModelRegistry";
import { useManagedScopeResolution } from "../stores/enterpriseIdentityStore";
import { supportsLiveTranscriptionPreview } from "../utils/transcriptionPreview";

interface SettingsPageProps {
  navigation: SettingsNavigationStore;
}

const UI_LANGUAGE_OPTIONS: import("./ui/LanguageSelector").LanguageOption[] = [
  { value: "en", label: "English", flag: "🇺🇸" },
  { value: "ar", label: "العربية", flag: "🇦🇪" },
  { value: "es", label: "Español", flag: "🇪🇸" },
  { value: "fr", label: "Français", flag: "🇫🇷" },
  { value: "de", label: "Deutsch", flag: "🇩🇪" },
  { value: "pt", label: "Português", flag: "🇵🇹" },
  { value: "it", label: "Italiano", flag: "🇮🇹" },
  { value: "ru", label: "Русский", flag: "🇷🇺" },
  { value: "ja", label: "日本語", flag: "🇯🇵" },
  { value: "zh-CN", label: "简体中文", flag: "🇨🇳" },
  { value: "zh-TW", label: "繁體中文", flag: "🇹🇼" },
];

const RETENTION_DAY_OPTIONS = [1, 7, 14, 30, 60, 90];

const RETENTION_SELECT_CLASS =
  "h-7 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm hover:border-border-hover hover:bg-surface-2/70 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 transition-colors duration-200";

const noop = () => {};

interface GranolaImportPreview {
  total: number;
  newCount: number;
  duplicateCount: number;
  sampleTitles: string[];
  warningCount: number;
}

type GranolaImportState =
  | { phase: "idle" }
  | { phase: "picking" }
  | { phase: "preview"; preview: GranolaImportPreview }
  | { phase: "importing"; preview: GranolaImportPreview }
  | { phase: "done"; imported: number; skipped: number };

function GranolaImportSection({
  showAlertDialog,
}: {
  showAlertDialog: (options: { title: string; description?: string }) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<GranolaImportState>({ phase: "idle" });
  // Guards double-clicks: handlers read stale closure state, so state alone
  // can't prevent a second dialog/run being started in the same frame.
  const requestInFlightRef = useRef(false);

  const errorDescription = (code?: string) => {
    switch (code) {
      case "EMPTY_FILE":
        return t("settings.granolaImport.error.EMPTY_FILE");
      case "HEADERS_UNRECOGNIZED":
        return t("settings.granolaImport.error.HEADERS_UNRECOGNIZED");
      case "NO_DATA_ROWS":
        return t("settings.granolaImport.error.NO_DATA_ROWS");
      case "FILE_TOO_LARGE":
        return t("settings.granolaImport.error.FILE_TOO_LARGE");
      default:
        return t("settings.granolaImport.error.generic");
    }
  };

  const showImportError = (code?: string) => {
    showAlertDialog({
      title: t("settings.granolaImport.error.title"),
      description: errorDescription(code),
    });
  };

  const handleChooseFile = async () => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setState({ phase: "picking" });
    try {
      let result:
        | Awaited<ReturnType<NonNullable<typeof window.electronAPI.granolaImportPickAndPreview>>>
        | undefined;
      try {
        result = await window.electronAPI?.granolaImportPickAndPreview?.();
      } catch {
        setState({ phase: "idle" });
        showImportError();
        return;
      }
      if (!result || result.canceled) {
        setState({ phase: "idle" });
        return;
      }
      if (!result.success) {
        setState({ phase: "idle" });
        showImportError(result.error);
        return;
      }
      setState({
        phase: "preview",
        preview: {
          total: result.total ?? 0,
          newCount: result.newCount ?? 0,
          duplicateCount: result.duplicateCount ?? 0,
          sampleTitles: result.sampleTitles ?? [],
          warningCount: result.rowIssueCount ?? 0,
        },
      });
    } finally {
      requestInFlightRef.current = false;
    }
  };

  const handleConfirm = async () => {
    if (state.phase !== "preview" || requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setState({ phase: "importing", preview: state.preview });
    try {
      let result:
        Awaited<ReturnType<NonNullable<typeof window.electronAPI.granolaImportRun>>> | undefined;
      try {
        result = await window.electronAPI?.granolaImportRun?.();
      } catch {
        result = undefined;
      }
      if (!result?.success) {
        setState({ phase: "idle" });
        showImportError(result?.error);
        return;
      }
      const imported = result.imported ?? 0;
      setState({ phase: "done", imported, skipped: result.skipped ?? 0 });
      if (imported > 0) {
        // One refresh + one batched sync pass — never per-note pushes.
        void loadFolders();
        void initializeNotesTree();
        void syncService.requestSyncAll("manual");
      }
    } finally {
      requestInFlightRef.current = false;
    }
  };

  const dialogOpen =
    state.phase === "preview" || state.phase === "importing" || state.phase === "done";
  const preview = state.phase === "preview" || state.phase === "importing" ? state.preview : null;

  return (
    <div>
      <SectionHeader
        title={t("settings.granolaImport.title")}
        description={t("settings.granolaImport.howTo")}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settings.granolaImport.title")}
            description={t("settings.granolaImport.description")}
          >
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={state.phase === "picking"}
              onClick={handleChooseFile}
            >
              {state.phase === "picking" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                t("settings.granolaImport.chooseFile")
              )}
            </Button>
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open && state.phase !== "importing") setState({ phase: "idle" });
        }}
      >
        <DialogContent className="sm:max-w-90">
          <DialogHeader>
            <DialogTitle>
              {state.phase === "done"
                ? t("settings.granolaImport.done.title")
                : t("settings.granolaImport.preview.title")}
            </DialogTitle>
            {state.phase === "done" ? (
              <DialogDescription>
                {t("settings.granolaImport.done.summary", {
                  imported: state.imported,
                  skipped: state.skipped,
                })}
              </DialogDescription>
            ) : (
              preview && (
                <DialogDescription>
                  {preview.newCount === 0
                    ? t("settings.granolaImport.preview.nothingNew")
                    : t("settings.granolaImport.preview.summary", {
                        total: preview.total,
                        newCount: preview.newCount,
                        duplicateCount: preview.duplicateCount,
                      })}
                </DialogDescription>
              )
            )}
          </DialogHeader>
          {preview && (
            <div className="space-y-2">
              {preview.sampleTitles.length > 0 && (
                <ul className="text-xs text-muted-foreground space-y-1">
                  {preview.sampleTitles.map((title, index) => (
                    <li key={`${index}-${title}`} className="truncate">
                      {title}
                    </li>
                  ))}
                </ul>
              )}
              {preview.warningCount > 0 && (
                <p className="text-xs text-muted-foreground/80">
                  {t("settings.granolaImport.preview.warnings", {
                    warningCount: preview.warningCount,
                  })}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            {state.phase === "done" ? (
              <Button size="sm" onClick={() => setState({ phase: "idle" })}>
                {t("common.close")}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.phase === "importing"}
                  onClick={() => setState({ phase: "idle" })}
                >
                  {t("common.cancel")}
                </Button>
                <Button size="sm" disabled={state.phase === "importing"} onClick={handleConfirm}>
                  {state.phase === "importing" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    t("settings.granolaImport.preview.confirm", {
                      newCount: preview?.newCount ?? 0,
                    })
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TranscriptionSection({
  isSignedIn,
  navigation,
}: {
  isSignedIn: boolean;
  navigation: SettingsNavigationStore;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const {
    setCloudTranscriptionMode,
    useLocalWhisper,
    setUseLocalWhisper,
    updateTranscriptionSettings,
    cloudTranscriptionProvider,
    setCloudTranscriptionProvider,
    cloudTranscriptionModel,
    setCloudTranscriptionModel,
    localTranscriptionProvider,
    setLocalTranscriptionProvider,
    whisperModel,
    setWhisperModel,
    parakeetModel,
    setParakeetModel,
    cohereModel,
    setCohereModel,
    cloudTranscriptionBaseUrl,
    setCloudTranscriptionBaseUrl,
    transcriptionMode,
    setTranscriptionMode,
    remoteTranscriptionUrl,
    setRemoteTranscriptionUrl,
    remoteTranscriptionModel,
    setRemoteTranscriptionModel,
    showTranscriptionPreview,
    setShowTranscriptionPreview,
  } = useSettingsStore(
    useShallow((s) => ({
      setCloudTranscriptionMode: s.setCloudTranscriptionMode,
      useLocalWhisper: s.useLocalWhisper,
      setUseLocalWhisper: s.setUseLocalWhisper,
      updateTranscriptionSettings: s.updateTranscriptionSettings,
      cloudTranscriptionProvider: s.cloudTranscriptionProvider,
      setCloudTranscriptionProvider: s.setCloudTranscriptionProvider,
      cloudTranscriptionModel: s.cloudTranscriptionModel,
      setCloudTranscriptionModel: s.setCloudTranscriptionModel,
      localTranscriptionProvider: s.localTranscriptionProvider,
      setLocalTranscriptionProvider: s.setLocalTranscriptionProvider,
      whisperModel: s.whisperModel,
      setWhisperModel: s.setWhisperModel,
      parakeetModel: s.parakeetModel,
      setParakeetModel: s.setParakeetModel,
      cohereModel: s.cohereModel,
      setCohereModel: s.setCohereModel,
      cloudTranscriptionBaseUrl: s.cloudTranscriptionBaseUrl,
      setCloudTranscriptionBaseUrl: s.setCloudTranscriptionBaseUrl,
      transcriptionMode: s.transcriptionMode,
      setTranscriptionMode: s.setTranscriptionMode,
      remoteTranscriptionUrl: s.remoteTranscriptionUrl,
      setRemoteTranscriptionUrl: s.setRemoteTranscriptionUrl,
      remoteTranscriptionModel: s.remoteTranscriptionModel,
      setRemoteTranscriptionModel: s.setRemoteTranscriptionModel,
      showTranscriptionPreview: s.showTranscriptionPreview,
      setShowTranscriptionPreview: s.setShowTranscriptionPreview,
    }))
  );
  const policySnapshot = usePolicySnapshot();
  const enterpriseTranscriptionSetupMode = useSettingsStore(
    (s) => s.enterpriseTranscriptionSetupMode
  );
  const setEnterpriseTranscriptionSetupMode = useSettingsStore(
    (s) => s.setEnterpriseTranscriptionSetupMode
  );
  const managed = useManagedScopeResolution("transcription", enterpriseTranscriptionSetupMode);
  const managedAvailable = useManagedScopeResolution("transcription", "managed");
  const {
    modes: transcriptionModes,
    effectiveMode: effectiveTranscriptionMode,
    isModeAllowed,
  } = usePolicyModeOptions<InferenceModeOption>(
    [
      {
        id: "openwhispr",
        label: t("settingsPage.transcription.modes.openwhispr"),
        description: t("settingsPage.transcription.modes.openwhisprDesc"),
        icon: <Cloud className="w-4 h-4" />,
        disabled: !isSignedIn,
        signInRequired: !isSignedIn,
      },
      {
        id: "providers",
        label: t("settingsPage.transcription.modes.providers"),
        description: t("settingsPage.transcription.modes.providersDesc"),
        icon: <Key className="w-4 h-4" />,
      },
      {
        id: "local",
        label: t("settingsPage.transcription.modes.local"),
        description: t("settingsPage.transcription.modes.localDesc"),
        icon: <Cpu className="w-4 h-4" />,
      },
      {
        id: "self-hosted",
        label: t("settingsPage.transcription.modes.selfHosted"),
        description: t("settingsPage.transcription.modes.selfHostedDesc"),
        icon: <Network className="w-4 h-4" />,
      },
      ...(isEnterpriseTranscriptionOfferable(policySnapshot)
        ? [
            {
              id: "enterprise" as const,
              label: t("settingsPage.transcription.modes.enterprise"),
              description: t("settingsPage.transcription.modes.enterpriseDesc"),
              icon: <ShieldCheck className="w-4 h-4" />,
            },
          ]
        : []),
    ],
    "transcription",
    transcriptionMode,
    {
      byokProviders: TRANSCRIPTION_POLICY_PROVIDER_IDS,
      enterpriseProviders: TRANSCRIPTION_ENTERPRISE_POLICY_PROVIDER_IDS,
    }
  );
  const handleTranscriptionModeSelect = (mode: InferenceMode) => {
    if (!isModeAllowed(mode)) return;
    if (mode === "openwhispr" && !isSignedIn) {
      requestSignIn();
      return;
    }
    if (mode === effectiveTranscriptionMode) return;
    setTranscriptionMode(mode);
    setUseLocalWhisper(mode === "local");
    updateTranscriptionSettings({ useLocalWhisper: mode === "local" });
    setCloudTranscriptionMode(mode === "openwhispr" ? "openwhispr" : "byok");
    if (mode === "enterprise") setEnterpriseTranscriptionSetupMode("managed");

    const toastKey = {
      openwhispr: "switchedCloud",
      providers: "switchedProviders",
      local: "switchedLocal",
      "self-hosted": "switchedSelfHosted",
      enterprise: "switchedEnterprise",
    }[mode];
    toast({
      title: t(`settingsPage.transcription.toasts.${toastKey}.title`),
      description: t(`settingsPage.transcription.toasts.${toastKey}.description`),
      variant: "success",
      duration: 3000,
    });
  };

  const handleLocalModelSelect = useCallback(
    (modelId: string, providerId?: string) => {
      const provider = providerId ?? localTranscriptionProvider;
      if (provider === "nvidia") {
        setParakeetModel(modelId);
      } else if (provider === "cohere") {
        setCohereModel(modelId);
      } else {
        setWhisperModel(modelId);
      }
    },
    [localTranscriptionProvider, setParakeetModel, setCohereModel, setWhisperModel]
  );

  const selectedCloudModelStreams = Boolean(
    getTranscriptionProvider(cloudTranscriptionProvider)?.models.some(
      (model) => model.id === cloudTranscriptionModel && model.streaming
    )
  );
  const previewAvailable = supportsLiveTranscriptionPreview(
    effectiveTranscriptionMode,
    selectedCloudModelStreams
  );

  const renderPreviewToggle = () => (
    <SettingsPanel>
      <SettingsPanelRow>
        <SettingsRow
          label={t("settingsPage.transcription.transcriptionPreview")}
          description={t("settingsPage.transcription.transcriptionPreviewDescription")}
        >
          <Toggle
            ariaLabel={t("settingsPage.transcription.transcriptionPreview")}
            checked={showTranscriptionPreview}
            onChange={setShowTranscriptionPreview}
          />
        </SettingsRow>
      </SettingsPanelRow>
    </SettingsPanel>
  );

  const renderTranscriptionPicker = (mode?: "cloud" | "local") => (
    <TranscriptionModelPicker
      settingsNavigation={navigation}
      selectedCloudProvider={cloudTranscriptionProvider}
      onCloudProviderSelect={setCloudTranscriptionProvider}
      selectedCloudModel={cloudTranscriptionModel}
      onCloudModelSelect={setCloudTranscriptionModel}
      selectedLocalModel={
        localTranscriptionProvider === "nvidia"
          ? parakeetModel
          : localTranscriptionProvider === "cohere"
            ? cohereModel
            : whisperModel
      }
      onLocalModelSelect={handleLocalModelSelect}
      selectedLocalProvider={localTranscriptionProvider}
      onLocalProviderSelect={setLocalTranscriptionProvider}
      useLocalWhisper={mode === "local" || (!mode && useLocalWhisper)}
      onModeChange={
        mode
          ? noop
          : (isLocal) => {
              setUseLocalWhisper(isLocal);
              updateTranscriptionSettings({ useLocalWhisper: isLocal });
              if (isLocal) setCloudTranscriptionMode("byok");
            }
      }
      mode={mode}
      cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
      setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
      variant="settings"
    />
  );

  // Local decoding still serves meetings and uploads under a managed-config
  // error, so this stays a card alongside the rest of the section (including
  // the GPU selector below) instead of an early return that hides it.
  const errorCard =
    managed.kind === "error" ? (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3" role="alert">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="text-sm font-medium">
              {t("settingsPage.aiModels.managedEnterprise.errorTitle")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {managed.messageKey ? t(managed.messageKey) : managed.message}
            </p>
          </div>
        </div>
      </div>
    ) : null;

  const managedCard =
    managed.kind === "managed" ? (
      <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
        <div className="flex items-start gap-2.5">
          <div className="rounded-md bg-primary/10 p-1.5 text-primary">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {t("settingsPage.aiModels.managedEnterprise.title")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {enterpriseProviderName(managed.provider)} ·{" "}
              <span className="font-mono">{managed.model}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settingsPage.aiModels.managedEnterprise.description")}
            </p>
          </div>
        </div>
        {managed.mode !== "managed_required" && managed.allowManualSetup && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEnterpriseTranscriptionSetupMode("manual")}
            >
              {t("settingsPage.aiModels.managedEnterprise.usePersonalSetup")}
            </Button>
          </div>
        )}
      </div>
    ) : null;

  return (
    <div className="space-y-4">
      {errorCard}
      {managedCard}
      {!errorCard && !managedCard && (
        <>
          {enterpriseTranscriptionSetupMode === "manual" && managedAvailable.kind === "managed" && (
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {t("settingsPage.aiModels.managedEnterprise.availableTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settingsPage.aiModels.managedEnterprise.availableDescription", {
                    provider: enterpriseProviderName(managedAvailable.provider),
                  })}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setEnterpriseTranscriptionSetupMode("managed")}
              >
                {t("settingsPage.aiModels.managedEnterprise.useManaged")}
              </Button>
            </div>
          )}
          <InferenceModeSelector
            modes={transcriptionModes}
            activeMode={effectiveTranscriptionMode}
            onSelect={handleTranscriptionModeSelect}
          />

          {effectiveTranscriptionMode === "providers" && renderTranscriptionPicker("cloud")}
          {effectiveTranscriptionMode === "local" && renderTranscriptionPicker("local")}
          {previewAvailable && renderPreviewToggle()}

          {effectiveTranscriptionMode === "self-hosted" && (
            <SelfHostedPanel
              service="transcription"
              url={remoteTranscriptionUrl}
              onUrlChange={setRemoteTranscriptionUrl}
              model={remoteTranscriptionModel}
              onModelChange={setRemoteTranscriptionModel}
            />
          )}
        </>
      )}

      {/* Local decoding still serves meetings and uploads, so the GPU choice stays reachable. */}
      <GpuDeviceSelector purpose="transcription" />
    </div>
  );
}

// Only validated auth comes from SettingsPage; settings/policy/locale updates
// belong to the retained children. Avoid mounting a second auth sync owner.
const DictationPanel = React.memo(function DictationPanel({
  isSignedIn,
  navigation,
}: {
  isSignedIn: boolean;
  navigation: SettingsNavigationStore;
}) {
  return (
    <div className="space-y-6">
      <TranscriptionSection isSignedIn={isSignedIn} navigation={navigation} />
      <WhisperVadSettings context="dictation" />
    </div>
  );
});
// "Gabriel Stein" → "GS"; single names fall back to their first letter.
function nameInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function AccountAvatar({ image, name }: { image?: string | null; name: string }) {
  // Same stale-URL fallback as MemberAvatar: OAuth-hosted images expire, and a
  // bare <img> would render the broken-image glyph instead of the initials.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const initials = nameInitials(name);
  return (
    <div
      className={cn(
        "w-10 h-10 rounded-full flex items-center justify-center shrink-0 overflow-hidden",
        GRADIENT_CIRCLE
      )}
    >
      {image && image !== failedSrc ? (
        <img
          src={image}
          alt={name}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(image)}
          className="w-10 h-10 rounded-full object-cover"
        />
      ) : initials ? (
        <span className="text-[13px] font-semibold leading-none select-none">{initials}</span>
      ) : (
        <UserCircle className="w-5 h-5" />
      )}
    </div>
  );
}

export default function SettingsPage({ navigation }: SettingsPageProps) {
  const activeSection = useStore(navigation, (state) => state.section ?? "general");
  // Stable children still isolate hidden panels from unrelated page renders.
  const speechPanels = useMemo(
    () => ({
      noteRecording: (
        <div className="space-y-6">
          <MeetingTranscriptionPanel navigation={navigation} />
          <WhisperVadSettings context="meeting" />
        </div>
      ),
      upload: (
        <div className="space-y-6">
          <UploadTranscriptionPanel navigation={navigation} />
        </div>
      ),
    }),
    [navigation]
  );
  const settingsId = useId();
  const { isCompact } = useSettingsLayout();
  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  const { autoLearnCorrections, setAutoLearnCorrections } = useAutoLearnCorrections();
  const {
    uiLanguage,
    preferredLanguage,
    chineseScriptPreference,
    microphoneSelectionMode,
    selectedMicDeviceId,
    selectedMicDeviceLabel,
    micWarmHoldSeconds,
    setMicrophoneSelectionMode,
    setSelectedMicDevice,
    setMicWarmHoldSeconds,
    setUiLanguage,
    updateTranscriptionSettings,
    notificationsEnabled,
    setNotificationsEnabled,
    notifyMeetingDetection,
    setNotifyMeetingDetection,
    notifyCalendarReminders,
    setNotifyCalendarReminders,
    audioCuesEnabled,
    setAudioCuesEnabled,
    pauseMediaOnDictation,
    setPauseMediaOnDictation,
    autoPasteEnabled,
    setAutoPasteEnabled,
    keepTranscriptionInClipboard,
    setKeepTranscriptionInClipboard,
    floatingIconAutoHide,
    setFloatingIconAutoHide,
    startMinimized,
    setStartMinimized,
    panelStartPosition,
    setPanelStartPosition,
    cloudBackupEnabled,
    setCloudBackupEnabled,
    insightsSyncEnabled,
    telemetryEnabled,
    setTelemetryEnabled,
    audioRetentionDays,
    setAudioRetentionDays,
    transcriptRetentionDays,
    setTranscriptRetentionDays,
    dataRetentionEnabled,
    setDataRetentionEnabled,
    saveDiscardedTranscriptions,
    setSaveDiscardedTranscriptions,
    noteFilesEnabled,
    setNoteFilesEnabled,
    noteFilesPath,
    setNoteFilesPath,
  } = useSettingsStore(
    useShallow((settings) => ({
      uiLanguage: settings.uiLanguage,
      preferredLanguage: settings.preferredLanguage,
      chineseScriptPreference: settings.chineseScriptPreference,
      microphoneSelectionMode: settings.microphoneSelectionMode,
      selectedMicDeviceId: settings.selectedMicDeviceId,
      selectedMicDeviceLabel: settings.selectedMicDeviceLabel,
      micWarmHoldSeconds: settings.micWarmHoldSeconds,
      setMicrophoneSelectionMode: settings.setMicrophoneSelectionMode,
      setSelectedMicDevice: settings.setSelectedMicDevice,
      setMicWarmHoldSeconds: settings.setMicWarmHoldSeconds,
      setUiLanguage: settings.setUiLanguage,
      updateTranscriptionSettings: settings.updateTranscriptionSettings,
      notificationsEnabled: settings.notificationsEnabled,
      setNotificationsEnabled: settings.setNotificationsEnabled,
      notifyMeetingDetection: settings.notifyMeetingDetection,
      setNotifyMeetingDetection: settings.setNotifyMeetingDetection,
      notifyCalendarReminders: settings.notifyCalendarReminders,
      setNotifyCalendarReminders: settings.setNotifyCalendarReminders,
      audioCuesEnabled: settings.audioCuesEnabled,
      setAudioCuesEnabled: settings.setAudioCuesEnabled,
      pauseMediaOnDictation: settings.pauseMediaOnDictation,
      setPauseMediaOnDictation: settings.setPauseMediaOnDictation,
      autoPasteEnabled: settings.autoPasteEnabled,
      setAutoPasteEnabled: settings.setAutoPasteEnabled,
      keepTranscriptionInClipboard: settings.keepTranscriptionInClipboard,
      setKeepTranscriptionInClipboard: settings.setKeepTranscriptionInClipboard,
      floatingIconAutoHide: settings.floatingIconAutoHide,
      setFloatingIconAutoHide: settings.setFloatingIconAutoHide,
      startMinimized: settings.startMinimized,
      setStartMinimized: settings.setStartMinimized,
      panelStartPosition: settings.panelStartPosition,
      setPanelStartPosition: settings.setPanelStartPosition,
      cloudBackupEnabled: settings.cloudBackupEnabled,
      setCloudBackupEnabled: settings.setCloudBackupEnabled,
      insightsSyncEnabled: settings.insightsSyncEnabled,
      telemetryEnabled: settings.telemetryEnabled,
      setTelemetryEnabled: settings.setTelemetryEnabled,
      audioRetentionDays: settings.audioRetentionDays,
      setAudioRetentionDays: settings.setAudioRetentionDays,
      transcriptRetentionDays: settings.transcriptRetentionDays,
      setTranscriptRetentionDays: settings.setTranscriptRetentionDays,
      dataRetentionEnabled: settings.dataRetentionEnabled,
      setDataRetentionEnabled: settings.setDataRetentionEnabled,
      saveDiscardedTranscriptions: settings.saveDiscardedTranscriptions,
      setSaveDiscardedTranscriptions: settings.setSaveDiscardedTranscriptions,
      noteFilesEnabled: settings.noteFilesEnabled,
      setNoteFilesEnabled: settings.setNoteFilesEnabled,
      noteFilesPath: settings.noteFilesPath,
      setNoteFilesPath: settings.setNoteFilesPath,
    }))
  );

  // The Settings-wide Linux denial listener must work before Hotkeys is visited.
  const setActivationMode = useSettingsStore((s) => s.setActivationMode);

  const settingsPolicyState = usePolicySnapshot();
  const historyLockedByPolicy = lockedLocalHistoryValue(settingsPolicyState) !== null;
  const effectiveDataRetentionEnabled = effectiveLocalHistoryEnabled(
    settingsPolicyState,
    dataRetentionEnabled
  );
  const cloudBackupPolicyAllowed = isCloudBackupAllowed(settingsPolicyState);
  const audioRetentionCap = maxAudioRetentionDays(settingsPolicyState);
  const enforcedAudioRetentionDays = effectiveAudioRetentionDays(
    settingsPolicyState,
    audioRetentionDays
  );

  const { t, i18n } = useTranslation();
  const { toast } = useToast();

  const [isRemovingModels, setIsRemovingModels] = useState(false);
  const [cachePathHint, setCachePathHint] = useState(
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
      ? "%USERPROFILE%\\.cache\\openwhispr"
      : "~/.cache/openwhispr"
  );
  useEffect(() => {
    if (activeSection !== "system") return;
    let active = true;
    window.electronAPI
      ?.getModelCacheRoot?.()
      .then((root) => {
        if (active && root) setCachePathHint(root);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [activeSection]);

  const migration = useMigration();

  const permissionsHook = usePermissions(showAlertDialog);
  const systemAudio = useSystemAudioPermission();
  const [audioStorageUsage, setAudioStorageUsage] = useState<{
    fileCount: number;
    totalBytes: number;
  }>({ fileCount: 0, totalBytes: 0 });
  const audioUsageRequest = useRef(0);

  useEffect(() => {
    if (activeSection !== "privacyData") return;
    const request = ++audioUsageRequest.current;
    let active = true;
    window.electronAPI
      ?.getAudioStorageUsage?.()
      .then((usage: { fileCount: number; totalBytes: number }) => {
        if (active && usage && request === audioUsageRequest.current) setAudioStorageUsage(usage);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [activeSection]);

  const handleClearAllAudio = async () => {
    if (!window.electronAPI?.deleteAllAudio) return;
    try {
      ++audioUsageRequest.current;
      const result = await window.electronAPI.deleteAllAudio();
      const usage = await window.electronAPI.getAudioStorageUsage();
      setAudioStorageUsage(usage);
      toast({
        title: t(result.failed ? "common.error" : "settingsPage.privacy.clearAllAudio"),
        variant: result.failed ? "destructive" : "default",
      });
    } catch {
      toast({ title: t("common.error"), variant: "destructive" });
    }
  };

  // Wayland paste tool status for diagnostics.
  const [ydotoolStatus, setYdotoolStatus] = useState<{
    isLinux: boolean;
    isWayland: boolean;
    hasYdotool: boolean;
    hasYdotoold: boolean;
    hasWtype: boolean;
    daemonRunning: boolean;
    hasService: boolean;
    hasUinput: boolean;
    hasUdevRule: boolean;
    hasGroup: boolean;
    isKde: boolean;
    isWlroots: boolean;
    isCosmic: boolean;
    hasXclip: boolean;
    hasXsel: boolean;
    isNixOS: boolean;
  } | null>(null);
  const [ydotoolGuideKey, setYdotoolGuideKey] = useState<string | null>(null);

  const ydotoolRequest = useRef(0);
  const refreshYdotoolStatus = useCallback(async () => {
    const request = ++ydotoolRequest.current;
    try {
      const status = await window.electronAPI?.getYdotoolStatus?.();
      if (status && request === ydotoolRequest.current) setYdotoolStatus(status);
    } catch {}
  }, []);

  useEffect(() => {
    if (activeSection === "general" && getCachedPlatform() === "linux") {
      void refreshYdotoolStatus();
    }
    const requests = ydotoolRequest;
    return () => {
      ++requests.current;
    };
  }, [activeSection, refreshYdotoolStatus]);

  const { theme, setTheme } = useTheme();
  const usage = useUsage();
  const billingWorkspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const billingWorkspacesLoaded = useWorkspaceStore((s) => s.loaded);
  const [enterpriseCheckoutOpen, setEnterpriseCheckoutOpen] = useState(false);
  const [enterpriseWorkspaceCreateOpen, setEnterpriseWorkspaceCreateOpen] = useState(false);
  // Until the store resolves, an empty list would make enterpriseTileCta answer
  // "createWorkspace" for everyone — including members who must never be routed
  // into creating a workspace. Fall back to contact sales for that window.
  const enterpriseCta: EnterpriseTileCta = billingWorkspacesLoaded
    ? enterpriseTileCta(billingWorkspaces, activeWorkspaceId)
    : { action: "contactSales", ownerName: null };
  const coveringWorkspaces = billingWorkspaces.filter((workspace) =>
    usage?.entitledWorkspaceIds?.includes(workspace.id)
  );
  const coveringWorkspaceNames = coveringWorkspaces.map((workspace) => workspace.name);
  // Reads the usage payload, not the workspace store, so the upgrade affordances
  // stay hidden across the window where the store is still loading.
  const isWorkspaceCovered =
    !usage?.isPersonallySubscribed && (usage?.entitledWorkspaceIds?.length ?? 0) > 0;
  // Null until the store resolves, so the label waits rather than guessing a tier.
  const coveringPlanLabel =
    isWorkspaceCovered && coveringWorkspaces.length
      ? t(
          `settingsPage.workspace.billing.planLabel.${highestPlan(
            coveringWorkspaces.map((workspace) => workspace.plan)
          )}`
        )
      : null;
  const hasShownApproachingToast = useRef(false);
  useEffect(() => {
    if (usage?.isApproachingLimit && !hasShownApproachingToast.current) {
      hasShownApproachingToast.current = true;
      toast({
        title: t("settingsPage.account.toasts.approachingLimit.title"),
        description: t("settingsPage.account.toasts.approachingLimit.description", {
          used: usage.wordsUsed.toLocaleString(i18n.language),
          limit: usage.limit.toLocaleString(i18n.language),
        }),
        duration: 6000,
      });
    }
  }, [usage?.isApproachingLimit, usage?.wordsUsed, usage?.limit, toast, t, i18n.language]);

  const [linuxPttAvailable, setLinuxPttAvailable] = useState(true);

  const platform = getCachedPlatform();

  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartNeedsApproval, setAutoStartNeedsApproval] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);

  const autoStartRequest = useRef(0);
  const autoStartAction = useRef(0);
  const readAutoStartState = useCallback(async () => {
    const request = ++autoStartRequest.current;
    if (!window.electronAPI?.getAutoStartEnabled) {
      setAutoStartLoading(false);
      return;
    }
    setAutoStartLoading(true);
    try {
      const state = await window.electronAPI.getAutoStartEnabled();
      if (request !== autoStartRequest.current) return;
      setAutoStartEnabled(state.enabled);
      setAutoStartNeedsApproval(state.requiresApproval);
    } catch (error) {
      if (request === autoStartRequest.current)
        logger.error("Failed to get auto-start status", error, "settings");
    } finally {
      if (request === autoStartRequest.current) setAutoStartLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeSection !== "general") return;
    void readAutoStartState();
    const requests = autoStartRequest;
    return () => {
      ++requests.current;
    };
  }, [activeSection, readAutoStartState]);

  useEffect(
    () => () => {
      ++autoStartAction.current;
      ++autoStartRequest.current;
    },
    []
  );

  const handleAutoStartChange = async (enabled: boolean) => {
    if (!window.electronAPI?.setAutoStartEnabled) return;
    const action = ++autoStartAction.current;
    const request = ++autoStartRequest.current;
    try {
      setAutoStartLoading(true);
      const result = await window.electronAPI.setAutoStartEnabled(enabled);
      // A completed OS write still needs read-back while Settings is mounted,
      // even if General was hidden meanwhile. Closing Settings ends this owner.
      if (result.success && action === autoStartAction.current) await readAutoStartState();
    } catch (error) {
      if (action === autoStartAction.current)
        logger.error("Failed to set auto-start", error, "settings");
    } finally {
      if (action === autoStartAction.current && request === autoStartRequest.current)
        setAutoStartLoading(false);
    }
  };

  const [noteFilesDefaultPath, setNoteFilesDefaultPath] = useState("");
  const [noteFilesRebuilding, setNoteFilesRebuilding] = useState(false);

  useEffect(() => {
    if (activeSection !== "general" || !noteFilesEnabled) return;
    let active = true;
    window.electronAPI
      ?.noteFilesGetDefaultPath?.()
      .then((p) => {
        if (active && p) setNoteFilesDefaultPath(p);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [activeSection, noteFilesEnabled]);

  const handleNoteFilesToggle = async (enabled: boolean) => {
    setNoteFilesEnabled(enabled);
    await window.electronAPI?.noteFilesSetEnabled?.(enabled, noteFilesPath || undefined);
  };

  const handleNoteFilesChangePath = async () => {
    const result = await window.electronAPI?.noteFilesPickFolder?.();
    if (result?.canceled || !result?.path) return;
    setNoteFilesPath(result.path);
    await window.electronAPI?.noteFilesSetPath?.(result.path);
  };

  const handleNoteFilesRebuild = async () => {
    setNoteFilesRebuilding(true);
    try {
      const result = await window.electronAPI?.noteFilesRebuild?.();
      if (result && !result.success) {
        toast({
          title: t("settings.noteFiles.rebuildError.title"),
          description: result.error || t("settings.noteFiles.rebuildError.description"),
          variant: "destructive",
        });
      }
    } finally {
      setNoteFilesRebuilding(false);
    }
  };

  useEffect(() => {
    const cleanup = window.electronAPI?.onLinuxPttPermissionDenied?.(() => {
      setLinuxPttAvailable(false);
      toast({
        title: t("settingsPage.general.hotkey.linuxPttPermissionTitle"),
        description: t("settingsPage.general.hotkey.linuxPttPermissionDescription"),
        variant: "destructive",
        duration: 15000,
      });
      setActivationMode("tap");
    });
    return () => cleanup?.();
  }, [toast, t, setActivationMode]);

  const resetAccessibilityPermissions = () => {
    const message = t("settingsPage.permissions.resetAccessibility.description");

    showConfirmDialog({
      title: t("settingsPage.permissions.resetAccessibility.title"),
      description: message,
      onConfirm: () => {
        permissionsHook.requestAccessibilityPermission();
      },
    });
  };

  const handleRemoveModels = () => {
    if (isRemovingModels) return;

    showConfirmDialog({
      title: t("settingsPage.developer.removeModels.title"),
      description: t("settingsPage.developer.removeModels.description", { path: cachePathHint }),
      confirmText: t("settingsPage.developer.removeModels.confirmText"),
      variant: "destructive",
      onConfirm: async () => {
        setIsRemovingModels(true);
        try {
          const results = await Promise.allSettled([
            window.electronAPI?.deleteAllWhisperModels?.(),
            window.electronAPI?.deleteAllParakeetModels?.(),
            window.electronAPI?.modelDeleteAll?.(),
          ]);

          const anyFailed = results.some(
            (r) => r.status === "rejected" || r.value?.success !== true
          );

          if (anyFailed) {
            // A partial deletion must refresh inventory without declaring every model gone.
            window.dispatchEvent(new Event("openwhispr-models-cleared"));
            await reconcileLocalModelSelections();
            showAlertDialog({
              title: t("settingsPage.developer.removeModels.failedTitle"),
              description: t("settingsPage.developer.removeModels.failedDescription"),
            });
          } else {
            // Every local model is gone, so no local selection can still resolve.
            clearMissingLocalModelSelections(() => false);
            window.dispatchEvent(new Event("openwhispr-models-cleared"));
            showAlertDialog({
              title: t("settingsPage.developer.removeModels.successTitle"),
              description: t("settingsPage.developer.removeModels.successDescription"),
            });
          }
        } catch {
          showAlertDialog({
            title: t("settingsPage.developer.removeModels.failedTitle"),
            description: t("settingsPage.developer.removeModels.failedDescriptionShort"),
          });
        } finally {
          setIsRemovingModels(false);
        }
      },
    });
  };

  const { isSignedIn, isLoaded, user, refetch } = useAuth();
  const {
    canToggleSync: canToggleInsightsSync,
    disableInsightsSync,
    enableInsightsSync,
    optInDialog: insightsOptInDialog,
    syncAllowedByPolicy: insightsSyncAllowedByPolicy,
  } = useInsightsSyncOptIn();
  const {
    enabled: leaderboardParticipationEnabled,
    error: leaderboardParticipationError,
    join: joinLeaderboard,
    leave: leaveLeaderboard,
    leavePending: leaderboardLeavePending,
    ready: leaderboardParticipationReady,
    updating: leaderboardParticipationUpdating,
  } = useLeaderboardParticipation();
  const [leaderboardPreferencePending, setLeaderboardPreferencePending] = useState(false);
  const updateLeaderboardParticipation = async (enabled: boolean) => {
    if (!isSignedIn || !leaderboardParticipationReady || leaderboardPreferencePending) return;
    setLeaderboardPreferencePending(true);
    try {
      if (enabled) {
        if (
          !effectiveDataRetentionEnabled ||
          !insightsSyncAllowedByPolicy ||
          (!insightsSyncEnabled && !(await enableInsightsSync({ confirmWhenEmpty: true })))
        )
          return;
        if (!(await joinLeaderboard())) {
          toast({
            title: t("insights.leaderboard.activationError"),
            variant: "destructive",
          });
        }
        return;
      }

      if (!(await leaveLeaderboard())) {
        toast({ title: t("insights.leaderboard.leavePending") });
      }
    } finally {
      setLeaderboardPreferencePending(false);
    }
  };
  // Signed out there is nothing to load and the plan grid is purely
  // promotional; signed in, no card may claim a plan until usage confirms one.
  const planStateKnown = !isSignedIn || usage?.status === "success";
  const proCardCta = decideProPlanCardCta({
    isSignedIn,
    planStateKnown,
    isPersonallySubscribed: usage?.isPersonallySubscribed ?? false,
    isStoreBilled: Boolean(usage?.storeBilling),
    plan: usage?.plan ?? "free",
    isTrial: usage?.isTrial ?? false,
    isWorkspaceCovered,
  });
  const storeBilling = usage?.storeBilling ?? null;
  const accountPlan = resolveAccountPlan({
    isTrial: usage?.isTrial ?? false,
    isPastDue: usage?.isPastDue ?? false,
    isPersonallySubscribed: usage?.isPersonallySubscribed ?? false,
    storeBilling,
    isWorkspaceCovered,
    hasPeriodEnd: Boolean(usage?.currentPeriodEnd),
    hasCoveringWorkspaceNames: coveringWorkspaceNames.length > 0,
  });
  const storeUrl = storeBilling?.store ? storeSubscriptionsUrl(storeBilling.store) : null;
  const periodEndDate = usage?.currentPeriodEnd
    ? new Date(usage.currentPeriodEnd).toLocaleDateString(i18n.language, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [deleteAccountTarget, setDeleteAccountTarget] = useState<{
    accountId: string;
    authGeneration: number;
  } | null>(null);
  const [eraseDeviceData, setEraseDeviceData] = useState(false);
  const currentAuthGeneration = getValidatedAuthGeneration();
  const isDeleteAccountDialogOpen = Boolean(
    deleteAccountTarget &&
    isSignedIn &&
    deleteAccountTarget.accountId === user?.id &&
    deleteAccountTarget.authGeneration === currentAuthGeneration &&
    getBoundSessionGeneration(deleteAccountTarget.accountId) === currentAuthGeneration
  );
  if (deleteAccountTarget && !isDeleteAccountDialogOpen) {
    setDeleteAccountTarget(null);
    setEraseDeviceData(false);
  }
  const { openBillingPortal, isOpening: isOpeningBilling } = useBillingPortal(usage);
  const [billingState, setBillingState] = useState<Record<string, boolean>>({
    pro: true,
    business: true,
  });
  const [checkoutProgress, setCheckoutProgress] = useState<{
    tier: string;
    generation: number;
  } | null>(null);
  const checkoutTier =
    checkoutProgress?.generation === currentAuthGeneration ? checkoutProgress.tier : null;
  const [switchPreview, setSwitchPreview] = useState<{
    accountId: string;
    authGeneration: number;
    plan: "monthly" | "annual";
    tier: "pro" | "business";
    immediateAmount: number;
    currency: string;
    newPriceAmount: number;
    newInterval: string;
    nextBillingDate: string | null;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const handleSwitchPlan = async (plan: "monthly" | "annual", tier: "pro" | "business") => {
    const accountId = user?.id;
    const authGeneration = getValidatedAuthGeneration();
    if (!accountId || usage?.status !== "success") return;
    if (authGeneration == null) {
      toast({
        title: t("settingsPage.account.checkout.couldNotOpenTitle"),
        description: t("settingsPage.account.checkout.couldNotOpenDescription"),
      });
      return;
    }
    setPreviewLoading(true);
    try {
      const preview = await usage.previewSwitchPlan({ plan, tier });
      if (authGeneration !== getValidatedAuthGeneration()) return;
      if (!preview.success) {
        toast({
          title: t("settingsPage.account.checkout.couldNotOpenTitle"),
          description: preview.error || t("settingsPage.account.checkout.couldNotOpenDescription"),
        });
        return;
      }
      if (preview.alreadyOnPlan) {
        toast({ title: t("settingsPage.account.pricing.planSwitched") });
        return;
      }
      setSwitchPreview({
        accountId,
        authGeneration,
        plan,
        tier,
        immediateAmount: preview.immediateAmount ?? 0,
        currency: preview.currency ?? "usd",
        newPriceAmount: preview.newPriceAmount ?? 0,
        newInterval: preview.newInterval ?? "month",
        nextBillingDate: preview.nextBillingDate ?? null,
      });
    } finally {
      setPreviewLoading(false);
    }
  };

  const confirmSwitchPlan = async () => {
    if (!switchPreview) return;
    if (
      !isSignedIn ||
      usage?.status !== "success" ||
      switchPreview.accountId !== user?.id ||
      switchPreview.authGeneration !== getValidatedAuthGeneration()
    ) {
      setSwitchPreview(null);
      return;
    }
    const { plan, tier, authGeneration } = switchPreview;
    setSwitchPreview(null);
    const result = await usage.switchPlan({ plan, tier });
    if (authGeneration !== getValidatedAuthGeneration()) return;
    if (result.success) {
      toast({ title: t("settingsPage.account.pricing.planSwitched") });
    } else {
      toast({
        title: t("settingsPage.account.checkout.couldNotOpenTitle"),
        description: result.error || t("settingsPage.account.checkout.couldNotOpenDescription"),
      });
    }
  };

  const handleCheckout = async (plan: "monthly" | "annual", tier: "pro" | "business") => {
    const generation = getValidatedAuthGeneration();
    if (!usage) return;
    if (generation == null) {
      toast({
        title: t("settingsPage.account.checkout.couldNotOpenTitle"),
        description: t("settingsPage.account.checkout.couldNotOpenDescription"),
      });
      return;
    }
    setCheckoutProgress({ tier, generation });
    const result = await usage.openCheckout({ plan, tier });
    if (generation !== getValidatedAuthGeneration()) return;
    setCheckoutProgress(null);
    if (
      !result.success &&
      result.code !== "AUTH_CONTEXT_CHANGED" &&
      result.code !== "AUTH_CONTEXT_UNVALIDATED"
    ) {
      toast({
        title: t("settingsPage.account.checkout.couldNotOpenTitle"),
        description: t("settingsPage.account.checkout.couldNotOpenDescription"),
      });
    }
  };

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      // End a live meeting while its note is still in scope: signing out clears
      // the account scope, and anything said after that could not be saved.
      await stopRecording();
      // Clear account-scoped renderer/session state before ending the session.
      // Workspace-owned rows remain cached behind their membership boundary.
      await syncService.purgeTeamSpacesForSignOut();
      await signOut();
      window.location.reload();
    } catch (error) {
      logger.error("Sign out failed", error, "auth");
      showAlertDialog({
        title: t("settingsPage.account.signOut.failedTitle"),
        description: t("settingsPage.account.signOut.failedDescription"),
      });
    } finally {
      setIsSigningOut(false);
    }
  };

  const handleDeleteAccount = () => {
    const authGeneration = getValidatedAuthGeneration();
    if (
      !isSignedIn ||
      !user?.id ||
      authGeneration == null ||
      getBoundSessionGeneration(user.id) !== authGeneration
    )
      return;
    setEraseDeviceData(false);
    setDeleteAccountTarget({ accountId: user.id, authGeneration });
  };

  const confirmDeleteAccount = async () => {
    if (isDeletingAccount) return;
    const accountId = deleteAccountTarget?.accountId;
    const authGeneration = deleteAccountTarget?.authGeneration;
    if (
      !isSignedIn ||
      !accountId ||
      accountId !== user?.id ||
      authGeneration == null ||
      authGeneration !== getValidatedAuthGeneration() ||
      getBoundSessionGeneration(accountId) !== authGeneration
    ) {
      setDeleteAccountTarget(null);
      showAlertDialog({
        title: t("settingsPage.account.deleteAccount.failedTitle"),
        description: t("settingsPage.account.deleteAccount.failedDescription"),
      });
      return;
    }

    setIsDeletingAccount(true);
    try {
      const result = await executeAccountDeletion({
        eraseDeviceData,
        dependencies: {
          deleteRemoteAccount: () => deleteAccount(authGeneration),
          deleteLocalAccountData: async () => {
            const cleanup = await window.electronAPI?.deleteAccountData?.(
              accountId,
              authGeneration,
              { erasingDevice: eraseDeviceData }
            );
            if (!cleanup?.success) {
              throw new Error(cleanup?.error ?? "Could not remove local account data");
            }
          },
          clearWorkspaceSessionState: () => syncService.purgeTeamSpacesForSignOut(),
          signOut,
          eraseDeviceData: async () => {
            const cleanup = await window.electronAPI?.cleanupApp();
            if (!cleanup?.success) {
              throw new Error(cleanup?.errors?.join(", ") || "Could not erase device data");
            }
          },
        },
      });

      showAlertDialog({
        title: t("settingsPage.account.deleteAccount.successTitle"),
        description:
          result.localCleanupFailures.length > 0
            ? t("settingsPage.account.deleteAccount.partialCleanupDescription")
            : t("settingsPage.account.deleteAccount.successDescription"),
      });
      // cleanup-app leaves the database closed; only a relaunch reopens it.
      setTimeout(() => {
        if (eraseDeviceData) {
          window.electronAPI?.relaunchApp();
        } else {
          window.location.reload();
        }
      }, 1000);
    } catch (error) {
      logger.error("Account deletion failed", error, "auth");
      showAlertDialog({
        title: t("settingsPage.account.deleteAccount.failedTitle"),
        description: t("settingsPage.account.deleteAccount.failedDescription"),
      });
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const renderSectionContent = () => {
    switch (activeSection) {
      case "account":
        return (
          <div className="space-y-5">
            {!AUTH_URL ? (
              <>
                <SectionHeader
                  title={t("settingsPage.account.title")}
                  description={t("settingsPage.account.notConfigured")}
                />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.account.featuresDisabled")}
                      description={t("settingsPage.account.featuresDisabledDescription")}
                    >
                      <Badge variant="warning">{t("settingsPage.account.disabled")}</Badge>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            ) : isLoaded && isSignedIn && user ? (
              <>
                <SectionHeader title={t("settingsPage.account.title")} />
                <ProfileSection
                  key={user.id}
                  name={user.name || ""}
                  onSessionRefresh={() => {
                    void refetch();
                  }}
                />

                <div className="flex justify-end">
                  <Button
                    onClick={handleSignOut}
                    variant="outline"
                    disabled={isSigningOut}
                    size="sm"
                    className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/50"
                  >
                    <LogOut className="me-1.5 h-3.5 w-3.5" />
                    {isSigningOut
                      ? t("settingsPage.account.signOut.signingOut")
                      : t("settingsPage.account.signOut.signOut")}
                  </Button>
                </div>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.account.deleteAccount.label")}
                      description={t("settingsPage.account.deleteAccount.labelDescription")}
                    >
                      <Button
                        onClick={handleDeleteAccount}
                        variant="outline"
                        disabled={isDeletingAccount || currentAuthGeneration == null}
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                      >
                        <Trash2 className="me-1.5 h-3.5 w-3.5" />
                        {isDeletingAccount
                          ? t("settingsPage.account.deleteAccount.deleting")
                          : t("settingsPage.account.deleteAccount.button")}
                      </Button>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            ) : isLoaded ? (
              <>
                <SectionHeader title={t("settingsPage.account.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.account.notSignedIn")}
                      description={t("settingsPage.account.notSignedInDescription")}
                    >
                      <Badge variant="outline">{t("settingsPage.account.offline")}</Badge>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <div className="rounded-lg border border-primary/20 dark:border-primary/15 bg-primary/3 dark:bg-primary/6 p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/15 flex items-center justify-center shrink-0 mt-0.5">
                      <Sparkles className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-2.5">
                      <div>
                        <p className="text-xs font-medium text-foreground">
                          {t("settingsPage.account.trialCta.title")}
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
                          {t("settingsPage.account.trialCta.description")}
                        </p>
                      </div>
                      <Button onClick={requestSignIn} size="sm" className="w-full">
                        <UserCircle className="me-1.5 h-3.5 w-3.5" />
                        {t("settingsPage.account.trialCta.button")}
                      </Button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <SectionHeader title={t("settingsPage.account.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            )}
          </div>
        );

      case "plansBilling":
        return (
          <div className="space-y-5">
            {!AUTH_URL ? (
              <>
                <SectionHeader
                  title={t("settingsPage.account.pricing.title")}
                  description={t("settingsPage.account.notConfigured")}
                />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.account.featuresDisabled")}
                      description={t("settingsPage.account.featuresDisabledDescription")}
                    >
                      <Badge variant="warning">{t("settingsPage.account.disabled")}</Badge>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            ) : isLoaded ? (
              <>
                {isSignedIn && <WorkspaceBillingOverview onRefreshEntitlement={usage?.refetch} />}
                {isSignedIn ? (
                  <div className="space-y-5">
                    <SectionHeader title={t("settingsPage.unifiedBilling.personalPlanTitle")} />
                    {usage?.status === "error" ? (
                      <SettingsPanel>
                        <SettingsPanelRow>
                          <SettingsRow
                            label={t("settingsPage.account.planUnavailable.title")}
                            description={t("settingsPage.account.planUnavailable.description")}
                          >
                            <Button
                              onClick={() => void usage.retry()}
                              variant="outline"
                              size="sm"
                              disabled={usage.isRetrying}
                            >
                              {usage.isRetrying ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                t("common.retry")
                              )}
                            </Button>
                          </SettingsRow>
                        </SettingsPanelRow>
                      </SettingsPanel>
                    ) : usage?.status !== "success" ? (
                      <SettingsPanel>
                        <SettingsPanelRow>
                          <div className="flex items-center justify-between">
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-5 w-16 rounded-full" />
                          </div>
                        </SettingsPanelRow>
                        <SettingsPanelRow>
                          <div className="space-y-2">
                            <Skeleton className="h-3 w-48" />
                            <Skeleton className="h-8 w-full rounded" />
                          </div>
                        </SettingsPanelRow>
                      </SettingsPanel>
                    ) : (
                      <SettingsPanel>
                        {usage.isPastDue && (
                          <SettingsPanelRow>
                            <Alert
                              variant="warning"
                              className="dark:bg-amber-950/50 dark:border-amber-800 dark:text-amber-200 dark:[&>svg]:text-amber-400"
                            >
                              <AlertTriangle className="h-4 w-4" />
                              <AlertTitle>{t("settingsPage.account.pastDue.title")}</AlertTitle>
                              <AlertDescription>
                                {t("settingsPage.account.pastDue.description")}
                              </AlertDescription>
                            </Alert>
                          </SettingsPanelRow>
                        )}

                        <SettingsPanelRow>
                          <SettingsRow
                            label={
                              accountPlan.row === "trial"
                                ? t("settingsPage.account.planLabels.trial")
                                : accountPlan.row === "pastDue"
                                  ? t("settingsPage.account.planLabels.free")
                                  : accountPlan.row === "personal" || accountPlan.row === "store"
                                    ? usage.plan === "business"
                                      ? t("settingsPage.account.planLabels.business")
                                      : t("settingsPage.account.planLabels.pro")
                                    : (coveringPlanLabel ??
                                      t("settingsPage.account.planLabels.free"))
                            }
                            description={
                              accountPlan.description === "trial"
                                ? t("settingsPage.account.planDescriptions.trial", {
                                    days: usage.trialDaysLeft,
                                  })
                                : accountPlan.description === "pastDue"
                                  ? t("settingsPage.account.planDescriptions.pastDue", {
                                      used: usage.wordsUsed.toLocaleString(i18n.language),
                                      limit: usage.limit.toLocaleString(i18n.language),
                                    })
                                  : accountPlan.description === "storePaymentIssue"
                                    ? t("settingsPage.account.planDescriptions.storePaymentIssue")
                                    : accountPlan.description === "accessUntil"
                                      ? t("settingsPage.account.planDescriptions.accessUntil", {
                                          date: periodEndDate,
                                        })
                                      : accountPlan.description === "nextBilling"
                                        ? t("settingsPage.account.planDescriptions.nextBilling", {
                                            date: periodEndDate,
                                          })
                                        : accountPlan.description === "unlimited"
                                          ? t("settingsPage.account.planDescriptions.unlimited")
                                          : accountPlan.description === "providedBy"
                                            ? t("settingsPage.unifiedBilling.providedBy", {
                                                workspaces: coveringWorkspaceNames.join(", "),
                                              })
                                            : t("settingsPage.account.planDescriptions.freeUsage", {
                                                used: usage.wordsUsed.toLocaleString(i18n.language),
                                                limit: usage.limit.toLocaleString(i18n.language),
                                              })
                            }
                          >
                            {accountPlan.row === "trial" ? (
                              <Badge variant="info">{t("settingsPage.account.badges.trial")}</Badge>
                            ) : accountPlan.row === "pastDue" ? (
                              <Badge variant="destructive">
                                {t("settingsPage.account.badges.pastDue")}
                              </Badge>
                            ) : accountPlan.row === "personal" || accountPlan.row === "store" ? (
                              <Badge variant="success">
                                {usage.plan === "business"
                                  ? t("settingsPage.account.badges.business")
                                  : t("settingsPage.account.badges.pro")}
                              </Badge>
                            ) : coveringPlanLabel ? (
                              <Badge variant="success">{coveringPlanLabel}</Badge>
                            ) : usage.isOverLimit ? (
                              <Badge variant="warning">
                                {t("settingsPage.account.badges.limitReached")}
                              </Badge>
                            ) : (
                              <Badge variant="outline">
                                {t("settingsPage.account.badges.free")}
                              </Badge>
                            )}
                          </SettingsRow>
                        </SettingsPanelRow>

                        {!usage.isSubscribed && !usage.isTrial && (
                          <SettingsPanelRow>
                            <div className="space-y-1.5">
                              <Progress
                                value={
                                  usage.limit > 0
                                    ? Math.min(100, (usage.wordsUsed / usage.limit) * 100)
                                    : 0
                                }
                                className={cn(
                                  "h-1.5",
                                  usage.isOverLimit
                                    ? "[&>div]:bg-destructive"
                                    : usage.isApproachingLimit
                                      ? "[&>div]:bg-warning"
                                      : "[&>div]:bg-primary"
                                )}
                              />
                              <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <span className="tabular-nums">
                                  {usage.wordsUsed.toLocaleString(i18n.language)} /{" "}
                                  {usage.limit.toLocaleString(i18n.language)}
                                </span>
                                {usage.isApproachingLimit && (
                                  <span className="text-warning">
                                    {t("settingsPage.account.wordsRemaining", {
                                      remaining: usage.wordsRemaining.toLocaleString(i18n.language),
                                    })}
                                  </span>
                                )}
                                {!usage.isApproachingLimit && !usage.isOverLimit && (
                                  <span>{t("settingsPage.account.rollingWeeklyLimit")}</span>
                                )}
                              </div>
                            </div>
                          </SettingsPanelRow>
                        )}

                        <SettingsPanelRow>
                          {accountPlan.action === "updatePayment" ? (
                            <Button
                              onClick={() => void openBillingPortal()}
                              disabled={isOpeningBilling}
                              size="sm"
                              className="w-full"
                            >
                              {isOpeningBilling ? (
                                <>
                                  <Loader2 size={14} className="animate-spin" />
                                  {t("settingsPage.account.billing.opening")}
                                </>
                              ) : (
                                t("settingsPage.account.billing.updatePaymentMethod")
                              )}
                            </Button>
                          ) : accountPlan.action === "manageInStore" && storeUrl ? (
                            <Button
                              onClick={() => void window.electronAPI?.openExternal?.(storeUrl)}
                              variant="outline"
                              size="sm"
                              className="w-full"
                            >
                              {storeBilling?.store === "play_store"
                                ? t("settingsPage.account.billing.manageInGooglePlay")
                                : t("settingsPage.account.billing.manageInAppStore")}
                            </Button>
                          ) : accountPlan.action === "storeNote" ? (
                            <p className="text-xs text-muted-foreground">
                              {t("settingsPage.account.billing.managedInMobileStore")}
                            </p>
                          ) : accountPlan.action === "manageBilling" ? (
                            <Button
                              onClick={() => void openBillingPortal()}
                              variant="outline"
                              size="sm"
                              className="w-full"
                              disabled={isOpeningBilling}
                            >
                              {isOpeningBilling
                                ? t("settingsPage.account.billing.opening")
                                : t("settingsPage.account.billing.manageBilling")}
                            </Button>
                          ) : accountPlan.action === "none" ? null : (
                            <Button
                              onClick={async () => {
                                const generation = getValidatedAuthGeneration();
                                if (generation == null) {
                                  toast({
                                    title: t("settingsPage.account.checkout.couldNotOpenTitle"),
                                    description: t(
                                      "settingsPage.account.checkout.couldNotOpenDescription"
                                    ),
                                    variant: "destructive",
                                  });
                                  return;
                                }
                                setCheckoutProgress({ tier: "plan-upgrade", generation });
                                const result = await usage.openCheckout({
                                  plan: billingState.pro ? "annual" : "monthly",
                                  tier: "pro",
                                });
                                if (generation !== getValidatedAuthGeneration()) return;
                                setCheckoutProgress(null);
                                if (
                                  !result.success &&
                                  result.code !== "AUTH_CONTEXT_CHANGED" &&
                                  result.code !== "AUTH_CONTEXT_UNVALIDATED"
                                ) {
                                  toast({
                                    title: t("settingsPage.account.checkout.couldNotOpenTitle"),
                                    description: t(
                                      "settingsPage.account.checkout.couldNotOpenDescription"
                                    ),
                                    variant: "destructive",
                                  });
                                }
                              }}
                              size="sm"
                              className="w-full"
                              disabled={checkoutTier === "plan-upgrade"}
                            >
                              {checkoutTier === "plan-upgrade"
                                ? t("settingsPage.account.checkout.opening")
                                : t("settingsPage.account.checkout.upgradeToPro")}
                            </Button>
                          )}
                        </SettingsPanelRow>
                      </SettingsPanel>
                    )}
                  </div>
                ) : null}

                <div className="space-y-5">
                  <SectionHeader title={t("settingsPage.account.pricing.title")} />
                  <div className={`grid gap-1.5 ${isCompact ? "grid-cols-2" : "grid-cols-4"}`}>
                    <div
                      className={cn(
                        "rounded-md p-2.5 flex flex-col",
                        planStateKnown &&
                          !usage?.isPersonallySubscribed &&
                          !storeBilling &&
                          !usage?.isTrial &&
                          !isWorkspaceCovered
                          ? "border-2 border-primary/30 bg-primary/3 dark:border-primary/20 dark:bg-primary/5"
                          : "border border-border/70 dark:border-border-subtle/60 bg-card/30 dark:bg-surface-2/30"
                      )}
                    >
                      <p className="text-xs font-semibold text-foreground">
                        {t("settingsPage.account.pricing.free.name")}
                      </p>
                      <div className="flex items-baseline gap-0.5 mt-0.5">
                        <span className="text-lg font-bold text-foreground">
                          {t("settingsPage.account.pricing.free.price")}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          / {t("settingsPage.account.pricing.free.period")}
                        </span>
                      </div>
                      <ul className="space-y-0.5 mt-2 flex-1">
                        {(
                          t("settingsPage.account.pricing.free.features", {
                            returnObjects: true,
                          }) as string[]
                        ).map((feature, i) =>
                          feature.startsWith("## ") ? (
                            <li
                              key={i}
                              className={`text-[8px] font-semibold uppercase tracking-wide text-muted-foreground/70 ${i > 0 ? "pt-1.5" : ""}`}
                            >
                              {feature.slice(3)}
                            </li>
                          ) : (
                            <li
                              key={i}
                              className="flex items-start gap-1 text-[10px] text-muted-foreground leading-tight"
                            >
                              <Check size={9} className="mt-[2px] text-primary/70 shrink-0" />
                              {feature}
                            </li>
                          )
                        )}
                      </ul>
                      {!isSignedIn ? (
                        <Button
                          onClick={requestSignIn}
                          variant="outline"
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                        >
                          {t("settingsPage.account.signedOutPlans.button")}
                        </Button>
                      ) : usage?.isPersonallySubscribed && !usage?.isTrial ? (
                        <Button
                          onClick={() => void openBillingPortal()}
                          variant="outline"
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                          disabled={isOpeningBilling}
                        >
                          {isOpeningBilling
                            ? t("settingsPage.account.billing.opening")
                            : t("settingsPage.account.pricing.downgrade")}
                        </Button>
                      ) : planStateKnown && !isWorkspaceCovered && !storeBilling ? (
                        <div className="mt-2 text-center">
                          <span className="text-[9px] font-medium text-primary/70">
                            {t("settingsPage.account.pricing.currentPlan")}
                          </span>
                        </div>
                      ) : null}
                    </div>

                    <div
                      className={cn(
                        "rounded-md border-2 p-2.5 flex flex-col",
                        (usage?.isPersonallySubscribed || (storeBilling && !isWorkspaceCovered)) &&
                          usage?.plan === "pro"
                          ? "border-primary/40 bg-primary/5 dark:border-primary/30 dark:bg-primary/8"
                          : "border-primary/20 bg-primary/2 dark:border-primary/15 dark:bg-primary/3"
                      )}
                    >
                      <p className="text-xs font-semibold text-foreground">
                        {t("settingsPage.account.pricing.pro.name")}
                      </p>
                      <button
                        onClick={() => setBillingState((prev) => ({ ...prev, pro: !prev.pro }))}
                        role="switch"
                        aria-checked={billingState.pro}
                        className="flex items-center gap-1.5 mt-1"
                      >
                        <div
                          className={`relative w-7 h-4 rounded-full transition-colors ${billingState.pro ? "bg-primary" : "bg-muted"}`}
                        >
                          <div
                            className={`absolute top-0.5 start-0.5 w-3 h-3 rounded-full bg-white transition-transform ${billingState.pro ? "translate-x-3 rtl:-translate-x-3" : ""}`}
                          />
                        </div>
                        <span className="text-[9px] text-muted-foreground">
                          {t("settingsPage.account.pricing.billedYearly")}
                        </span>
                      </button>
                      <div className="flex items-baseline gap-0.5 mt-1">
                        <span className="text-lg font-bold text-foreground">
                          {billingState.pro
                            ? t("settingsPage.account.pricing.pro.annualEquivalent")
                            : t("settingsPage.account.pricing.pro.monthlyPrice")}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          {t("settingsPage.account.pricing.pro.monthlyPeriod")}
                        </span>
                      </div>
                      <p className="text-[9px] text-muted-foreground/70 mt-1.5">
                        {t("settingsPage.account.pricing.pro.includesPrefix")}
                      </p>
                      <ul className="space-y-0.5 mt-1 flex-1">
                        {(
                          t("settingsPage.account.pricing.pro.features", {
                            returnObjects: true,
                          }) as string[]
                        ).map((feature, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-1 text-[10px] text-muted-foreground leading-tight"
                          >
                            <Check size={9} className="mt-[2px] text-primary shrink-0" />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      {proCardCta === "currentPlan" ? (
                        <div className="mt-2 text-center">
                          <span className="text-[9px] font-medium text-primary">
                            {t("settingsPage.account.pricing.currentPlan")}
                          </span>
                        </div>
                      ) : proCardCta === "downgradeToPro" ? (
                        <Button
                          onClick={() =>
                            handleSwitchPlan(billingState.pro ? "annual" : "monthly", "pro")
                          }
                          disabled={previewLoading || usage.checkoutLoading}
                          variant="outline"
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                        >
                          {previewLoading ? (
                            <Loader2 size={10} className="animate-spin" />
                          ) : (
                            t("settingsPage.account.pricing.downgrade")
                          )}
                        </Button>
                      ) : proCardCta === "signUp" ? (
                        <Button
                          onClick={requestSignIn}
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                        >
                          {t("settingsPage.account.pricing.pro.cta")}
                        </Button>
                      ) : proCardCta === "coveredByWorkspace" ? (
                        <div className="mt-2 text-center">
                          <span className="text-[9px] font-medium text-primary">
                            {t("settingsPage.account.pricing.coveredByWorkspace")}
                          </span>
                        </div>
                      ) : proCardCta === "checkout" ? (
                        <Button
                          onClick={() =>
                            handleCheckout(billingState.pro ? "annual" : "monthly", "pro")
                          }
                          disabled={checkoutTier === "pro"}
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                        >
                          {checkoutTier === "pro" ? (
                            <Loader2 size={10} className="animate-spin" />
                          ) : (
                            t("settingsPage.account.pricing.pro.cta")
                          )}
                        </Button>
                      ) : null}
                    </div>

                    <div className="rounded-md border-2 border-primary/50 bg-primary/8 dark:border-primary/40 dark:bg-primary/10 p-2.5 flex flex-col relative">
                      <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-[8px] font-semibold px-2.5 py-0.5 rounded-full whitespace-nowrap shadow-sm">
                        {t("settingsPage.account.pricing.business.badge")}
                      </span>
                      <p className="text-xs font-semibold text-foreground">
                        {t("settingsPage.account.pricing.business.name")}
                      </p>
                      <button
                        onClick={() =>
                          setBillingState((prev) => ({ ...prev, business: !prev.business }))
                        }
                        role="switch"
                        aria-checked={billingState.business}
                        className="flex items-center gap-1.5 mt-1"
                      >
                        <div
                          className={`relative w-7 h-4 rounded-full transition-colors ${billingState.business ? "bg-primary" : "bg-muted"}`}
                        >
                          <div
                            className={`absolute top-0.5 start-0.5 w-3 h-3 rounded-full bg-white transition-transform ${billingState.business ? "translate-x-3 rtl:-translate-x-3" : ""}`}
                          />
                        </div>
                        <span className="text-[9px] text-muted-foreground">
                          {t("settingsPage.account.pricing.billedYearly")}
                        </span>
                      </button>
                      <div className="flex items-baseline gap-0.5 mt-1">
                        <span className="text-lg font-bold text-foreground">
                          {billingState.business
                            ? t("settingsPage.account.pricing.business.annualEquivalent")
                            : t("settingsPage.account.pricing.business.monthlyPrice")}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          {t("settingsPage.account.pricing.business.monthlyPeriod")}
                        </span>
                      </div>
                      <p className="text-[9px] text-muted-foreground/70 mt-1.5">
                        {t("settingsPage.account.pricing.business.includesPrefix")}
                      </p>
                      <ul className="space-y-0.5 mt-1 flex-1">
                        {(
                          t("settingsPage.account.pricing.business.features", {
                            returnObjects: true,
                          }) as string[]
                        ).map((feature, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-1 text-[10px] text-muted-foreground leading-tight"
                          >
                            <Check size={9} className="mt-[2px] text-primary shrink-0" />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      {!isSignedIn ? (
                        <Button
                          onClick={requestSignIn}
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                        >
                          {t("settingsPage.account.pricing.business.cta")}
                        </Button>
                      ) : (
                        <div className="mt-2 text-center">
                          <span className="text-[9px] font-medium text-primary">
                            {t("settingsPage.unifiedBilling.businessWorkspaceOnly")}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="rounded-md border border-border/70 dark:border-border-subtle/60 bg-card/30 dark:bg-surface-2/30 p-2.5 flex flex-col">
                      <p className="text-xs font-semibold text-foreground">
                        {t("settingsPage.account.pricing.enterprise.name")}
                      </p>
                      <p className="text-[9px] text-muted-foreground mt-1">
                        {t("settingsPage.account.pricing.enterprise.subtitle")}
                      </p>
                      <div className="flex items-baseline gap-0.5 mt-1">
                        <span className="text-lg font-bold text-foreground">
                          {t("settingsPage.account.pricing.enterprise.price")}
                        </span>
                      </div>
                      <p className="text-[9px] text-muted-foreground/70 mt-1.5">
                        {t("settingsPage.account.pricing.enterprise.includesPrefix")}
                      </p>
                      <ul className="space-y-0.5 mt-1 flex-1">
                        {(
                          t("settingsPage.account.pricing.enterprise.features", {
                            returnObjects: true,
                          }) as string[]
                        ).map((feature, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-1 text-[10px] text-muted-foreground leading-tight"
                          >
                            <Check
                              size={9}
                              className="mt-[2px] text-purple-500 dark:text-purple-400 shrink-0"
                            />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      {isSignedIn && enterpriseCta.action !== "contactSales" ? (
                        <div className="mt-2 space-y-1">
                          <Button
                            size="sm"
                            className="w-full h-6 text-[10px]"
                            onClick={() => {
                              if (enterpriseCta.action === "openDialog") {
                                setEnterpriseCheckoutOpen(true);
                              } else {
                                setEnterpriseWorkspaceCreateOpen(true);
                              }
                            }}
                          >
                            {t("settingsPage.account.pricing.enterprise.upgradeCta")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full h-6 text-[10px] text-muted-foreground"
                            onClick={() =>
                              window.electronAPI?.openExternal?.(
                                "https://openwhispr.com/contact-sales"
                              )
                            }
                          >
                            <Mail size={10} />
                            {t("settingsPage.account.pricing.enterprise.cta")}
                          </Button>
                        </div>
                      ) : isSignedIn ? (
                        <div className="mt-2 space-y-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full h-6 text-[10px]"
                            onClick={() =>
                              window.electronAPI?.openExternal?.(
                                "https://openwhispr.com/contact-sales"
                              )
                            }
                          >
                            <Mail size={10} />
                            {t("settingsPage.account.pricing.enterprise.cta")}
                          </Button>
                          {enterpriseCta.action === "contactSales" && enterpriseCta.ownerName && (
                            <p className="text-[10px] text-muted-foreground text-center">
                              {t("settingsPage.account.pricing.enterprise.askOwner", {
                                name: enterpriseCta.ownerName,
                              })}
                            </p>
                          )}
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                          onClick={() =>
                            window.electronAPI?.openExternal?.(
                              "https://openwhispr.com/contact-sales"
                            )
                          }
                        >
                          <Mail size={10} />
                          {t("settingsPage.account.pricing.enterprise.cta")}
                        </Button>
                      )}
                    </div>
                  </div>

                  <Dialog
                    open={!!switchPreview}
                    onOpenChange={(open) => !open && setSwitchPreview(null)}
                  >
                    <DialogContent className="sm:max-w-90">
                      <DialogHeader>
                        <DialogTitle>
                          {t("settingsPage.account.pricing.confirmSwitch.title")}
                        </DialogTitle>
                        <DialogDescription>
                          {switchPreview &&
                            t("settingsPage.account.pricing.confirmSwitch.description", {
                              plan: switchPreview.tier === "pro" ? "Pro" : "Business",
                              interval:
                                switchPreview.plan === "annual"
                                  ? t("settingsPage.account.pricing.confirmSwitch.yearly")
                                  : t("settingsPage.account.pricing.confirmSwitch.monthly"),
                            })}
                        </DialogDescription>
                      </DialogHeader>
                      {switchPreview && (
                        <div className="rounded-lg border border-border/70 dark:border-border-subtle/60 overflow-hidden">
                          <div className="flex justify-between items-center px-3 py-2.5 bg-muted/40 dark:bg-surface-2/50">
                            <span className="text-xs text-muted-foreground">
                              {switchPreview.immediateAmount < 0
                                ? t("settingsPage.account.pricing.confirmSwitch.accountCredit")
                                : t("settingsPage.account.pricing.confirmSwitch.chargeToday")}
                            </span>
                            <span
                              className={cn(
                                "text-sm font-semibold",
                                switchPreview.immediateAmount < 0
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-foreground"
                              )}
                            >
                              {formatAmount(
                                Math.abs(switchPreview.immediateAmount),
                                switchPreview.currency
                              )}
                            </span>
                          </div>
                          <div className="divide-y divide-border/60">
                            <div className="flex justify-between items-center px-3 py-2">
                              <span className="text-xs text-muted-foreground">
                                {t("settingsPage.account.pricing.confirmSwitch.newPrice")}
                              </span>
                              <span className="text-xs font-medium text-foreground">
                                {formatAmount(switchPreview.newPriceAmount, switchPreview.currency)}
                                /
                                {switchPreview.newInterval === "year"
                                  ? t("settingsPage.account.pricing.confirmSwitch.yr")
                                  : t("settingsPage.account.pricing.confirmSwitch.mo")}
                              </span>
                            </div>
                            {switchPreview.nextBillingDate && (
                              <div className="flex justify-between items-center px-3 py-2">
                                <span className="text-xs text-muted-foreground">
                                  {t("settingsPage.account.pricing.confirmSwitch.nextBilling")}
                                </span>
                                <span className="text-xs font-medium text-foreground">
                                  {new Date(switchPreview.nextBillingDate).toLocaleDateString()}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      <DialogFooter>
                        <Button variant="outline" size="sm" onClick={() => setSwitchPreview(null)}>
                          {t("settingsPage.account.pricing.confirmSwitch.cancel")}
                        </Button>
                        <Button
                          size="sm"
                          onClick={confirmSwitchPlan}
                          disabled={usage?.checkoutLoading}
                        >
                          {usage?.checkoutLoading ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            t("settingsPage.account.pricing.confirmSwitch.confirm")
                          )}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  <EnterpriseCheckoutDialog
                    open={enterpriseCheckoutOpen}
                    onOpenChange={setEnterpriseCheckoutOpen}
                    workspaces={billingWorkspaces}
                    onRefreshEntitlement={usage?.refetch}
                  />
                  <CreateWorkspaceDialog
                    open={enterpriseWorkspaceCreateOpen}
                    onOpenChange={setEnterpriseWorkspaceCreateOpen}
                    onCreated={() => setEnterpriseCheckoutOpen(true)}
                  />
                </div>
              </>
            ) : (
              <>
                <SectionHeader title={t("settingsPage.account.pricing.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            )}
          </div>
        );

      case "workspace":
        return <WorkspaceSection />;

      case "general":
        return (
          <div className="space-y-6">
            {/* Appearance */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.appearance.title")}
                description={t("settingsPage.general.appearance.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.appearance.theme")}
                    description={t("settingsPage.general.appearance.themeDescription")}
                  >
                    <div className="inline-flex items-center gap-px p-0.5 bg-muted/60 dark:bg-surface-2 rounded-md">
                      {(
                        [
                          {
                            value: "light",
                            icon: Sun,
                            label: t("settingsPage.general.appearance.light"),
                          },
                          {
                            value: "dark",
                            icon: Moon,
                            label: t("settingsPage.general.appearance.dark"),
                          },
                          {
                            value: "auto",
                            icon: Monitor,
                            label: t("settingsPage.general.appearance.auto"),
                          },
                        ] as const
                      ).map((option) => {
                        const Icon = option.icon;
                        const isSelected = theme === option.value;
                        return (
                          <button
                            key={option.value}
                            onClick={() => setTheme(option.value)}
                            className={`
                              flex items-center gap-1 px-2.5 py-1 rounded-[5px] text-xs font-medium
                              transition-colors duration-100
                              ${
                                isSelected
                                  ? "bg-background dark:bg-surface-raised text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground"
                              }
                            `}
                          >
                            <Icon className={`w-3 h-3 ${isSelected ? "text-primary" : ""}`} />
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Sound Effects */}
            <div>
              <SectionHeader title={t("settingsPage.general.soundEffects.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.soundEffects.dictationSounds")}
                    description={t("settingsPage.general.soundEffects.dictationSoundsDescription")}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.general.soundEffects.dictationSounds")}
                      checked={audioCuesEnabled}
                      onChange={setAudioCuesEnabled}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.soundEffects.pauseMedia")}
                    description={t("settingsPage.general.soundEffects.pauseMediaDescription")}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.general.soundEffects.pauseMedia")}
                      checked={pauseMediaOnDictation}
                      onChange={setPauseMediaOnDictation}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Notifications */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.notifications.title")}
                description={t("settingsPage.general.notifications.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.notifications.disableAll")}
                    description={t("settingsPage.general.notifications.disableAllDescription")}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.general.notifications.disableAll")}
                      checked={!notificationsEnabled}
                      onChange={(v) => setNotificationsEnabled(!v)}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.notifications.meetingDetection")}
                    description={t(
                      "settingsPage.general.notifications.meetingDetectionDescription"
                    )}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.general.notifications.meetingDetection")}
                      checked={notifyMeetingDetection}
                      onChange={setNotifyMeetingDetection}
                      disabled={!notificationsEnabled}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.notifications.calendarReminders")}
                    description={t(
                      "settingsPage.general.notifications.calendarRemindersDescription"
                    )}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.general.notifications.calendarReminders")}
                      checked={notifyCalendarReminders}
                      onChange={setNotifyCalendarReminders}
                      disabled={!notificationsEnabled}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Clipboard */}
            <div>
              <SectionHeader title={t("settingsPage.general.clipboard.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.clipboard.autoPaste")}
                    description={t("settingsPage.general.clipboard.autoPasteDescription")}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.general.clipboard.autoPaste")}
                      checked={autoPasteEnabled}
                      onChange={setAutoPasteEnabled}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.clipboard.keepInClipboard")}
                    description={t("settingsPage.general.clipboard.keepInClipboardDescription")}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.general.clipboard.keepInClipboard")}
                      checked={keepTranscriptionInClipboard}
                      onChange={setKeepTranscriptionInClipboard}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Save Notes as Files */}
            <div>
              <SectionHeader title={t("settings.noteFiles.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.noteFiles.title")}
                    description={t("settings.noteFiles.description")}
                  >
                    <Toggle
                      ariaLabel={t("settings.noteFiles.title")}
                      checked={noteFilesEnabled}
                      onChange={handleNoteFilesToggle}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                {noteFilesEnabled && (
                  <>
                    <SettingsPanelRow>
                      <SettingsRow
                        label={t("settings.noteFiles.path")}
                        description={
                          <span dir="ltr" className="block break-all">
                            {noteFilesPath || noteFilesDefaultPath || "..."}
                          </span>
                        }
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={handleNoteFilesChangePath}
                        >
                          {t("settings.noteFiles.changePath")}
                        </Button>
                      </SettingsRow>
                    </SettingsPanelRow>
                    <SettingsPanelRow>
                      <SettingsRow
                        label={t("settings.noteFiles.rebuild")}
                        description={t("settings.noteFiles.rebuildDescription")}
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={noteFilesRebuilding}
                          onClick={handleNoteFilesRebuild}
                        >
                          {noteFilesRebuilding ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            t("settings.noteFiles.rebuild")
                          )}
                        </Button>
                      </SettingsRow>
                    </SettingsPanelRow>
                  </>
                )}
              </SettingsPanel>
            </div>

            {/* Import from Granola */}
            <GranolaImportSection showAlertDialog={showAlertDialog} />

            {/* Floating Icon */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.floatingIcon.title")}
                description={t("settingsPage.general.floatingIcon.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.floatingIcon.autoHide")}
                    description={t("settingsPage.general.floatingIcon.autoHideDescription")}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.general.floatingIcon.autoHide")}
                      checked={floatingIconAutoHide}
                      onChange={setFloatingIconAutoHide}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.floatingIcon.startPosition")}
                    htmlFor={`${settingsId}-start-position`}
                    description={t("settingsPage.general.floatingIcon.startPositionDescription")}
                  >
                    <select
                      id={`${settingsId}-start-position`}
                      value={panelStartPosition}
                      onChange={(e) =>
                        setPanelStartPosition(
                          e.target.value as "bottom-right" | "center" | "bottom-left"
                        )
                      }
                      className="h-7 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm hover:border-border-hover hover:bg-surface-2/70 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1 transition-colors duration-200"
                    >
                      <option value="bottom-right">
                        {t("settingsPage.general.floatingIcon.bottomRight")}
                      </option>
                      <option value="center">
                        {t("settingsPage.general.floatingIcon.center")}
                      </option>
                      <option value="bottom-left">
                        {t("settingsPage.general.floatingIcon.bottomLeft")}
                      </option>
                    </select>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Language */}
            <div>
              <SectionHeader
                title={t("settings.language.sectionTitle")}
                description={t("settings.language.sectionDescription")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.language.uiLabel")}
                    description={t("settings.language.uiDescription")}
                  >
                    <LanguageSelector
                      ariaLabel={t("settings.language.uiLabel")}
                      value={uiLanguage}
                      onChange={setUiLanguage}
                      options={UI_LANGUAGE_OPTIONS}
                      className="min-w-32"
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.language.transcriptionLabel")}
                    description={t("settings.language.transcriptionDescription")}
                  >
                    <LanguageSelector
                      ariaLabel={t("settings.language.transcriptionLabel")}
                      value={preferredLanguage}
                      onChange={(value) =>
                        updateTranscriptionSettings({ preferredLanguage: value })
                      }
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                {preferredLanguage === "auto" && (
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settings.language.chineseScriptLabel")}
                      description={t("settings.language.chineseScriptDescription")}
                    >
                      <select
                        className={`${RETENTION_SELECT_CLASS} w-44`}
                        aria-label={t("settings.language.chineseScriptLabel")}
                        value={chineseScriptPreference}
                        onChange={(event) =>
                          updateTranscriptionSettings({
                            chineseScriptPreference: event.target.value as ChineseScriptPreference,
                          })
                        }
                      >
                        <option value="as-transcribed">
                          {t("settings.language.chineseScriptAsTranscribed")}
                        </option>
                        <option value="simplified">
                          {t("settings.language.chineseScriptSimplified")}
                        </option>
                        <option value="traditional">
                          {t("settings.language.chineseScriptTraditional")}
                        </option>
                      </select>
                    </SettingsRow>
                  </SettingsPanelRow>
                )}
              </SettingsPanel>
            </div>

            {/* Startup */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.startup.title")}
                description={t("settingsPage.general.startup.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.startup.launchAtLogin")}
                    description={t("settingsPage.general.startup.launchAtLoginDescription")}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.general.startup.launchAtLogin")}
                      checked={autoStartEnabled}
                      onChange={(checked: boolean) => handleAutoStartChange(checked)}
                      disabled={autoStartLoading}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                {autoStartNeedsApproval && (
                  <SettingsPanelRow>
                    <Alert
                      variant="warning"
                      className="dark:bg-amber-950/50 dark:border-amber-800 dark:text-amber-200 dark:[&>svg]:text-amber-400"
                    >
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>
                        {t("settingsPage.general.startup.needsApproval.title")}
                      </AlertTitle>
                      <AlertDescription className="space-y-2">
                        <p>{t("settingsPage.general.startup.needsApproval.description")}</p>
                        <Button
                          onClick={() => void window.electronAPI?.openLoginItemsSettings?.()}
                          variant="outline"
                          size="sm"
                        >
                          {t("settingsPage.general.startup.needsApproval.action")}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  </SettingsPanelRow>
                )}
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.startup.startMinimized")}
                    description={t("settingsPage.general.startup.startMinimizedDescription")}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.general.startup.startMinimized")}
                      checked={startMinimized}
                      onChange={setStartMinimized}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Microphone */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.microphone.title")}
                description={t("settingsPage.general.microphone.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <MicrophoneSettings
                    microphoneSelectionMode={microphoneSelectionMode}
                    selectedMicDeviceId={selectedMicDeviceId}
                    selectedMicDeviceLabel={selectedMicDeviceLabel}
                    micWarmHoldSeconds={micWarmHoldSeconds}
                    onSelectionModeChange={setMicrophoneSelectionMode}
                    onDeviceSelect={setSelectedMicDevice}
                    onMicWarmHoldSecondsChange={setMicWarmHoldSeconds}
                  />
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Dictionary */}
            <div>
              <SectionHeader
                title={t("settingsPage.dictionary.autoLearnTitle", {
                  defaultValue: "Auto-learn from corrections",
                })}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.dictionary.autoLearnTitle", {
                      defaultValue: "Auto-learn from corrections",
                    })}
                    description={t("settingsPage.dictionary.autoLearnDescription", {
                      defaultValue:
                        "When you correct a transcription in the target app, the corrected word is automatically added to your dictionary.",
                    })}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.dictionary.autoLearnTitle")}
                      checked={autoLearnCorrections}
                      onChange={setAutoLearnCorrections}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Wayland Paste Diagnostics — only on Linux + Wayland */}
            {ydotoolStatus?.isLinux && ydotoolStatus?.isWayland && (
              <div>
                <SectionHeader
                  title={t("settingsPage.general.waylandPaste.title", {
                    defaultValue: "Wayland Paste Setup",
                  })}
                  description={t("settingsPage.general.waylandPaste.description", {
                    defaultValue:
                      "Auto-paste on Wayland uses ydotool or wtype. wtype is preferred on wlroots compositors.",
                  })}
                />
                {(() => {
                  if (ydotoolStatus.isNixOS) {
                    return (
                      <NixOsPasteInfo status={ydotoolStatus} onRecheck={refreshYdotoolStatus} />
                    );
                  }
                  const checks = [
                    {
                      key: "hasWtype",
                      label: "wtype",
                      ok: ydotoolStatus.hasWtype,
                      required: ydotoolStatus.isWlroots || ydotoolStatus.isCosmic,
                      desc: t("settingsPage.general.waylandPaste.wtypeDesc"),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.wtype.step1Title"),
                          desc: t("settingsPage.general.waylandPaste.guide.wtype.step1Desc"),
                          cmds: getLinuxPasteInstallCommands(t, "wtype"),
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.wtype.step2Title"),
                          cmds: [{ cmd: "which wtype" }],
                        },
                      ],
                    },
                    {
                      key: "hasYdotool",
                      label: "ydotool",
                      ok: ydotoolStatus.hasYdotool,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.ydotoolDesc", {
                        defaultValue: "Input automation tool for Wayland",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.ydotool.step1Title", {
                            defaultValue: "Install ydotool",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.ydotool.step1Desc", {
                            defaultValue:
                              "Use your distribution's package manager to install ydotool.",
                          }),
                          cmds: getLinuxPasteInstallCommands(t, "ydotool"),
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.ydotool.step2Title", {
                            defaultValue: "Verify installation",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.ydotool.step2Desc", {
                            defaultValue: "Check that ydotool is available in your PATH.",
                          }),
                          cmds: [{ cmd: "which ydotool" }],
                        },
                      ],
                    },
                    {
                      key: "hasYdotoold",
                      label: "ydotoold",
                      ok: ydotoolStatus.hasYdotoold,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.ydotooldDesc", {
                        defaultValue: "Daemon for ydotool (separate package on Ubuntu/Pop!_OS)",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.ydotoold.step1Title", {
                            defaultValue: "Install ydotoold",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.ydotoold.step1Desc", {
                            defaultValue:
                              "On Ubuntu and Pop!_OS, ydotoold is a separate package. On Fedora, it's included with ydotool.",
                          }),
                          cmds: [
                            {
                              label: "Ubuntu / Pop!_OS / Debian",
                              cmd: "sudo apt install ydotoold",
                            },
                            { label: "Fedora", cmd: "# Already included in the ydotool package" },
                            { label: "Arch Linux", cmd: "# Included in the ydotool package" },
                          ],
                        },
                      ],
                    },
                    {
                      key: "hasUinput",
                      label: "/dev/uinput",
                      ok: ydotoolStatus.hasUinput,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.uinputDesc", {
                        defaultValue: "Kernel input device access",
                      }),
                      note: !ydotoolStatus.hasUinput
                        ? ydotoolStatus.hasUdevRule
                          ? t("settingsPage.general.waylandPaste.uinputRuleFound", {
                              defaultValue: "Rule present but not active. A reboot should fix it.",
                            })
                          : t("settingsPage.general.waylandPaste.uinputRuleMissing", {
                              defaultValue: "no udev rule found",
                            })
                        : undefined,
                      steps:
                        ydotoolStatus.hasUdevRule && !ydotoolStatus.hasUinput
                          ? [
                              {
                                title: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.ruleFoundTitle",
                                  {
                                    defaultValue: "udev rule already configured",
                                  }
                                ),
                                desc: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.ruleFoundDesc",
                                  {
                                    defaultValue:
                                      "The udev rule for /dev/uinput is already on your system but hasn't taken effect. Try reloading:",
                                  }
                                ),
                                cmds: [
                                  {
                                    cmd: "sudo udevadm control --reload-rules && sudo udevadm trigger /dev/uinput",
                                  },
                                ],
                              },
                              {
                                title: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.rebootTitle",
                                  {
                                    defaultValue: "If reloading didn't help, reboot",
                                  }
                                ),
                                desc: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.rebootDesc",
                                  {
                                    defaultValue:
                                      "On some distros, udev changes only apply after a full reboot. Restart your computer and come back to re-check.",
                                  }
                                ),
                              },
                            ]
                          : [
                              {
                                title: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.step1Title",
                                  {
                                    defaultValue: "Create a udev rule",
                                  }
                                ),
                                desc: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.step1Desc",
                                  {
                                    defaultValue:
                                      "This rule grants access to /dev/uinput for users in the input group.",
                                  }
                                ),
                                cmds: [
                                  {
                                    cmd: 'echo \'KERNEL=="uinput", GROUP="input", MODE="0660", TAG+="uaccess"\' | sudo tee /etc/udev/rules.d/70-uinput.rules',
                                  },
                                ],
                              },
                              {
                                title: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.step2Title",
                                  {
                                    defaultValue: "Reload udev rules",
                                  }
                                ),
                                desc: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.step2Desc",
                                  {
                                    defaultValue: "Apply the new rule without rebooting.",
                                  }
                                ),
                                cmds: [
                                  {
                                    cmd: "sudo udevadm control --reload-rules && sudo udevadm trigger /dev/uinput",
                                  },
                                ],
                              },
                            ],
                    },
                    {
                      key: "hasGroup",
                      label: t("settingsPage.general.waylandPaste.inputGroup", {
                        defaultValue: "input group",
                      }),
                      ok: ydotoolStatus.hasGroup,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.inputGroupDesc", {
                        defaultValue: "User must be in the input group (requires re-login)",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.group.step1Title", {
                            defaultValue: "Add your user to the input group",
                          }),
                          cmds: [{ cmd: "sudo usermod -aG input $USER" }],
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.group.step2Title", {
                            defaultValue: "Log out and back in",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.group.step2Desc", {
                            defaultValue:
                              "Group changes only take effect after a new login session. Log out of your desktop and log back in, then reopen OpenWhispr.",
                          }),
                        },
                      ],
                    },
                    {
                      key: "hasService",
                      label: t("settingsPage.general.waylandPaste.service", {
                        defaultValue: "systemd service",
                      }),
                      ok: ydotoolStatus.hasService,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.serviceDesc", {
                        defaultValue: "User service file for auto-starting ydotoold",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.service.step1Title", {
                            defaultValue: "Create the service directory",
                          }),
                          cmds: [{ cmd: "mkdir -p ~/.config/systemd/user" }],
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.service.step2Title", {
                            defaultValue: "Create the service file",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.service.step2Desc", {
                            defaultValue:
                              "This creates a user-level systemd service that starts ydotoold automatically when you log in.",
                          }),
                          cmds: [
                            {
                              cmd: `cat > ~/.config/systemd/user/ydotoold.service << 'EOF'
[Unit]
Description=ydotoold - ydotool daemon
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=/usr/bin/ydotoold
Restart=on-failure
RestartSec=1s

[Install]
WantedBy=graphical-session.target
EOF`,
                            },
                          ],
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.service.step3Title", {
                            defaultValue: "Reload and enable",
                          }),
                          cmds: [
                            {
                              cmd: "systemctl --user daemon-reload && systemctl --user enable ydotoold",
                            },
                          ],
                        },
                      ],
                    },
                    {
                      key: "daemonRunning",
                      label: t("settingsPage.general.waylandPaste.daemon", {
                        defaultValue: "ydotoold daemon",
                      }),
                      ok: ydotoolStatus.daemonRunning,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.daemonDesc", {
                        defaultValue: "Background service must be running",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.daemon.step1Title", {
                            defaultValue: "Start the daemon",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.daemon.step1Desc", {
                            defaultValue: "Start ydotoold and enable it so it runs on every login.",
                          }),
                          cmds: [
                            {
                              cmd: "systemctl --user enable ydotoold && systemctl --user start ydotoold",
                            },
                            {
                              label: "Arch Linux (service is named ydotool.service)",
                              cmd: "systemctl --user enable --now ydotool.service",
                            },
                          ],
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.daemon.step2Title", {
                            defaultValue: "Verify it's running",
                          }),
                          cmds: [
                            { cmd: "systemctl --user status ydotoold" },
                            {
                              label: "Arch Linux",
                              cmd: "systemctl --user status ydotool.service",
                            },
                          ],
                        },
                      ],
                    },
                  ];

                  if (ydotoolStatus.isKde) {
                    checks.push({
                      key: "hasXclip",
                      label: "xclip",
                      ok: ydotoolStatus.hasXclip || ydotoolStatus.hasXsel || false,
                      required: true,
                      desc: t("settingsPage.general.waylandPaste.xclipDesc", {
                        defaultValue: "Clipboard tool for KDE Wayland paste (xclip or xsel)",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.xclip.step1Title", {
                            defaultValue: "Install xclip",
                          }),
                          cmds: [
                            { cmd: "sudo dnf install xclip  # Fedora" },
                            { cmd: "sudo apt install xclip  # Debian/Ubuntu" },
                          ],
                        },
                      ],
                    });
                  }

                  const allOk = checks.filter((c) => c.required).every((c) => c.ok);
                  const activeGuide = checks.find((c) => c.key === ydotoolGuideKey);

                  return (
                    <>
                      {allOk ? (
                        <SettingsPanel>
                          <SettingsPanelRow>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <CircleCheck className="h-4 w-4 text-emerald-500" />
                                <span className="text-sm">
                                  {t("settingsPage.general.waylandPaste.allGoodDesc", {
                                    defaultValue: "Auto-paste is ready to go.",
                                  })}
                                </span>
                              </div>
                              <button
                                onClick={refreshYdotoolStatus}
                                aria-label={t("settingsPage.general.waylandPaste.recheck")}
                                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                              >
                                <RotateCw className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </SettingsPanelRow>
                        </SettingsPanel>
                      ) : (
                        <>
                          <div className="rounded-xl border border-border overflow-hidden">
                            <div className="divide-y divide-border">
                              {checks.map((item) => (
                                <div key={item.key} className="px-4 py-3">
                                  <div className="flex items-center gap-2.5">
                                    {item.ok ? (
                                      <CircleCheck className="h-4 w-4 shrink-0 text-emerald-500" />
                                    ) : (
                                      <CircleX className="h-4 w-4 shrink-0 text-red-500" />
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <span className="text-sm font-medium">{item.label}</span>
                                      <span className="text-xs text-muted-foreground ms-2">
                                        {item.desc}
                                      </span>
                                      {item.note && (
                                        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                                          {item.note}
                                        </p>
                                      )}
                                    </div>
                                    {!item.ok && (
                                      <button
                                        onClick={() => setYdotoolGuideKey(item.key)}
                                        className="shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted transition-colors text-foreground"
                                      >
                                        <BookOpen className="w-3 h-3" />
                                        {t("settingsPage.general.waylandPaste.guide.open", {
                                          defaultValue: "Guide",
                                        })}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                          <button
                            onClick={refreshYdotoolStatus}
                            className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <RotateCw className="w-3 h-3" />
                            {t("settingsPage.general.waylandPaste.recheck", {
                              defaultValue: "Re-check",
                            })}
                          </button>
                        </>
                      )}

                      {/* Step-by-step guide dialog */}
                      <Dialog
                        open={!!activeGuide}
                        onOpenChange={(open) => !open && setYdotoolGuideKey(null)}
                      >
                        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
                          {activeGuide && (
                            <>
                              <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                  <BookOpen className="w-4 h-4" />
                                  {activeGuide.label}
                                </DialogTitle>
                                <DialogDescription>{activeGuide.desc}</DialogDescription>
                              </DialogHeader>
                              <div className="space-y-5 mt-2">
                                {activeGuide.steps.map((step, i) => (
                                  <div key={i}>
                                    <div className="flex items-start gap-3">
                                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">
                                        {i + 1}
                                      </span>
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium">{step.title}</p>
                                        {step.desc && (
                                          <p className="text-xs text-muted-foreground mt-0.5">
                                            {step.desc}
                                          </p>
                                        )}
                                        {step.cmds && step.cmds.length > 0 && (
                                          <div className="mt-2 space-y-2">
                                            {step.cmds.map((c, j) => (
                                              <div key={j}>
                                                {c.label && (
                                                  <p className="text-[11px] text-muted-foreground mb-1">
                                                    {c.label}
                                                  </p>
                                                )}
                                                <div className="flex items-start gap-1.5">
                                                  <pre
                                                    dir="ltr"
                                                    className="flex-1 text-[11px] bg-muted/60 rounded-md px-3 py-2 font-mono whitespace-pre-wrap break-all select-all overflow-x-auto"
                                                  >
                                                    {c.cmd}
                                                  </pre>
                                                  <button
                                                    onClick={() =>
                                                      navigator.clipboard.writeText(c.cmd)
                                                    }
                                                    className="shrink-0 p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                                                    title={t(
                                                      "settingsPage.general.waylandPaste.copy",
                                                      { defaultValue: "Copy" }
                                                    )}
                                                  >
                                                    <Copy className="w-3.5 h-3.5" />
                                                  </button>
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                        </DialogContent>
                      </Dialog>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        );

      case "hotkeys":
      case "speechToText":
      case "llms":
        return null;

      case "privacyData":
        return (
          <div className="space-y-6">
            {/* Privacy */}
            <div>
              <SectionHeader
                title={t("settingsPage.privacy.title")}
                description={t("settingsPage.privacy.description")}
              />

              {isSignedIn && (
                <div className="mb-4">
                  <SettingsPanel className="mb-2">
                    <SettingsPanelRow>
                      <SettingsRow
                        label={t("settingsPage.privacy.cloudBackup")}
                        description={
                          cloudBackupPolicyAllowed
                            ? t("settingsPage.privacy.cloudBackupDescription")
                            : t("common.managedByOrg")
                        }
                      >
                        <Toggle
                          ariaLabel={t("settingsPage.privacy.cloudBackup")}
                          checked={cloudBackupEnabled}
                          disabled={
                            !canChangeCloudBackupPreference(
                              cloudBackupPolicyAllowed,
                              cloudBackupEnabled
                            )
                          }
                          onChange={(v) => {
                            setCloudBackupEnabled(v);
                            if (v) {
                              startMigration().catch(console.error);
                              syncService.requestSyncAll("manual");
                            }
                          }}
                        />
                      </SettingsRow>
                    </SettingsPanelRow>
                  </SettingsPanel>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("settingsPage.privacy.cloudBackupTeamCaveat")}
                  </p>
                  {migration && (
                    <div className="mt-2 space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {t("settingsPage.privacy.cloudNotesMigration", {
                            done: migration.done,
                            total: migration.total,
                          })}
                        </span>
                        <span>{Math.round((migration.done / migration.total) * 100)}%</span>
                      </div>
                      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-primary transition-all duration-300 ease-out"
                          style={{ width: `${(migration.done / migration.total) * 100}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {!migration && cloudBackupEnabled && isSignedIn && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("settingsPage.privacy.cloudNotesMigrationDone")}
                    </p>
                  )}
                  {cloudBackupEnabled &&
                    isSignedIn &&
                    (() => {
                      const lastSyncedAt = localStorage.getItem("lastSyncedAt");
                      if (!lastSyncedAt) return null;
                      const date = new Date(lastSyncedAt);
                      const now = new Date();
                      const diffMs = now.getTime() - date.getTime();
                      const diffMin = Math.floor(diffMs / 60000);
                      const diffHr = Math.floor(diffMs / 3600000);
                      let relative: string;
                      if (diffMin < 1) relative = t("settingsPage.privacy.justNow");
                      else if (diffMin < 60)
                        relative = t("settingsPage.privacy.minutesAgo", { count: diffMin });
                      else if (diffHr < 24)
                        relative = t("settingsPage.privacy.hoursAgo", { count: diffHr });
                      else
                        relative = date.toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        });
                      return (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("settingsPage.privacy.lastSynced", { time: relative })}
                        </p>
                      );
                    })()}
                </div>
              )}

              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.insightsSync")}
                    description={
                      !isSignedIn
                        ? t("settingsPage.privacy.insightsSyncRequiresAccount")
                        : !insightsSyncAllowedByPolicy
                          ? t("common.managedByOrg")
                          : effectiveDataRetentionEnabled
                            ? t("settingsPage.privacy.insightsSyncDescription")
                            : t("settingsPage.privacy.insightsSyncRequiresHistory")
                    }
                  >
                    {/* With history off nothing is counted anywhere: this
                        device records no counter, and the cloud writes none
                        either, because analyticsSyncEnabled withholds the
                        localDate its analytics write requires. Turning this on
                        could therefore only promise a sync that never happens —
                        but an already-on toggle must stay switchable off. */}
                    <Toggle
                      ariaLabel={t("settingsPage.privacy.insightsSync")}
                      checked={insightsSyncEnabled}
                      disabled={
                        !isSignedIn ||
                        !canToggleInsightsSync ||
                        (!effectiveDataRetentionEnabled && !insightsSyncEnabled)
                      }
                      onChange={(enabled) => {
                        if (enabled) void enableInsightsSync();
                        else disableInsightsSync();
                      }}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("insights.leaderboard.title")}
                    description={
                      !isSignedIn
                        ? t("settingsPage.privacy.leaderboardRequiresAccount")
                        : leaderboardParticipationError === "read"
                          ? t("insights.leaderboard.activationError")
                          : leaderboardLeavePending
                            ? t("insights.leaderboard.leavePending")
                            : !insightsSyncAllowedByPolicy
                              ? t("common.managedByOrg")
                              : !effectiveDataRetentionEnabled
                                ? t("settingsPage.privacy.leaderboardRequiresHistory")
                                : t("settingsPage.privacy.leaderboardDescription")
                    }
                  >
                    <Toggle
                      ariaLabel={t("insights.leaderboard.title")}
                      checked={isSignedIn && leaderboardParticipationEnabled}
                      disabled={
                        !isSignedIn ||
                        !leaderboardParticipationReady ||
                        leaderboardPreferencePending ||
                        leaderboardParticipationUpdating ||
                        leaderboardParticipationError === "read" ||
                        (!leaderboardParticipationEnabled &&
                          (!effectiveDataRetentionEnabled ||
                            !insightsSyncAllowedByPolicy ||
                            (!insightsSyncEnabled && !canToggleInsightsSync)))
                      }
                      onChange={(enabled) => void updateLeaderboardParticipation(enabled)}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.usageAnalytics")}
                    description={t("settingsPage.privacy.usageAnalyticsDescription")}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.privacy.usageAnalytics")}
                      checked={telemetryEnabled}
                      onChange={setTelemetryEnabled}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Audio Retention */}
            <div className="border-t border-border/70 pt-6">
              <SectionHeader
                title={t("settingsPage.privacy.audioRetention")}
                description={t("settingsPage.privacy.audioRetentionDescription")}
              />

              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.audioRetention")}
                    htmlFor={`${settingsId}-audio-retention`}
                    description={t("settingsPage.privacy.audioRetentionDescription")}
                  >
                    <select
                      id={`${settingsId}-audio-retention`}
                      value={enforcedAudioRetentionDays}
                      onChange={(e) => {
                        const days = parseInt(e.target.value, 10);
                        if (audioRetentionCap !== null && days > audioRetentionCap) return;
                        setAudioRetentionDays(days);
                      }}
                      className={RETENTION_SELECT_CLASS}
                    >
                      <option value={0}>{t("settingsPage.privacy.audioRetentionDisabled")}</option>
                      {enforcedAudioRetentionDays > 0 &&
                        !RETENTION_DAY_OPTIONS.includes(enforcedAudioRetentionDays) && (
                          <option value={enforcedAudioRetentionDays}>
                            {t("settingsPage.privacy.retentionDays", {
                              count: enforcedAudioRetentionDays,
                            })}
                          </option>
                        )}
                      {RETENTION_DAY_OPTIONS.map((days) => (
                        <option
                          key={days}
                          value={days}
                          disabled={audioRetentionCap !== null && days > audioRetentionCap}
                        >
                          {t("settingsPage.privacy.retentionDays", { count: days })}
                        </option>
                      ))}
                    </select>
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.audioStorageUsage")}
                    description={
                      audioStorageUsage.fileCount > 0
                        ? t("settingsPage.privacy.audioStorageFiles", {
                            count: audioStorageUsage.fileCount,
                            size: formatBytes(audioStorageUsage.totalBytes),
                          })
                        : t("settingsPage.privacy.audioStorageEmpty")
                    }
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={audioStorageUsage.fileCount === 0}
                      onClick={handleClearAllAudio}
                    >
                      {t("settingsPage.privacy.clearAllAudio")}
                    </Button>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Data Retention */}
            <div className="border-t border-border/70 pt-6">
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.dataRetention")}
                    description={
                      historyLockedByPolicy
                        ? t("common.managedByOrg")
                        : t("settingsPage.privacy.dataRetentionDescription")
                    }
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.privacy.dataRetention")}
                      checked={effectiveDataRetentionEnabled}
                      disabled={historyLockedByPolicy}
                      onChange={setDataRetentionEnabled}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.transcriptRetention")}
                    htmlFor={`${settingsId}-transcript-retention`}
                    description={t("settingsPage.privacy.transcriptRetentionDescription")}
                  >
                    <select
                      id={`${settingsId}-transcript-retention`}
                      value={transcriptRetentionDays}
                      disabled={!effectiveDataRetentionEnabled}
                      onChange={(e) => setTranscriptRetentionDays(parseInt(e.target.value, 10))}
                      className={RETENTION_SELECT_CLASS}
                    >
                      <option value={0}>
                        {t("settingsPage.privacy.transcriptRetentionForever")}
                      </option>
                      {RETENTION_DAY_OPTIONS.map((days) => (
                        <option key={days} value={days}>
                          {t("settingsPage.privacy.retentionDays", { count: days })}
                        </option>
                      ))}
                    </select>
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.saveDiscarded")}
                    description={t("settingsPage.privacy.saveDiscardedDescription")}
                  >
                    <Toggle
                      ariaLabel={t("settingsPage.privacy.saveDiscarded")}
                      checked={saveDiscardedTranscriptions}
                      disabled={!effectiveDataRetentionEnabled || enforcedAudioRetentionDays === 0}
                      onChange={setSaveDiscardedTranscriptions}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Permissions */}
            <div className="border-t border-border/70 pt-6">
              <SectionHeader
                title={t("settingsPage.permissions.title")}
                description={t("settingsPage.permissions.description")}
              />

              <div className="space-y-3">
                <PermissionCard
                  icon={Mic}
                  title={t("settingsPage.permissions.microphoneTitle")}
                  description={t("settingsPage.permissions.microphoneDescription")}
                  granted={permissionsHook.micPermissionGranted}
                  onRequest={permissionsHook.requestMicPermission}
                  buttonText={t("settingsPage.permissions.grantAccess")}
                />

                {(platform === "darwin" || canManageSystemAudioInApp(systemAudio)) && (
                  <>
                    {platform === "darwin" && (
                      <PermissionCard
                        icon={Shield}
                        title={t("settingsPage.permissions.accessibilityTitle")}
                        description={t("settingsPage.permissions.accessibilityDescription")}
                        granted={permissionsHook.accessibilityPermissionGranted}
                        onRequest={permissionsHook.requestAccessibilityPermission}
                        buttonText={t("settingsPage.permissions.grantAccess")}
                      />
                    )}
                    {canManageSystemAudioInApp(systemAudio) && (
                      <PermissionCard
                        icon={Monitor}
                        title={t("settingsPage.permissions.systemAudioTitle")}
                        description={t("settingsPage.permissions.systemAudioDescription")}
                        granted={systemAudio.granted}
                        onRequest={systemAudio.request}
                        buttonText={t("settingsPage.permissions.grantAccess")}
                        badge={t("settingsPage.permissions.optional")}
                      />
                    )}
                  </>
                )}
              </div>

              {!permissionsHook.micPermissionGranted && permissionsHook.micPermissionError && (
                <MicPermissionWarning
                  error={permissionsHook.micPermissionError}
                  onOpenSoundSettings={permissionsHook.openSoundInputSettings}
                  onOpenPrivacySettings={permissionsHook.openMicPrivacySettings}
                />
              )}

              {platform === "linux" &&
                permissionsHook.pasteToolsInfo &&
                needsLinuxPasteToolGuidance(permissionsHook.pasteToolsInfo) && (
                  <PasteToolsInfo
                    pasteToolsInfo={permissionsHook.pasteToolsInfo}
                    isChecking={permissionsHook.isCheckingPasteTools}
                    onCheck={permissionsHook.checkPasteToolsAvailability}
                  />
                )}

              {platform === "darwin" && (
                <div className="mt-5">
                  <p className="text-xs font-medium text-foreground mb-3">
                    {t("settingsPage.permissions.troubleshootingTitle")}
                  </p>
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <SettingsRow
                        label={t("settingsPage.permissions.resetAccessibility.label")}
                        description={t(
                          "settingsPage.permissions.resetAccessibility.rowDescription"
                        )}
                      >
                        <Button
                          onClick={resetAccessibilityPermissions}
                          variant="ghost"
                          size="sm"
                          className="text-foreground/70 hover:text-foreground"
                        >
                          {t("settingsPage.permissions.troubleshoot")}
                        </Button>
                      </SettingsRow>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>
              )}
            </div>
          </div>
        );

      case "system":
        return (
          <div className="space-y-6">
            {/* Developer Tools */}
            <div className="mt-6 border-t border-border/70 pt-6">
              <DeveloperSection />
            </div>

            {/* Data Management */}
            <div className="border-t border-border/70 pt-6">
              <SectionHeader
                title={t("settingsPage.developer.dataManagementTitle")}
                description={t("settingsPage.developer.dataManagementDescription")}
              />

              <div className="space-y-4">
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.modelCache")}
                      description={
                        <span dir="ltr" className="block break-all">
                          {cachePathHint}
                        </span>
                      }
                    >
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => window.electronAPI?.openWhisperModelsFolder?.()}
                        >
                          <FolderOpen className="me-1.5 h-3.5 w-3.5" />
                          {t("settingsPage.developer.open")}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={handleRemoveModels}
                          disabled={isRemovingModels}
                        >
                          {isRemovingModels
                            ? t("settingsPage.developer.removing")
                            : t("settingsPage.developer.clearCache")}
                        </Button>
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.resetAppData")}
                      description={t("settingsPage.developer.resetAppDataDescription")}
                    >
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: t("settingsPage.developer.resetAll.title"),
                            description: t("settingsPage.developer.resetAll.description"),
                            onConfirm: async () => {
                              try {
                                try {
                                  await signOut();
                                } catch {}
                                const result = await window.electronAPI?.cleanupApp();
                                showAlertDialog({
                                  title: t(
                                    result?.success
                                      ? "settingsPage.developer.resetAll.successTitle"
                                      : "settingsPage.developer.resetAll.failedTitle"
                                  ),
                                  description: t(
                                    result?.success
                                      ? "settingsPage.developer.resetAll.successDescription"
                                      : "settingsPage.developer.resetAll.failedDescription"
                                  ),
                                });
                                // Cleanup closes the database even when a later step fails.
                                setTimeout(() => window.electronAPI?.relaunchApp(), 1000);
                              } catch {
                                showAlertDialog({
                                  title: t("settingsPage.developer.resetAll.failedTitle"),
                                  description: t(
                                    "settingsPage.developer.resetAll.failedDescription"
                                  ),
                                });
                              }
                            },
                            variant: "destructive",
                            confirmText: t("settingsPage.developer.resetAll.confirmText"),
                          });
                        }}
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                      >
                        {t("common.reset")}
                      </Button>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <>
      {insightsOptInDialog}

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
      />

      <ConfirmDialog
        open={isDeleteAccountDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteAccountTarget(null);
            setEraseDeviceData(false);
          }
        }}
        title={t("settingsPage.account.deleteAccount.title")}
        description={t("settingsPage.account.deleteAccount.description")}
        onConfirm={() => void confirmDeleteAccount()}
        variant="destructive"
        confirmText={t("settingsPage.account.deleteAccount.confirmText")}
        confirmDisabled={isDeletingAccount}
      >
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-border accent-destructive"
            checked={eraseDeviceData}
            onChange={(event) => setEraseDeviceData(event.target.checked)}
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium">
              {t("settingsPage.account.deleteAccount.eraseDeviceLabel")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t("settingsPage.account.deleteAccount.eraseDeviceDescription")}
            </span>
            {eraseDeviceData && (
              <span className="block text-xs font-medium text-destructive">
                {t("settingsPage.account.deleteAccount.eraseDeviceWarning")}
              </span>
            )}
          </span>
        </label>
      </ConfirmDialog>

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Mounted on first visit and kept alive so model-download progress and IPC listeners survive section switches. */}
      <KeepAlive active={activeSection === "speechToText"}>
        <SpeechToTextTabs
          navigation={navigation}
          dictation={<DictationPanel isSignedIn={isSignedIn ?? false} navigation={navigation} />}
          noteRecording={speechPanels.noteRecording}
          upload={speechPanels.upload}
        />
      </KeepAlive>
      <HotkeysSection
        active={activeSection === "hotkeys"}
        linuxPttAvailable={linuxPttAvailable}
        showAlertDialog={showAlertDialog}
      />
      <LlmsKeepAlive navigation={navigation} />
      <SystemUpdates
        active={activeSection === "system"}
        showAlertDialog={showAlertDialog}
        showConfirmDialog={showConfirmDialog}
      />
      {renderSectionContent()}
    </>
  );
}
