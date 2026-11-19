import React, { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { SettingsNavigationStore } from "../stores/settingsNavigationStore";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { usePolicyStore } from "../stores/policyStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
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
  SquareSparkle,
  Settings,
  Key,
  Office,
} from "./icons";
import SidebarModal, { type SidebarItem } from "./ui/SidebarModal";
import SettingsPage from "./SettingsPage";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import { useAuth } from "../hooks/useAuth";
import { workspaceCan } from "../lib/capabilities";
import { settingsWorkspace } from "../lib/workspaceSwitcher";
import {
  buildSettingsNav,
  resolveSettingsSection,
  type SettingsSectionType,
} from "../lib/settingsNav";

export type { SettingsSectionType };

const SECTION_ICONS: Record<SettingsSectionType, React.ComponentType<{ className?: string }>> = {
  account: UserCircle,
  general: Sliders,
  toneStyle: SquareSparkle,
  hotkeys: Keyboard,
  plansBilling: CreditCard,
  workspaceGeneral: Settings,
  workspacePeople: Users,
  workspaceTeamspaces: Office,
  workspaceDeveloper: Key,
  speechToText: Mic,
  llms: Brain,
  privacyData: Shield,
  system: Wrench,
};

interface SettingsModalProps {
  navigation: SettingsNavigationStore;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsModal({ navigation, onOpenChange }: SettingsModalProps) {
  // The only renderer (SettingsHost) mounts this modal iff the section is set.
  const requestedSection = useStore(navigation, (state) => state.section)!;
  const openSettings = useStore(navigation, (state) => state.openSettings);
  // Takes the user to a teamspace in Notes; the control panel closes Settings.
  const onOpenTeamspace = useStore(navigation, (state) => state.openTeamspace) ?? undefined;
  const { t } = useTranslation();
  const { isSignedIn } = useAuth();
  const policyManaged = usePolicyStore((s) => s.managed);
  const deviceManaged = usePolicyStore((s) => s.deviceManaged);
  const workspaceManaged = usePolicyStore((s) => s.workspaceManaged);
  const localOnly = usePolicyStore((s) => s.localOnly);
  const { workspaces, activeWorkspaceId, workspacesLoaded } = useWorkspaceStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
      workspacesLoaded: s.loaded,
    }))
  );
  const activeWorkspace = settingsWorkspace(workspaces, activeWorkspaceId);
  const hasWorkspace = activeWorkspace !== null;
  const canManageSettings = activeWorkspace
    ? workspaceCan(activeWorkspace, "manage_settings")
    : false;
  const signedIn = Boolean(isSignedIn);

  const nav = useMemo(
    () => buildSettingsNav({ isSignedIn: signedIn, hasWorkspace, canManageSettings }),
    [signedIn, hasWorkspace, canManageSettings]
  );
  // Until the workspace list loads, which workspace pages exist is unknown; a deep link to one
  // waits for the list rather than falling back to General.
  const navKnown = !signedIn || workspacesLoaded;

  const sidebarItems: SidebarItem<SettingsSectionType>[] = useMemo(
    () =>
      nav.map(({ id, group }) => ({
        id,
        label: t(`settingsModal.sections.${id}.label`),
        icon: SECTION_ICONS[id],
        description: t(`settingsModal.sections.${id}.description`),
        group: t(`settingsModal.groups.${group}`),
      })),
    [nav, t]
  );

  const [initialSubTab, setInitialSubTab] = useState<string | undefined>(undefined);

  // The open section can disappear (manage_settings revoked, the last workspace left or
  // deleted, signed out); land on the nearest page that still exists.
  const activeSection =
    navKnown && !nav.some((entry) => entry.id === requestedSection)
      ? resolveSettingsSection(requestedSection, nav)
      : requestedSection;
  useEffect(() => {
    if (activeSection === requestedSection) return;
    openSettings(activeSection);
    setInitialSubTab(undefined);
  }, [activeSection, requestedSection, openSettings]);

  const handleSectionChange = (section: SettingsSectionType, subTab?: string): void => {
    openSettings(section);
    setInitialSubTab(subTab);
  };

  return (
    <SidebarModal<SettingsSectionType>
      open
      onOpenChange={onOpenChange}
      title={t("settingsModal.title")}
      sidebarItems={sidebarItems}
      activeSection={activeSection}
      onSectionChange={handleSectionChange}
      header={signedIn ? <WorkspaceSwitcher placement="settings" /> : undefined}
      compactHeader={signedIn ? <WorkspaceSwitcher placement="settings" compact /> : undefined}
      notice={
        policyManaged
          ? {
              icon: <ShieldCheck className="h-3.5 w-3.5 shrink-0" />,
              label: deviceManaged
                ? t(workspaceManaged ? "common.managedDeviceAndWorkspace" : "common.managedDevice")
                : t("settingsModal.managedAccount"),
              description: localOnly
                ? t("common.deviceLocalOnly")
                : t("settingsModal.managedByOrg"),
            }
          : undefined
      }
    >
      <SettingsPage
        navigation={navigation}
        activeSection={activeSection}
        onNavigateToSection={handleSectionChange}
        initialSubTab={initialSubTab}
        onOpenTeamspace={onOpenTeamspace}
      />
    </SidebarModal>
  );
}
