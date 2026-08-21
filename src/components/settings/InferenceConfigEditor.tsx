import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Cloud, Key, Cpu, Network, Building2, ShieldCheck, AlertTriangle } from "lucide-react";
import {
  LLM_ENTERPRISE_POLICY_PROVIDER_IDS,
  LLM_POLICY_PROVIDER_IDS,
  useSettingsStore,
  selectPolicyEffectiveSettings,
  selectResolvedLLMConfig,
  setResolvedLLMConfig,
} from "../../stores/settingsStore";
import { usePolicyModeOptions, usePolicySnapshot } from "../../hooks/usePolicy";
import { InferenceModeSelector } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import ReasoningModelSelector from "../ReasoningModelSelector";
import EnterpriseSection from "../EnterpriseSection";
import OpenAICompatiblePanel from "../OpenAICompatiblePanel";
import { Toggle } from "../ui/toggle";
import type { InferenceMode } from "../../types/electron";
import type { InferenceScope } from "../../config/inferenceScopes";
import {
  isProviderValidForMode,
  getCloudModel,
  getLocalModel,
  enterpriseProviderName,
} from "../../models/ModelRegistry";
import { useManagedScopeResolution } from "../../stores/enterpriseIdentityStore";
import TestConnectionButton from "../TestConnectionButton";
import { getEnterpriseCallSettings } from "../../services/ai/enterpriseSettings";
import { Button } from "../ui/button";
import { resetOnboardingProgress } from "../onboarding/flow";

const MODE_LABEL_PREFIX: Record<InferenceScope, string> = {
  dictationCleanup: "settingsPage.aiModels.modes",
  noteFormatting: "settingsPage.aiModels.modes",
  dictationAgent: "dictationAgent.modes",
  dictationAgentVision: "dictationAgent.modes",
  chatIntelligence: "agentMode.settings.modes",
  dictationTranslation: "settingsPage.aiModels.modes",
};

function startCloudOnboarding() {
  localStorage.setItem("pendingCloudMigration", "true");
  resetOnboardingProgress(localStorage);
  window.location.reload();
}

interface InferenceConfigEditorProps {
  scope: InferenceScope;
  onModeChange?: (mode: InferenceMode) => void;
  /** Restrict the selectable modes (e.g. vision override offers cloud/BYOK only). */
  allowedModes?: InferenceMode[];
}

