import { useStore } from "zustand";
import type {
  SettingsNavigationStore,
  SettingsSectionType,
} from "../stores/settingsNavigationStore";
import { useTranslation } from "react-i18next";
import { usePolicyStore } from "../stores/policyStore";
import {
  Sliders,
  Mic,
  Brain,
  UserCircle,
  Wrench,
  Keyboard,
  CreditCard,
  Shield,
  ShieldCheck,
  Users,
} from "./icons";
import SidebarModal, { type SidebarItem } from "./ui/SidebarModal";
import SettingsPage, { AccountAvatar } from "./SettingsPage";
import { useAuth } from "../hooks/useAuth";

export type { SettingsSectionType };

interface SettingsModalProps {
  navigation: SettingsNavigationStore;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsModal({ navigation, onOpenChange }: SettingsModalProps) {
  // The only renderer (SettingsHost) mounts this modal iff the section is set.
  const activeSection = useStore(navigation, (state) => state.section)!;
  const handleSectionChange = useStore(navigation, (state) => state.openSettings);
  const { t } = useTranslation();
  const { isSignedIn, user } = useAuth();
  const policyManaged = usePolicyStore((s) => s.managed);
  const items: SidebarItem<SettingsSectionType>[] = [
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
      id: "workspace",
      label: t("settingsModal.sections.workspace.label"),
      icon: Users,
      description: t("settingsModal.sections.workspace.description"),
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
      id: "speechToText",
      label: t("settingsModal.sections.speechToText.label"),
      icon: Mic,
      description: t("settingsModal.sections.speechToText.description"),
      group: t("settingsModal.groups.aiModels"),
    },
    {
      id: "llms",
      label: t("settingsModal.sections.llms.label"),
      icon: Brain,
      description: t("settingsModal.sections.llms.description"),
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
  ];
  const sidebarItems = isSignedIn ? items : items.filter((item) => item.id !== "workspace");

  return (
    <SidebarModal<SettingsSectionType>
      open
      onOpenChange={onOpenChange}
      title={t("settingsModal.title")}
      sidebarItems={sidebarItems}
      activeSection={activeSection}
      onSectionChange={handleSectionChange}
      header={
        isSignedIn && user ? (
          <div className="flex flex-col items-center gap-2 pb-2 text-center">
            <AccountAvatar image={user.image} name={user.name || t("settingsPage.account.user")} />
            <div className="min-w-0 w-full">
              <p dir="auto" className="text-[13px] font-semibold text-foreground truncate">
                {user.name || t("settingsPage.account.user")}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                <bdi dir="ltr">{user.email}</bdi>
              </p>
            </div>
          </div>
        ) : undefined
      }
      notice={
        policyManaged
          ? {
              icon: <ShieldCheck className="h-3.5 w-3.5 shrink-0" />,
              label: t("settingsModal.managedAccount"),
              description: t("settingsModal.managedByOrg"),
            }
          : undefined
      }
    >
      <SettingsPage navigation={navigation} />
    </SidebarModal>
  );
}
