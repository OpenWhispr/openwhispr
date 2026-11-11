import { productHelpTools } from "./productHelpTools";
import { ToolRegistry } from "./ToolRegistry";
import { createSearchNotesTool } from "./searchNotesTool";
import { createGetNoteTool } from "./getNoteTool";
import { createCreateNoteTool } from "./createNoteTool";
import { createUpdateNoteTool } from "./updateNoteTool";
import { createListFoldersTool } from "./listFoldersTool";
import type { NoteScope } from "./noteScope";
import { clipboardTool } from "./clipboardTool";
import { webSearchTool } from "./webSearchTool";
import { calendarTool } from "./calendarTool";
import { calendarAvailabilityTool } from "./calendarAvailabilityTool";
import { createSnippetTool, createUpdateSnippetsTool, type SnippetActions } from "./snippetTool";
import { createUpdateDictionaryTool, type DictionaryActions } from "./dictionaryTool";
import {
  registerConnectorTools,
  type ConnectorToolSettings,
} from "./connectors/connectorToolModules";
import {
  createInteractionTools,
  requireConnection,
  type InteractionToolOptions,
} from "./interactionTools";
import {
  createLoadSkillTool,
  createProposeSkillTool,
  createUpdateSkillTool,
  type SkillToolDeps,
} from "./skillTools";

import { getSettings, selectCalendarConnected } from "../../stores/settingsStore";
import type { ContainerScope } from "../../types/chat";

export { ToolRegistry } from "./ToolRegistry";
export type { ToolDefinition, ToolResult } from "./ToolRegistry";

interface ToolRegistrySettings {
  isSignedIn: boolean;
  /** Disabled for onboarding demos; supported normal chat surfaces default to enabled. */
  productHelpEnabled?: boolean;
  calendarConnected: boolean;
  /** Pins search_notes to a container (overview chat); the LLM cannot widen it. */
  searchScope?: ContainerScope;
  /**
   * The spaces whose notes the note tools may read or change: the active workspace's Private and
   * its teamspaces in scope (resolveAssistantScopeSpaceIds). Nothing elsewhere reaches the model.
   */
  scopeSpaceIds: number[];
  /** The note a note's chat is about, which that chat's tools reach wherever it is. */
  openNoteId?: number | null;
  webSearchEnabled: boolean;
  /** Live dictionary and snippet access; enables the vocabulary tools. */
  vocabulary?: DictionaryActions & SnippetActions;
  /** Present only when connectors are available (signed in, paid, policy allows). */
  connectors?: ConnectorToolSettings;
  /** Leaves out update_note, for a turn that must not change any note. */
  keepNotesUnchanged?: boolean;
  /** Present only on surfaces that can show interactions (questions, connect cards). */
  interactions?: InteractionToolOptions;
  /** The user's skills; load_skill is offered once one is usable. */
  skills?: SkillToolDeps;
}

export function createToolRegistry(settings: ToolRegistrySettings): ToolRegistry {
  const registry = new ToolRegistry();
  if (settings.productHelpEnabled !== false)
    for (const tool of productHelpTools) registry.register(tool);

  // Cloud search reads teamspaces only (D36), so it needs an account, not Cloud Backup.
  const useCloudSearch = settings.isSignedIn;
  const noteScope: NoteScope = {
    spaceIds: settings.scopeSpaceIds,
    openNoteId: settings.openNoteId,
  };
  registry.register(
    createSearchNotesTool({
      useCloudSearch,
      fixedScope: settings.searchScope,
      scopeSpaceIds: noteScope.spaceIds,
    })
  );
  registry.register(createGetNoteTool(noteScope));
  registry.register(createCreateNoteTool(noteScope));
  if (!settings.keepNotesUnchanged) registry.register(createUpdateNoteTool(noteScope));
  registry.register(createListFoldersTool(noteScope));
  registry.register(clipboardTool);

  if (settings.vocabulary) {
    const snippets = settings.vocabulary.getSnippets();
    if (snippets.length > 0) registry.register(createSnippetTool(snippets));
    registry.register(createUpdateDictionaryTool(settings.vocabulary));
    registry.register(createUpdateSnippetsTool(settings.vocabulary));
  }

  if (settings.isSignedIn && settings.webSearchEnabled) {
    registry.register(webSearchTool);
  }

  if (settings.calendarConnected) {
    registry.register(calendarTool);
    registry.register(calendarAvailabilityTool);
  } else if (settings.interactions?.connectionTargets.includes("calendar")) {
    for (const tool of [calendarTool, calendarAvailabilityTool]) {
      registry.register(
        requireConnection(tool, "calendar", () => selectCalendarConnected(getSettings()))
      );
    }
  }

  if (settings.connectors) registerConnectorTools(registry, settings.connectors);

  if (settings.interactions) {
    for (const tool of createInteractionTools(settings.interactions)) registry.register(tool);
  }
  if (settings.skills) {
    const hasSkills = settings.skills.usable.length > 0;
    if (hasSkills) {
      registry.register(createLoadSkillTool(settings.skills));
      registry.register(createUpdateSkillTool(settings.skills.usable));
    }
    // A skill card writes only on this computer, so it needs no sign-in, plan or connector.
    // Someone with no skills makes their first through the skill creator, so every other
    // request leaves the tool out.
    if (hasSkills || settings.skills.creatorAttached) {
      registry.register(createProposeSkillTool());
    }
  }

  return registry;
}
