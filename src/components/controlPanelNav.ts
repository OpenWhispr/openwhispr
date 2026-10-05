import type React from "react";
import { useTranslation } from "react-i18next";
import { Home, BarChart3, MessageSquare, NotebookPen, BookOpen, Upload, Blocks } from "./icons";
import { isAgentAllowed, isPolicyActionAllowed } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";

export type ControlPanelView =
  "home" | "insights" | "chat" | "personal-notes" | "dictionary" | "upload" | "integrations";

export interface ControlPanelNavItem {
  id: ControlPanelView;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

/**
 * Single source of truth for main-window navigation. The sidebar renders these
 * rows and the top bar shows the active item's label as the page title, so the
 * two can never disagree.
 */
export function useControlPanelNavItems(): ControlPanelNavItem[] {
  const { t } = useTranslation();
  const agentAllowed = usePolicyStore(isAgentAllowed);
  const policyActionsAllowed = usePolicyStore((state) => isPolicyActionAllowed(state));

  return [
    { id: "home", label: t("sidebar.home"), icon: Home },
    { id: "insights", label: t("sidebar.insights"), icon: BarChart3 },
    ...(agentAllowed
      ? [{ id: "chat" as const, label: t("sidebar.chat"), icon: MessageSquare }]
      : []),
    { id: "personal-notes", label: t("sidebar.notes"), icon: NotebookPen },
    ...(policyActionsAllowed
      ? [{ id: "upload" as const, label: t("sidebar.upload"), icon: Upload }]
      : []),
    { id: "dictionary", label: t("sidebar.dictionary"), icon: BookOpen },
    { id: "integrations", label: t("sidebar.integrations"), icon: Blocks },
  ];
}
