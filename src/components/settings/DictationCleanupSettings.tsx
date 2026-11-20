import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { LOCAL_MODELS_CHANGED_EVENT } from "../../hooks/useModelDownload";
import { useAssemblyAiDictationCleanup, usePolicySnapshot } from "../../hooks/usePolicy";
import { selectPolicyEffectiveSettings, useSettingsStore } from "../../stores/settingsStore";
import type { InferenceMode } from "../../types/electron";
import { ChevronDown } from "../icons";
import { Button } from "../ui/button";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { usePanelVisible } from "../ui/usePanelVisible";
import InferenceConfigEditor from "./InferenceConfigEditor";

const copy = "settingsPage.aiModels.assemblyAiCleanup";

// A saved model can outlive its file. An unavailable inventory is not proof of a missing model.
function useMissingLocalModel(check: boolean, model: string): boolean {
  const [missing, setMissing] = useState<string | null>(null);
  useEffect(() => {
    if (!check || !model) {
      setMissing(null);
      return;
    }
    let version = 0;
    const refresh = async (): Promise<void> => {
      const request = ++version;
      const models = await window.electronAPI?.modelGetAll?.().catch(() => undefined);
      if (request === version) {
        setMissing(
          models && !models.some((entry) => entry.id === model && entry.isDownloaded) ? model : null
        );
      }
    };
    void refresh();
    window.addEventListener(LOCAL_MODELS_CHANGED_EVENT, refresh);
    window.addEventListener("openwhispr-models-cleared", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      version++;
      window.removeEventListener(LOCAL_MODELS_CHANGED_EVENT, refresh);
      window.removeEventListener("openwhispr-models-cleared", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [check, model]);
  return check && (!model || missing === model);
}

interface Props {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onModeChange: (mode: InferenceMode) => void;
  children?: ReactNode;
}

export default function DictationCleanupSettings({
  enabled,
  onEnabledChange,
  onModeChange,
  children,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const policy = usePolicySnapshot();
  const included = useAssemblyAiDictationCleanup();
  const { mode, model, customized } = useSettingsStore(
    useShallow((state) => {
      const settings = selectPolicyEffectiveSettings(state, policy);
      return {
        mode: settings.cleanupMode,
        model: settings.cleanupModel,
        customized: settings.toneStyleEnabled || Boolean(settings.customPrompts?.cleanup),
      };
    })
  );
  const visible = usePanelVisible();
  const missing = useMissingLocalModel(
    included && enabled && visible && customized && mode === "local",
    model
  );
  const [open, setExpanded] = useState(false);
  useEffect(() => {
    if (missing) setExpanded(true);
    else if (!enabled || !included) setExpanded(false);
  }, [missing, enabled, included]);
  const panelId = useId();
  const localPicker = useRef<HTMLDivElement>(null);
  const editor = (
    <>
      <InferenceConfigEditor
        scope="dictationCleanup"
        onModeChange={onModeChange}
        selectedLabel={included ? t(`${copy}.saved`) : undefined}
        localPickerRef={included ? localPicker : undefined}
      />
      {children}
    </>
  );
  return (
    <div className="space-y-4">
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.aiModels.enableTextCleanup")}
            description={t(
              included
                ? `${copy}.description`
                : "settingsPage.aiModels.enableTextCleanupDescription"
            )}
          >
            <Toggle
              ariaLabel={t("settingsPage.aiModels.enableTextCleanup")}
              checked={enabled}
              onChange={onEnabledChange}
            />
          </SettingsRow>
        </SettingsPanelRow>
        {included && enabled && (
          <SettingsPanelRow>
            <SettingsRow label={t(`${copy}.standard`)} description={t(`${copy}.included`)}>
              <span className="text-xs font-medium">AssemblyAI</span>
            </SettingsRow>
          </SettingsPanelRow>
        )}
      </SettingsPanel>

      {enabled &&
        (included ? (
          <SettingsPanel>
            <SettingsPanelRow>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setExpanded(!open)}
                className="flex w-full items-center gap-2 text-start text-xs"
              >
                <span className="flex-1">
                  <span className="block font-medium">{t(`${copy}.advanced`)}</span>
                  <span className="block mt-0.5 text-muted-foreground">
                    {t(missing && !open ? `${copy}.modelNeeded` : `${copy}.summary`)}
                  </span>
                </span>
                <span>
                  {t(`settingsPage.aiModels.modes.${mode === "self-hosted" ? "selfHosted" : mode}`)}
                </span>
                <ChevronDown aria-hidden className={open ? "size-4 rotate-180" : "size-4"} />
              </button>
            </SettingsPanelRow>
            <div id={panelId} hidden={!open}>
              {open && (
                <SettingsPanelRow>
                  <div className="space-y-3">
                    {missing ? (
                      <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
                        <p className="text-xs font-medium">{t(`${copy}.modelNeeded`)}</p>
                        <p className="text-xs text-muted-foreground">{t(`${copy}.modelHelp`)}</p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            localPicker.current?.focus();
                          }}
                        >
                          {t("models.policy.chooseModel")}
                        </Button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t(`${copy}.advancedHelp`)}</p>
                    )}
                    {editor}
                  </div>
                </SettingsPanelRow>
              )}
            </div>
          </SettingsPanel>
        ) : (
          editor
        ))}
    </div>
  );
}
