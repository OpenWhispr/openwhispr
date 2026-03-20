import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Key } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { HotkeyInput } from "../ui/HotkeyInput";
import { Toggle } from "../ui/toggle";
import { SettingsRow, SettingsPanel, SettingsPanelRow, SectionHeader } from "../ui/SettingsSection";
import ReasoningModelSelector from "../ReasoningModelSelector";
import { getValidationMessage, normalizeHotkey } from "../../utils/hotkeyValidator";
import { getPlatform } from "../../utils/platform";

export default function AgentModeSettings() {
  const { t } = useTranslation();
  const {
    agentEnabled,
    setAgentEnabled,
    agentKey,
    setAgentKey,
    dictationKey,
    meetingKey,
    agentModel,
    setAgentModel,
    agentProvider,
    setAgentProvider,
    agentSystemPrompt,
    setAgentSystemPrompt,
    cloudAgentMode,
    setCloudAgentMode,
    isSignedIn,
    openaiApiKey,
    setOpenaiApiKey,
    anthropicApiKey,
    setAnthropicApiKey,
    geminiApiKey,
    setGeminiApiKey,
    groqApiKey,
    setGroqApiKey,
    customReasoningApiKey,
    setCustomReasoningApiKey,
    cloudReasoningBaseUrl,
    setCloudReasoningBaseUrl,
  } = useSettingsStore();

  const isCloudMode = isSignedIn && cloudAgentMode === "openwhispr";
  const isCustomMode = cloudAgentMode === "byok";

  const validateAgentHotkey = useCallback(
    (hotkey: string) => {
      const formatError = getValidationMessage(hotkey, getPlatform());
      if (formatError) return formatError;
      const platform = getPlatform();
      const normalized = normalizeHotkey(hotkey, platform);
      if (dictationKey && normalizeHotkey(dictationKey, platform) === normalized) {
        return t("hotkey.errors.slotConflict", { slot: t("settingsPage.general.hotkey.title") });
      }
      if (meetingKey && normalizeHotkey(meetingKey, platform) === normalized) {
        return t("hotkey.errors.slotConflict", {
          slot: t("settingsPage.general.meetingHotkey.title"),
        });
      }
      return null;
    },
    [dictationKey, meetingKey, t]
  );

  return (
    <div className="space-y-6">
      <SectionHeader
        title={t("agentMode.settings.title")}
        description={t("agentMode.settings.description")}
      />

      {/* Enable/Disable */}
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("agentMode.settings.enabled")}
            description={t("agentMode.settings.enabledDescription")}
          >
            <Toggle checked={agentEnabled} onChange={setAgentEnabled} />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      {agentEnabled && (
        <>
          {/* Agent Hotkey */}
          <div>
            <SectionHeader
              title={t("agentMode.settings.hotkey")}
              description={t("agentMode.settings.hotkeyDescription")}
            />
            <HotkeyInput value={agentKey} onChange={setAgentKey} validate={validateAgentHotkey} />
          </div>

          {/* Cloud / BYOK toggle */}
          {isSignedIn && (
            <SettingsPanel>
              <SettingsPanelRow>
                <button
                  onClick={() => {
                    if (!isCloudMode) setCloudAgentMode("openwhispr");
                  }}
                  className="w-full flex items-center gap-3 text-left cursor-pointer group"
                >
                  <div
                    className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                      isCloudMode
                        ? "bg-primary/10 dark:bg-primary/15"
                        : "bg-muted/60 dark:bg-surface-raised group-hover:bg-muted dark:group-hover:bg-surface-3"
                    }`}
                  >
                    <Cloud
                      className={`w-4 h-4 transition-colors ${
                        isCloudMode ? "text-primary" : "text-muted-foreground"
                      }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-foreground">
                        {t("agentMode.settings.openwhisprCloud")}
                      </span>
                      {isCloudMode && (
                        <span className="text-xs font-medium text-primary bg-primary/10 dark:bg-primary/15 px-1.5 py-px rounded-sm">
                          {t("common.active")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground/80 mt-0.5">
                      {t("agentMode.settings.openwhisprCloudDescription")}
                    </p>
                  </div>
                  <div
                    className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                      isCloudMode
                        ? "border-primary bg-primary"
                        : "border-border-hover dark:border-border-subtle"
                    }`}
                  >
                    {isCloudMode && (
                      <div className="w-full h-full flex items-center justify-center">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />
                      </div>
                    )}
                  </div>
                </button>
              </SettingsPanelRow>
              <SettingsPanelRow>
                <button
                  onClick={() => {
                    if (!isCustomMode) setCloudAgentMode("byok");
                  }}
                  className="w-full flex items-center gap-3 text-left cursor-pointer group"
                >
                  <div
                    className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                      isCustomMode
                        ? "bg-accent/10 dark:bg-accent/15"
                        : "bg-muted/60 dark:bg-surface-raised group-hover:bg-muted dark:group-hover:bg-surface-3"
                    }`}
                  >
                    <Key
                      className={`w-4 h-4 transition-colors ${
                        isCustomMode ? "text-accent" : "text-muted-foreground"
                      }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-foreground">
                        {t("agentMode.settings.customSetup")}
                      </span>
                      {isCustomMode && (
                        <span className="text-xs font-medium text-accent bg-accent/10 dark:bg-accent/15 px-1.5 py-px rounded-sm">
                          {t("common.active")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground/80 mt-0.5">
                      {t("agentMode.settings.customSetupDescription")}
                    </p>
                  </div>
                  <div
                    className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                      isCustomMode
                        ? "border-accent bg-accent"
                        : "border-border-hover dark:border-border-subtle"
                    }`}
                  >
                    {isCustomMode && (
                      <div className="w-full h-full flex items-center justify-center">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-foreground" />
                      </div>
                    )}
                  </div>
                </button>
              </SettingsPanelRow>
            </SettingsPanel>
          )}

          {/* Model selector — shown when Custom Setup is active or not signed in */}
          {(isCustomMode || !isSignedIn) && (
            <div>
              <SectionHeader
                title={t("agentMode.settings.model")}
                description={t("agentMode.settings.modelDescription")}
              />
              <ReasoningModelSelector
                reasoningModel={agentModel}
                setReasoningModel={setAgentModel}
                localReasoningProvider={agentProvider}
                setLocalReasoningProvider={setAgentProvider}
                cloudReasoningBaseUrl={cloudReasoningBaseUrl}
                setCloudReasoningBaseUrl={setCloudReasoningBaseUrl}
                openaiApiKey={openaiApiKey}
                setOpenaiApiKey={setOpenaiApiKey}
                anthropicApiKey={anthropicApiKey}
                setAnthropicApiKey={setAnthropicApiKey}
                geminiApiKey={geminiApiKey}
                setGeminiApiKey={setGeminiApiKey}
                groqApiKey={groqApiKey}
                setGroqApiKey={setGroqApiKey}
                customReasoningApiKey={customReasoningApiKey}
                setCustomReasoningApiKey={setCustomReasoningApiKey}
              />
            </div>
          )}

          {/* Custom System Prompt */}
          <div>
            <SectionHeader
              title={t("agentMode.settings.systemPrompt")}
              description={t("agentMode.settings.systemPromptDescription")}
            />
            <SettingsPanel>
              <SettingsPanelRow>
                <textarea
                  value={agentSystemPrompt}
                  onChange={(e) => setAgentSystemPrompt(e.target.value)}
                  placeholder={t("agentMode.settings.systemPromptPlaceholder")}
                  rows={4}
                  className="w-full text-xs bg-transparent border border-border/50 rounded-md px-3 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/30 placeholder:text-muted-foreground/50"
                />
              </SettingsPanelRow>
            </SettingsPanel>
          </div>
        </>
      )}
    </div>
  );
}
