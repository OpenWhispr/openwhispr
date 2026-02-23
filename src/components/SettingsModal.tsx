import React, { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Sliders,
  Mic,
  Brain,
  User,
  Sparkles,
  UserCircle,
  Wrench,
  BookOpen,
  ShieldCheck,
  Lock,
  AudioLines,
} from "lucide-react";
import SidebarModal, { SidebarItem } from "./ui/SidebarModal";
import SettingsPage, { SettingsSectionType } from "./SettingsPage";

export type { SettingsSectionType };

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSectionType;
}

export default function SettingsModal({ open, onOpenChange, initialSection }: SettingsModalProps) {
  const { t } = useTranslation();
  const sidebarItems: SidebarItem<SettingsSectionType>[] = useMemo(
    () => [
      {
        id: "account",
        label: t("settingsModal.sections.account.label"),
        icon: UserCircle,
        description: t("settingsModal.sections.account.description"),
        group: t("settingsModal.groups.profile"),
      },
      {
        id: "general",
        label: t("settingsModal.sections.general.label"),
        icon: Sliders,
        description: t("settingsModal.sections.general.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "transcription",
        label: t("settingsModal.sections.transcription.label"),
        icon: Mic,
        description: t("settingsModal.sections.transcription.description"),
        group: t("settingsModal.groups.speech"),
      },
      {
        id: "dictionary",
        label: t("settingsModal.sections.dictionary.label"),
        icon: BookOpen,
        description: t("settingsModal.sections.dictionary.description"),
        group: t("settingsModal.groups.speech"),
      },
      {
        id: "aiModels",
        label: t("settingsModal.sections.aiModels.label"),
        icon: Brain,
        description: t("settingsModal.sections.aiModels.description"),
        group: t("settingsModal.groups.intelligence"),
      },
      {
        id: "agentConfig",
        label: t("settingsModal.sections.agentConfig.label"),
        icon: User,
        description: t("settingsModal.sections.agentConfig.description"),
        group: t("settingsModal.groups.intelligence"),
      },
      {
        id: "prompts",
        label: t("settingsModal.sections.prompts.label"),
        icon: Sparkles,
        description: t("settingsModal.sections.prompts.description"),
        group: t("settingsModal.groups.intelligence"),
      },
      {
        id: "wakeWord",
        label: "Wake Word",
        icon: AudioLines,
        description: "Voice-activated dictation",
        group: t("settingsModal.groups.speech"),
      },
      {
        id: "privacy",
        label: t("settingsModal.sections.privacy.label"),
        icon: Lock,
        description: t("settingsModal.sections.privacy.description"),
        group: t("settingsModal.groups.system"),
      },
      {
        id: "permissions",
        label: t("settingsModal.sections.permissions.label"),
        icon: ShieldCheck,
        description: t("settingsModal.sections.permissions.description"),
        group: t("settingsModal.groups.system"),
      },
      {
        id: "developer",
        label: t("settingsModal.sections.developer.label"),
        icon: Wrench,
        description: t("settingsModal.sections.developer.description"),
        group: t("settingsModal.groups.system"),
      },
    ],
    [t]
  );

  const [activeSection, setActiveSection] = React.useState<SettingsSectionType>("account");

  // Navigate to initial section when modal opens
  useEffect(() => {
    if (open && initialSection) {
      setActiveSection(initialSection);
    }
  }, [open, initialSection]);

  return (
    <SidebarModal<SettingsSectionType>
      open={open}
      onOpenChange={onOpenChange}
      title={t("settingsModal.title")}
      sidebarItems={sidebarItems}
      activeSection={activeSection}
      onSectionChange={setActiveSection}
    >
      <SettingsPage activeSection={activeSection} />
    </SidebarModal>
  );
}
