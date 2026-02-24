import React, { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Sliders,
  Mic,
  UserCircle,
  Wrench,
  Keyboard,
  CreditCard,
  Shield,
  Braces,
  User,
  Sparkles,
} from "lucide-react";
import SidebarModal, { SidebarItem } from "./ui/SidebarModal";
import SettingsPage, { SettingsSectionType } from "./SettingsPage";

export type { SettingsSectionType };

// Maps old section IDs to new ones for backward-compatible deep-linking
const SECTION_ALIASES: Record<string, SettingsSectionType> = {
  aiModels: "aiModels",
  agentConfig: "agentConfig",
  prompts: "prompts",
  intelligence: "aiModels",
  reasoning: "aiModels",
  speechAi: "transcription",
  softwareUpdates: "system",
  privacy: "privacyData",
  permissions: "privacyData",
  developer: "system",
};

const DEFAULT_SECTION: SettingsSectionType = "transcription";

function isSettingsSection(value: string): value is SettingsSectionType {
  return [
    "account",
    "plansBilling",
    "general",
    "hotkeys",
    "transcription",
    "aiModels",
    "agentConfig",
    "prompts",
    "intelligence",
    "privacyData",
    "system",
  ].includes(value);
}

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
        group: t("settingsModal.groups.speech", { defaultValue: "Speech" }),
      },
      {
        id: "aiModels",
        label: t("settingsModal.sections.aiModels.label", { defaultValue: "AI Models" }),
        icon: Braces,
        description: t("settingsModal.sections.aiModels.description", {
          defaultValue: "Model selection and AI text cleanup",
        }),
        group: t("settingsModal.groups.intelligence", { defaultValue: "Intelligence" }),
      },
      {
        id: "agentConfig",
        label: t("settingsModal.sections.agentConfig.label", { defaultValue: "Agent" }),
        icon: User,
        description: t("settingsModal.sections.agentConfig.description", {
          defaultValue: "Agent name and instruction mode behavior",
        }),
        group: t("settingsModal.groups.intelligence", { defaultValue: "Intelligence" }),
      },
      {
        id: "prompts",
        label: t("settingsModal.sections.prompts.label", { defaultValue: "Prompts" }),
        icon: Sparkles,
        description: t("settingsModal.sections.prompts.description", {
          defaultValue: "Customize system prompts and test output",
        }),
        group: t("settingsModal.groups.intelligence", { defaultValue: "Intelligence" }),
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

  const [activeSection, setActiveSection] = React.useState<SettingsSectionType>(DEFAULT_SECTION);

  // Navigate to initial section when modal opens, resolving legacy aliases
  useEffect(() => {
    if (!open) {
      return;
    }

    if (!initialSection) {
      setActiveSection(DEFAULT_SECTION);
      return;
    }

    const resolved = SECTION_ALIASES[initialSection] ?? initialSection;
    setActiveSection(isSettingsSection(resolved) ? resolved : DEFAULT_SECTION);
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
