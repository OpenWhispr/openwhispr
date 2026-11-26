import {
  PLANS_BILLING_TARGET,
  PLANS_BILLING_WORKSPACE_PREFIX,
  plansBillingTarget,
  isPlansBillingTarget,
} from "../helpers/settingsTargets.js";

export type SettingsSectionType =
  | "account"
  | "general"
  | "toneStyle"
  | "hotkeys"
  | "plansBilling"
  | "workspaceGeneral"
  | "workspacePeople"
  | "workspaceTeamspaces"
  | "workspaceDeveloper"
  | "speechToText"
  | "llms"
  | "privacyData"
  | "system";

export type SettingsNavGroup = "account" | "workspace" | "aiModels" | "system";

export interface SettingsNavEntry {
  id: SettingsSectionType;
  group: SettingsNavGroup;
}

export interface SettingsNavInput {
  isSignedIn: boolean;
  hasWorkspace: boolean;
  canManageSettings: boolean;
}

// The old AI Models sidebar had four items (transcription, meetings,
// intelligence, agentMode) — they now collapse into two: speechToText + llms.
// Legacy deep-links land on the matching sub-tab via LEGACY_SUB_TAB.
// "dictationAgent" (the Home GPU banner) and "noteFormatting" (a note action's
// error toast) are live deep-links, not legacy aliases. "workspace" was the
// single workspace page before it split into General, People and Developer.
export const SECTION_ALIASES: Record<string, SettingsSectionType> = {
  aiModels: "llms",
  agentConfig: "llms",
  agentMode: "llms",
  dictationAgent: "llms",
  intelligence: "llms",
  meetings: "llms",
  noteFormatting: "llms",
  prompts: "llms",
  transcription: "speechToText",
  uploadTranscription: "speechToText",
  noteRecording: "speechToText",
  softwareUpdates: "system",
  privacy: "privacyData",
  permissions: "privacyData",
  developer: "system",
  workspace: "workspaceGeneral",
};

export const LEGACY_SUB_TAB: Record<string, string> = {
  transcription: "dictation",
  uploadTranscription: "upload",
  noteRecording: "noteRecording",
  dictationAgent: "dictationAgent",
  meetings: "noteFormatting",
  noteFormatting: "noteFormatting",
  intelligence: "dictationCleanup",
  agentMode: "chatIntelligence",
  agentConfig: "chatIntelligence",
  aiModels: "dictationCleanup",
  prompts: "dictationCleanup",
};

const WORKSPACE_SECTIONS: ReadonlySet<SettingsSectionType> = new Set([
  "workspaceGeneral",
  "workspacePeople",
  "workspaceTeamspaces",
  "workspaceDeveloper",
]);

export function buildSettingsNav({
  isSignedIn,
  hasWorkspace,
  canManageSettings,
}: SettingsNavInput): SettingsNavEntry[] {
  const workspace: SettingsNavEntry[] = !isSignedIn
    ? []
    : [
        { id: "workspaceGeneral", group: "workspace" },
        ...(hasWorkspace
          ? ([
              { id: "workspacePeople", group: "workspace" },
              { id: "workspaceTeamspaces", group: "workspace" },
            ] as const)
          : []),
        ...(hasWorkspace && canManageSettings
          ? [{ id: "workspaceDeveloper", group: "workspace" } as const]
          : []),
      ];

  return [
    { id: "account", group: "account" },
    { id: "general", group: "account" },
    { id: "toneStyle", group: "account" },
    { id: "hotkeys", group: "account" },
    { id: "plansBilling", group: "account" },
    ...workspace,
    { id: "speechToText", group: "aiModels" },
    { id: "llms", group: "aiModels" },
    { id: "privacyData", group: "system" },
    { id: "system", group: "system" },
  ];
}

export type PlansBillingRequest = { kind: "personal" } | { kind: "workspace"; workspaceId: string };

export function parsePlansBillingTarget(target: string | undefined): PlansBillingRequest | null {
  if (!isPlansBillingTarget(target)) return null;
  if (target === PLANS_BILLING_TARGET) return { kind: "personal" };
  return { kind: "workspace", workspaceId: target.slice(PLANS_BILLING_WORKSPACE_PREFIX.length) };
}

export function resolveSettingsSection(
  requested: string | undefined,
  available: SettingsNavEntry[]
): SettingsSectionType {
  if (!requested) return "account";
  if (isPlansBillingTarget(requested)) {
    return available.some((entry) => entry.id === "plansBilling") ? "plansBilling" : "account";
  }
  const section = SECTION_ALIASES[requested] ?? requested;
  if (available.some((entry) => entry.id === section)) return section as SettingsSectionType;
  // A workspace page the user can't see (no workspace yet, or no manage_settings) still lands
  // in the workspace group when it exists.
  if (
    WORKSPACE_SECTIONS.has(section as SettingsSectionType) &&
    available.some((entry) => entry.id === "workspaceGeneral")
  ) {
    return "workspaceGeneral";
  }
  return "account";
}

export type WorkspacePlanSection = `plansBilling:workspace:${string}`;

// plansBillingTarget is untyped JS (shared with main); this gives openSettingsSection its literal.
export function workspacePlanSection(workspaceId: string): WorkspacePlanSection {
  return plansBillingTarget(workspaceId) as WorkspacePlanSection;
}
