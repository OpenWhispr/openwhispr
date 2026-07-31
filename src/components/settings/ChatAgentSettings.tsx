import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { SectionHeader } from "../ui/SettingsSection";
import ApiKeyInput from "../ui/ApiKeyInput";
import InferenceConfigEditor from "./InferenceConfigEditor";

const BRAVE_API_KEYS_URL = "https://brave.com/search/api/";

export default function ChatAgentSettings() {
  const { t } = useTranslation();
  const chatAgentPrompt = useSettingsStore((s) => s.customPrompts.chatAgent);
  const setCustomPrompt = useSettingsStore((s) => s.setCustomPrompt);
  const braveApiKey = useSettingsStore((s) => s.braveApiKey);
  const setBraveApiKey = useSettingsStore((s) => s.setBraveApiKey);

  return (
    <div className="space-y-6">
      <InferenceConfigEditor scope="chatIntelligence" />

      <div>
        <SectionHeader
          title={t("agentMode.settings.webSearch")}
          description={t("agentMode.settings.webSearchDescription")}
        />
        <ApiKeyInput
          apiKey={braveApiKey}
          setApiKey={setBraveApiKey}
          label=""
          ariaLabel={t("agentMode.settings.webSearch")}
          placeholder={t("agentMode.settings.webSearchPlaceholder")}
          helpText={
            <button
              type="button"
              onClick={() => window.electronAPI?.openExternal?.(BRAVE_API_KEYS_URL)}
              className="text-primary hover:underline"
            >
              {t("agentMode.settings.webSearchGetKey")}
            </button>
          }
        />
      </div>

      <div>
        <SectionHeader
          title={t("agentMode.settings.systemPrompt")}
          description={t("agentMode.settings.systemPromptDescription")}
        />
        <textarea
          value={chatAgentPrompt}
          onChange={(e) => setCustomPrompt("chatAgent", e.target.value)}
          placeholder={t("agentMode.settings.systemPromptPlaceholder")}
          rows={4}
          className="w-full text-xs bg-transparent border border-border/50 rounded-md px-3 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/30 placeholder:text-muted-foreground/50"
        />
      </div>
    </div>
  );
}
