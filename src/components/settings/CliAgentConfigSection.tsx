import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useSettingsStore, setResolvedLLMConfig } from "../../stores/settingsStore";
import type { ResolvedLLMConfig } from "../../stores/settingsStore";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "../ui/accordion";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import {
  isCliAgentProvider,
  DEFAULT_CLI_AGENT_PROVIDER,
  type CliAgentProviderId,
} from "../../services/ai/inferenceProviders/cliAgent";

const CLI_OPTIONS: ReadonlyArray<{
  id: CliAgentProviderId;
  label: string;
  modelSuggestions: ReadonlyArray<{ value: string; label: string }>;
  permissionModes: ReadonlyArray<"auto" | "acceptEdits" | "manual" | "bypass">;
}> = [
  {
    id: "claude-code",
    label: "Claude Code",
    modelSuggestions: [
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "haiku", label: "Haiku" },
    ],
    permissionModes: ["auto", "acceptEdits", "manual", "bypass"],
  },
  {
    id: "codex",
    label: "Codex",
    modelSuggestions: [
      { value: "gpt-5.2", label: "GPT-5.2" },
      { value: "gpt-5-mini", label: "GPT-5 Mini" },
    ],
    permissionModes: ["auto", "manual", "bypass"],
  },
] as const;

const MODEL_DEFAULT_VALUE = "__default__";
const MODEL_CUSTOM_VALUE = "__custom__";

const PERMISSION_LABEL_KEY: Record<"auto" | "acceptEdits" | "manual" | "bypass", string> = {
  auto: "permissionAuto",
  acceptEdits: "permissionAcceptEdits",
  manual: "permissionManual",
  bypass: "permissionBypass",
};

