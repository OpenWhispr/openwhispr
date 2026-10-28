import React, { useMemo, useState } from "react";
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
} from "./icons";
import SidebarModal, { type SidebarItem } from "./ui/SidebarModal";
import SettingsPage from "./SettingsPage";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import { useAuth } from "../hooks/useAuth";
import { workspaceCan } from "../lib/capabilities";
import {
  buildSettingsNav,
  resolveSettingsSection,
  LEGACY_SUB_TAB,
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
  workspaceDeveloper: Key,
  speechToText: Mic,
  llms: Brain,
  privacyData: Shield,
  system: Wrench,
};

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: string;
}

export default function SettingsModal({
  open,
  onOpenChange,
  initialSection,
}: SettingsModalProps): React.ReactElement {
  const { t } = useTranslation();
  const { isSignedIn } = useAuth();
  const policyManaged = usePolicyStore((s) => s.managed);
  const { workspaces, activeWorkspaceId, workspacesLoaded } = useWorkspaceStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
      workspacesLoaded: s.loaded,
    }))
  );
  const activeWorkspace =
    workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null;
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
  const resolveSection = (section: string | undefined): SettingsSectionType =>
    resolveSettingsSection(
      section,
      navKnown
        ? nav
        : buildSettingsNav({ isSignedIn: signedIn, hasWorkspace: true, canManageSettings: true })
    );

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

  const [activeSection, setActiveSection] = React.useState<SettingsSectionType>(() =>
    resolveSection(initialSection)
  );
  const [initialSubTab, setInitialSubTab] = useState<string | undefined>(() =>
    initialSection ? LEGACY_SUB_TAB[initialSection] : undefined
  );
  const [prevOpen, setPrevOpen] = useState(open);
  // The picker menu is also opened from the General page's "Choose workspace".
  const [pickerOpen, setPickerOpen] = useState(false);

  if (open && !prevOpen && initialSection) {
    setPrevOpen(open);
    setActiveSection(resolveSection(initialSection));
    setInitialSubTab(LEGACY_SUB_TAB[initialSection]);
  } else if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) setInitialSubTab(undefined);
  }

  // The open section can disappear (manage_settings revoked, the last workspace left or
  // deleted, signed out); land on the nearest page that still exists.
  if (navKnown && !nav.some((entry) => entry.id === activeSection)) {
    setActiveSection(resolveSettingsSection(activeSection, nav));
    setInitialSubTab(undefined);
  }

  const handleSectionChange = (section: SettingsSectionType, subTab?: string): void => {
    setActiveSection(section);
    setInitialSubTab(subTab);
  };

  return (
    <SidebarModal<SettingsSectionType>
      open={open}
      onOpenChange={onOpenChange}
      title={t("settingsModal.title")}
      sidebarItems={sidebarItems}
      activeSection={activeSection}
      onSectionChange={handleSectionChange}
      header={
        signedIn ? (
          <WorkspaceSwitcher placement="settings" open={pickerOpen} onOpenChange={setPickerOpen} />
        ) : undefined
      }
      compactHeader={
        signedIn ? (
          <WorkspaceSwitcher
            placement="settings"
            compact
            open={pickerOpen}
            onOpenChange={setPickerOpen}
          />
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
      <SettingsPage
        activeSection={activeSection}
        onNavigateToSection={handleSectionChange}
        initialSubTab={initialSubTab}
        onChooseWorkspace={() => setPickerOpen(true)}
      />
    </SidebarModal>
  );
}
