import { ToolRegistry } from "./ToolRegistry";
import { createSearchNotesTool } from "./searchNotesTool";
import { getNoteTool } from "./getNoteTool";
import { createNoteTool } from "./createNoteTool";
import { updateNoteTool } from "./updateNoteTool";
import { listFoldersTool } from "./listFoldersTool";
import { clipboardTool } from "./clipboardTool";
import { webSearchTool } from "./webSearchTool";
import { calendarTool } from "./calendarTool";

export { ToolRegistry } from "./ToolRegistry";
export type { ToolDefinition, ToolResult } from "./ToolRegistry";

interface ToolRegistrySettings {
  isSignedIn: boolean;
  gcalConnected: boolean;
  cloudBackupEnabled: boolean;
  /** Pins search_notes to a container (overview chat); the LLM cannot widen it. */
  searchScope?: { spaceId: number; folderId: number | null };
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

  if (settings.isSignedIn) {
    registry.register(webSearchTool);
  }

  if (settings.gcalConnected) {
    registry.register(calendarTool);
  }

  return registry;
}