export default function CliAgentConfigSection({ config }: { config: ResolvedLLMConfig }) {
  const { t } = useTranslation();
  const permissionMode = useSettingsStore((s) => s.cliAgentPermissionMode);
  const workingDir = useSettingsStore((s) => s.cliAgentWorkingDir);
  const timeoutSeconds = useSettingsStore((s) => s.cliAgentTimeoutSeconds);
  const sessionMinutes = useSettingsStore((s) => s.cliAgentSessionMinutes);
  const extraPrompt = useSettingsStore((s) => s.cliAgentExtraPrompt);
  const {
    setCliAgentPermissionMode,
    setCliAgentWorkingDir,
    setCliAgentTimeoutSeconds,
    setCliAgentSessionMinutes,
    setCliAgentExtraPrompt,
  } = useSettingsStore.getState();

  const [availability, setAvailability] = useState<Record<string, boolean | null>>({});
  useEffect(() => {
    let cancelled = false;
    CLI_OPTIONS.forEach(async ({ id }) => {
      const res = await window.electronAPI?.checkCliAgent?.(id);
      if (!cancelled) setAvailability((prev) => ({ ...prev, [id]: !!res?.available }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const cli = isCliAgentProvider(config.provider) ? config.provider : DEFAULT_CLI_AGENT_PROVIDER;
  const cliOption = CLI_OPTIONS.find((o) => o.id === cli)!;
  const suggestions = cliOption.modelSuggestions;
  const permissionModes = cliOption.permissionModes;
  const permissionSelectValue = permissionModes.includes(permissionMode as any)
    ? permissionMode
    : "auto";
  const setProvider = (provider: string) => {
    setCustomModel(false);
    setResolvedLLMConfig("dictationAgent", { provider, model: "" });
  };
  const setModel = (model: string) => setResolvedLLMConfig("dictationAgent", { model });

  const [customModel, setCustomModel] = useState(false);
  const modelSelectValue =
    customModel || (config.model && !suggestions.some((s) => s.value === config.model))
      ? MODEL_CUSTOM_VALUE
      : config.model || MODEL_DEFAULT_VALUE;
  const onModelSelect = (value: string) => {
    if (value === MODEL_CUSTOM_VALUE) {
      setCustomModel(true);
      return;
    }
    setCustomModel(false);
    setModel(value === MODEL_DEFAULT_VALUE ? "" : value);
  };

  return (
    <div className="space-y-3">
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow label={t("settingsPage.cliAgent.cliLabel")}>
            <div className="flex items-center gap-2">
              {availability[cli] === false && (
                <Badge variant="warning" className="text-[10px]">
                  {t("settingsPage.cliAgent.notFound")}
                </Badge>
              )}
              <Select value={cli} onValueChange={setProvider}>
                <SelectTrigger className="h-9 w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLI_OPTIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id} className="text-xs">
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </SettingsRow>
        </SettingsPanelRow>

        <SettingsPanelRow>
          <SettingsRow label={t("settingsPage.cliAgent.modelLabel")}>
            <Select value={modelSelectValue} onValueChange={onModelSelect}>
              <SelectTrigger className="h-9 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MODEL_DEFAULT_VALUE} className="text-xs">
                  {t("settingsPage.cliAgent.modelDefault")}
                </SelectItem>
                {suggestions.map((suggestion) => (
                  <SelectItem key={suggestion.value} value={suggestion.value} className="text-xs">
                    {suggestion.label}
                  </SelectItem>
                ))}
                <SelectItem value={MODEL_CUSTOM_VALUE} className="text-xs">
                  {t("settingsPage.cliAgent.modelCustom")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          {modelSelectValue === MODEL_CUSTOM_VALUE && (
            <Input
              value={config.model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t("settingsPage.cliAgent.modelDefault")}
              className="text-xs mt-2"
              autoFocus
            />
          )}
        </SettingsPanelRow>

        <SettingsPanelRow>
          <SettingsRow label={t("settingsPage.cliAgent.permissionLabel")}>
            <Select value={permissionSelectValue} onValueChange={setCliAgentPermissionMode}>
              <SelectTrigger className="h-9 w-56 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {permissionModes.map((mode) => (
                  <SelectItem key={mode} value={mode} className="text-xs">
                    {t(`settingsPage.cliAgent.${PERMISSION_LABEL_KEY[mode]}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          {permissionMode === "bypass" && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 dark:bg-warning/10 px-3 py-2 mt-2">
              <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t("settingsPage.cliAgent.permissionBypassWarning")}
              </p>
            </div>
          )}
        </SettingsPanelRow>
      </SettingsPanel>

      <Accordion type="single" collapsible>
        <AccordionItem value="advanced">
          <AccordionTrigger className="text-xs font-medium text-foreground">
            {t("settingsPage.cliAgent.advanced")}
          </AccordionTrigger>
          <AccordionContent>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-foreground">
                  {t("settingsPage.cliAgent.workingDirLabel")}
                </p>
                <Input
                  value={workingDir}
                  onChange={(e) => setCliAgentWorkingDir(e.target.value)}
                  placeholder={t("settingsPage.cliAgent.workingDirPlaceholder")}
                  className="text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-foreground">
                  {t("settingsPage.cliAgent.timeoutLabel")}
                </p>
                <Input
                  type="number"
                  min={1}
                  value={timeoutSeconds}
                  onChange={(e) => setCliAgentTimeoutSeconds(Math.max(0, Number(e.target.value) || 0))}
                  className="text-xs w-32"
                />
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-foreground">
                  {t("settingsPage.cliAgent.sessionLabel")}
                </p>
                <Input
                  type="number"
                  min={0}
                  value={sessionMinutes}
                  onChange={(e) => setCliAgentSessionMinutes(Number(e.target.value) || 0)}
                  className="text-xs w-32"
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {t("settingsPage.cliAgent.sessionHint")}
                </p>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-foreground">
                  {t("settingsPage.cliAgent.extraPromptLabel")}
                </p>
                <Textarea
                  value={extraPrompt}
                  onChange={(e) => setCliAgentExtraPrompt(e.target.value)}
                  placeholder={t("settingsPage.cliAgent.extraPromptPlaceholder")}
                  className="text-xs min-h-[60px]"
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
