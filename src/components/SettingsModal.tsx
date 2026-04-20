import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sliders,
  Mic,
  Brain,
  UserCircle,
  Wrench,
  Keyboard,
  CreditCard,
  Key,
  Shield,
  MessageSquare,
  CalendarDays,
} from "lucide-react";
import SidebarModal, { type SidebarItem } from "./ui/SidebarModal";
import SettingsPage, { SettingsSectionType } from "./SettingsPage";

export type { SettingsSectionType };

// Maps old section IDs to new ones for backward-compatible deep-linking
const SECTION_ALIASES: Record<string, SettingsSectionType> = {
  aiModels: "intelligence",
  agentConfig: "intelligence",
  prompts: "intelligence",
  softwareUpdates: "system",
  privacy: "privacyData",
  permissions: "privacyData",
  developer: "system",
};

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: string;
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
        group: t("settingsModal.groups.account"),
      },
      {
        id: "plansBilling",
        label: t("settingsModal.sections.plansBilling.label"),
        icon: CreditCard,
        description: t("settingsModal.sections.plansBilling.description"),
        group: t("settingsModal.groups.account"),
      },
      {
        id: "apiKeys",
        label: t("settingsModal.sections.apiKeys.label"),
        icon: Key,
        description: t("settingsModal.sections.apiKeys.description"),
        group: t("settingsModal.groups.account"),
      },
      {
        id: "general",
        label: t("settingsModal.sections.general.label"),
        icon: Sliders,
        description: t("settingsModal.sections.general.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "hotkeys",
        label: t("settingsModal.sections.hotkeys.label"),
        icon: Keyboard,
        description: t("settingsModal.sections.hotkeys.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "transcription",
        label: t("settingsModal.sections.transcription.label"),
        icon: Mic,
        description: t("settingsModal.sections.transcription.description"),
        group: t("settingsModal.groups.aiModels"),
      },
      {
        id: "meetings",
        label: t("settingsModal.sections.meetings.label"),
        icon: CalendarDays,
        description: t("settingsModal.sections.meetings.description"),
        group: t("settingsModal.groups.aiModels"),
      },
      {
        id: "intelligence",
        label: t("settingsModal.sections.intelligence.label"),
        icon: Brain,
        description: t("settingsModal.sections.intelligence.description"),
        group: t("settingsModal.groups.aiModels"),
      },
      {
        id: "agentMode",
        label: t("settingsModal.sections.agentMode.label"),
        icon: MessageSquare,
        description: t("settingsModal.sections.agentMode.description"),
        group: t("settingsModal.groups.aiModels"),
      },
      {
        id: "privacyData",
        label: t("settingsModal.sections.privacyData.label"),
        icon: Shield,
        description: t("settingsModal.sections.privacyData.description"),
        group: t("settingsModal.groups.system"),
      },
      {
        id: "system",
        label: t("settingsModal.sections.system.label"),
        icon: Wrench,
        description: t("settingsModal.sections.system.description"),
        group: t("settingsModal.groups.system"),
      },
    ],
    [t]
  );

  const [activeSection, setActiveSection] = React.useState<SettingsSectionType>("account");
  const [prevOpen, setPrevOpen] = useState(open);

  if (open && !prevOpen && initialSection) {
    setPrevOpen(open);
    const resolved = (SECTION_ALIASES[initialSection] ?? initialSection) as SettingsSectionType;
    setActiveSection(resolved);
  } else if (open !== prevOpen) {
    setPrevOpen(open);
  }

  return (
    <SidebarModal<SettingsSectionType>
      open={open}
      onOpenChange={onOpenChange}
      title={t("settingsModal.title")}
      sidebarItems={sidebarItems}
      activeSection={activeSection}
      onSectionChange={setActiveSection}
    >
      <SettingsPage activeSection={activeSection} onNavigateToSection={setActiveSection} />
    </SidebarModal>
  );
}
