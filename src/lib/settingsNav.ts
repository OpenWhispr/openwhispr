export type SettingsSectionType =
  | "account"
  | "general"
  | "toneStyle"
  | "hotkeys"
  | "plansBilling"
  | "workspaceGeneral"
  | "workspacePeople"
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
  softwareUpdates: "system",
  privacy: "privacyData",
  permissions: "privacyData",
  developer: "system",
  workspace: "workspaceGeneral",
};

export const LEGACY_SUB_TAB: Record<string, string> = {
  transcription: "dictation",
  uploadTranscription: "upload",
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
        ...(hasWorkspace ? [{ id: "workspacePeople", group: "workspace" } as const] : []),
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

export function resolveSettingsSection(
  requested: string | undefined,
  available: SettingsNavEntry[]
): SettingsSectionType {
  if (!requested) return "account";
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
