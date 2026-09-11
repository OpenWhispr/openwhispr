import { ToolRegistry } from "./ToolRegistry";
import { createSearchNotesTool } from "./searchNotesTool";
import { getNoteTool } from "./getNoteTool";
import { createNoteTool } from "./createNoteTool";
import { updateNoteTool } from "./updateNoteTool";
import { listFoldersTool } from "./listFoldersTool";
import { clipboardTool } from "./clipboardTool";
import { webSearchTool } from "./webSearchTool";
import { calendarTool } from "./calendarTool";
import { calendarAvailabilityTool } from "./calendarAvailabilityTool";
import { createSnippetTool, createUpdateSnippetsTool, type SnippetActions } from "./snippetTool";
import { createUpdateDictionaryTool, type DictionaryActions } from "./dictionaryTool";
import type { ContainerScope } from "../../types/chat";

export { ToolRegistry } from "./ToolRegistry";
export type { ToolDefinition, ToolResult } from "./ToolRegistry";

interface ToolRegistrySettings {
  isSignedIn: boolean;
  calendarConnected: boolean;
  cloudBackupEnabled: boolean;
  /** Pins search_notes to a container (overview chat); the LLM cannot widen it. */
  searchScope?: ContainerScope;
  webSearchEnabled: boolean;
  /** Live dictionary and snippet access; enables the vocabulary tools. */
  vocabulary?: DictionaryActions & SnippetActions;
}

export function createToolRegistry(settings: ToolRegistrySettings): ToolRegistry {
  const registry = new ToolRegistry();

  const useCloudSearch = settings.isSignedIn && settings.cloudBackupEnabled;
  registry.register(createSearchNotesTool({ useCloudSearch, fixedScope: settings.searchScope }));
  registry.register(getNoteTool);
  registry.register(createNoteTool);
  registry.register(updateNoteTool);
  registry.register(listFoldersTool);
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
  }

  return registry;
}
