import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Cpu, Network } from "lucide-react";
import {
  useSettingsStore,
  selectResolvedLLMConfig,
  setResolvedLLMConfig,
} from "../../stores/settingsStore";
import { InferenceModeSelector } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import OpenAICompatiblePanel from "../OpenAICompatiblePanel";
import GemmaModelCard from "./GemmaModelCard";
import { Toggle } from "../ui/toggle";
import type { InferenceMode } from "../../types/electron";
import type { InferenceScope } from "../../config/inferenceScopes";
import { getLocalModel, BUILTIN_LOCAL_MODEL_ID } from "../../models/ModelRegistry";

const GEMMA_MODEL_ID = BUILTIN_LOCAL_MODEL_ID;

const MODE_LABEL_PREFIX: Record<InferenceScope, string> = {
  dictationCleanup: "settingsPage.aiModels.modes",
  noteFormatting: "settingsPage.aiModels.modes",
  dictationAgent: "dictationAgent.modes",
  chatIntelligence: "agentMode.settings.modes",
};

interface InferenceConfigEditorProps {
  scope: InferenceScope;
  onModeChange?: (mode: InferenceMode) => void;
}

export default function InferenceConfigEditor({ scope, onModeChange }: InferenceConfigEditorProps) {
  const { t } = useTranslation();
  const config = useSettingsStore(useShallow((s) => selectResolvedLLMConfig(s, scope)));

  const prefix = MODE_LABEL_PREFIX[scope];
  const modes: InferenceModeOption[] = [
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
  ];

  const setField = useCallback(
    <K extends keyof Omit<typeof config, "scope">>(field: K) =>
      (value: NonNullable<(typeof config)[K]>) => {
        setResolvedLLMConfig(scope, { [field]: value });
      },
    [scope]
  );

  const handleModeSelect = useCallback(
    (mode: InferenceMode) => {
      if (mode === config.mode) return;

      const patch: Parameters<typeof setResolvedLLMConfig>[1] = {
        mode,
        cloudMode: "byok",
      };
      // Built-in mode always resolves to the bundled Gemma model.
      if (mode === "local") {
        patch.provider = "local";
        patch.model = GEMMA_MODEL_ID;
      } else if (mode === "self-hosted") {
        // Remote endpoint owns its own model field; clear the stale local one.
        if (config.provider === "local") {
          patch.provider = "";
          patch.model = "";
        }
      }
      setResolvedLLMConfig(scope, patch);

      // Remote endpoints don't use the bundled llama server.
      if (mode === "self-hosted") {
        window.electronAPI?.llamaServerStop?.();
      }

      onModeChange?.(mode);
    },
    [scope, config.mode, config.provider, onModeChange]
  );

  const setModel = setField("model");

  // In the simplified UI, "local" means the bundled Gemma model. If a user is
  // already on local mode but has no model set (e.g. migrated from a removed
  // hosted-cloud mode), point them at Gemma so inference resolves. An existing
  // non-empty local model choice is left untouched.
  useEffect(() => {
    if (config.mode === "local" && !config.model) {
      setResolvedLLMConfig(scope, { provider: "local", model: GEMMA_MODEL_ID });
    }
  }, [scope, config.mode, config.model]);

  const showThinkingToggle =
    config.mode === "self-hosted" ||
    (config.mode === "local" && !!getLocalModel(config.model)?.supportsThinking);

  return (
    <div className="space-y-3">
      <InferenceModeSelector modes={modes} activeMode={config.mode} onSelect={handleModeSelect} />

      {config.mode === "local" && <GemmaModelCard />}

      {config.mode === "self-hosted" && (
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
    </div>
  );
}
