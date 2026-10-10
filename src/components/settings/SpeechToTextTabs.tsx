import { useMemo, type ReactNode } from "react";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import { FileAudio, Mic, Upload } from "../icons";
import { ProviderTabs } from "../ui/ProviderTabs";
import { SectionHeader } from "../ui/SettingsSection";
import type { SettingsNavigationStore } from "../../stores/settingsNavigationStore";
import { TabPanel } from "./KeepAlive";

export default function SpeechToTextTabs({
  navigation,
  dictation,
  noteRecording,
  upload,
}: {
  navigation: SettingsNavigationStore;
  dictation: ReactNode;
  noteRecording: ReactNode;
  upload: ReactNode;
}) {
  const { t } = useTranslation();
  const tab = useStore(navigation, (state) => state.speechTab ?? "dictation");
  const setTab = useStore(navigation, (state) => state.selectSpeechTab);

  // ProviderTabs observes the indicator; keep its list stable until labels change.
  const subTabs = useMemo(
    () => [
      { id: "dictation", name: t("settingsPage.speechToText.tabs.dictation") },
      { id: "noteRecording", name: t("settingsPage.speechToText.tabs.noteRecording") },
      { id: "upload", name: t("settingsPage.speechToText.tabs.upload") },
    ],
    [t]
  );

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("settingsPage.speechToText.title")}
        description={t("settingsPage.speechToText.description")}
      />
      <ProviderTabs
        providers={subTabs}
        selectedId={tab}
        onSelect={setTab}
        renderIcon={(id) =>
          id === "dictation" ? (
            <Mic className="w-3.5 h-3.5" />
          ) : id === "upload" ? (
            <Upload className="w-3.5 h-3.5" />
          ) : (
            <FileAudio className="w-3.5 h-3.5" />
          )
        }
      />
      <TabPanel active={tab === "dictation"}>{dictation}</TabPanel>
      <TabPanel active={tab === "noteRecording"}>{noteRecording}</TabPanel>
      <TabPanel active={tab === "upload"}>{upload}</TabPanel>
    </div>
  );
}
