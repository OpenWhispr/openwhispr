import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { SectionHeader } from "../ui/SettingsSection";
import InferenceConfigEditor from "./InferenceConfigEditor";

export default function ChatAgentSettings() {
  const { t } = useTranslation();
  const chatAgentPrompt = useSettingsStore((s) => s.customPrompts.chatAgent);
  const setCustomPrompt = useSettingsStore((s) => s.setCustomPrompt);

  return (
    <div className="space-y-6">
      <InferenceConfigEditor scope="chatIntelligence" />

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