export default function InferenceConfigEditor({
  scope,
  onModeChange,
  allowedModes,
}: InferenceConfigEditorProps) {
  const { t } = useTranslation();
  const policyState = usePolicySnapshot();
  const config = useSettingsStore(
    useShallow((settings) =>
      selectResolvedLLMConfig(selectPolicyEffectiveSettings(settings, policyState), scope)
    )
  );
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const enterpriseSetupMode = useSettingsStore((s) => s.enterpriseSetupMode);
  const setEnterpriseSetupMode = useSettingsStore((s) => s.setEnterpriseSetupMode);
  const managed = useManagedScopeResolution(scope, enterpriseSetupMode);
  const managedAvailable = useManagedScopeResolution(scope, "managed");

  const prefix = MODE_LABEL_PREFIX[scope];
  const { modes, effectiveMode, isModeAllowed } = usePolicyModeOptions<InferenceModeOption>(
    (
      [
        {
          id: "openwhispr",
          label: t(`${prefix}.openwhispr`),
          description: t(`${prefix}.openwhisprDesc`),
          icon: <Cloud className="w-4 h-4" />,
          disabled: !isSignedIn,
          badge: !isSignedIn ? t("common.freeAccountRequired") : undefined,
        },
        {
          id: "providers",
          label: t(`${prefix}.providers`),
          description: t(`${prefix}.providersDesc`),
          icon: <Key className="w-4 h-4" />,
        },
        {
          id: "local",
          label: t(`${prefix}.local`),
          description: t(`${prefix}.localDesc`),
          icon: <Cpu className="w-4 h-4" />,
        },
        {
          id: "self-hosted",
          label: t(`${prefix}.selfHosted`),
          description: t(`${prefix}.selfHostedDesc`),
          icon: <Network className="w-4 h-4" />,
        },
        {
          id: "enterprise",
          label: t(`${prefix}.enterprise`),
          description: t(`${prefix}.enterpriseDesc`),
          icon: <Building2 className="w-4 h-4" />,
        },
      ] as InferenceModeOption[]
    ).filter((mode) => !allowedModes || allowedModes.includes(mode.id)),
    "llm",
    config.mode,
    {
      byokProviders: LLM_POLICY_PROVIDER_IDS,
      enterpriseProviders: LLM_ENTERPRISE_POLICY_PROVIDER_IDS,
    }
  );

  const setField = useCallback(
    <K extends keyof Omit<typeof config, "scope">>(field: K) =>
      (value: NonNullable<(typeof config)[K]>) => {
        setResolvedLLMConfig(scope, { [field]: value });
      },
    [scope]
  );

  const handleModeSelect = useCallback(
    (mode: InferenceMode) => {
      if (!isModeAllowed(mode)) return;
      if (mode === "openwhispr" && !isSignedIn) {
        startCloudOnboarding();
        return;
      }
      if (mode === effectiveMode) return;

      const patch: Parameters<typeof setResolvedLLMConfig>[1] = {
        mode,
        cloudMode: mode === "openwhispr" ? "openwhispr" : "byok",
      };
      if (!isProviderValidForMode(config.provider, mode)) {
        patch.provider = "";
        patch.model = "";
      }
      setResolvedLLMConfig(scope, patch);

      if (mode === "openwhispr" || mode === "self-hosted" || mode === "enterprise") {
        window.electronAPI?.llamaServerStop?.();
      }

      onModeChange?.(mode);
    },
    [scope, config.provider, effectiveMode, isSignedIn, onModeChange, isModeAllowed]
  );

  const setMode = setField("mode");
  const setProvider = setField("provider");
  const setModel = setField("model");

  const renderModelSelector = (mode?: "cloud" | "local") => (
    <ReasoningModelSelector
      reasoningModel={config.model}
      setReasoningModel={setModel}
      localReasoningProvider={config.provider}
      setLocalReasoningProvider={setProvider}
      cloudReasoningBaseUrl={config.cloudBaseUrl ?? ""}
      setCloudReasoningBaseUrl={setField("cloudBaseUrl")}
      customReasoningApiKey={config.customApiKey ?? ""}
      setCustomReasoningApiKey={setField("customApiKey")}
      setReasoningMode={setMode}
      mode={mode}
    />
  );

  const showThinkingToggle =
    effectiveMode === "self-hosted" ||
    (effectiveMode === "providers" &&
      (config.provider === "custom" ||
        config.provider === "openrouter" ||
        !!getCloudModel(config.model)?.supportsThinking)) ||
    (effectiveMode === "local" && !!getLocalModel(config.model)?.supportsThinking);

  if (managed.kind === "error") {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3" role="alert">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="text-sm font-medium">
              {t("settingsPage.aiModels.managedEnterprise.errorTitle")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{managed.message}</p>
          </div>
        </div>
      </div>
    );
  }

  if (managed.kind === "managed") {
    return (
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
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <TestConnectionButton
            provider={managed.provider}
            getConfig={() => ({
              ...getEnterpriseCallSettings(managed.provider, scope),
              model: managed.model,
            })}
          />
          {managed.mode !== "managed_required" && managed.allowManualSetup && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEnterpriseSetupMode("manual")}
            >
              {t("settingsPage.aiModels.managedEnterprise.usePersonalSetup")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {enterpriseSetupMode === "manual" && managedAvailable.kind === "managed" && (
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
            onClick={() => setEnterpriseSetupMode("managed")}
          >
            {t("settingsPage.aiModels.managedEnterprise.useManaged")}
          </Button>
        </div>
      )}
      <InferenceModeSelector modes={modes} activeMode={effectiveMode} onSelect={handleModeSelect} />

      {effectiveMode === "providers" && renderModelSelector("cloud")}
      {effectiveMode === "local" && renderModelSelector("local")}

      {effectiveMode === "self-hosted" && (
        <OpenAICompatiblePanel
          baseUrl={config.remoteUrl ?? ""}
          setBaseUrl={setField("remoteUrl")}
          apiKey={config.customApiKey ?? ""}
          setApiKey={setField("customApiKey")}
          model={config.model}
          setModel={setModel}
          baseUrlPlaceholder="http://192.168.1.126:11434/v1"
          helpExamples={
            <p className="text-xs text-muted-foreground">
              {t("reasoning.selfHosted.endpointHelp")}
            </p>
          }
        />
      )}

      {showThinkingToggle && (
        <div className="flex items-start justify-between gap-3 pt-1">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-foreground">
              {t("reasoning.disableThinking.label")}
            </h4>
            <p className="text-xs text-muted-foreground">{t("reasoning.disableThinking.help")}</p>
          </div>
          <Toggle checked={config.disableThinking} onChange={setField("disableThinking")} />
        </div>
      )}

      {effectiveMode === "enterprise" && (
        <EnterpriseSection
          currentProvider={config.provider}
          reasoningModel={config.model}
          setReasoningModel={setModel}
          setLocalReasoningProvider={setProvider}
        />
      )}
    </div>
  );
}
