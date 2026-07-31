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
  /** Web search runs on the user's own Brave Search key — no account involved. */
  webSearchEnabled: boolean;
  gcalConnected: boolean;
}

export function createToolRegistry(settings: ToolRegistrySettings): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(createSearchNotesTool());
  registry.register(getNoteTool);
  registry.register(createNoteTool);
  registry.register(updateNoteTool);
  registry.register(listFoldersTool);
  registry.register(clipboardTool);

  if (settings.webSearchEnabled) {
    registry.register(webSearchTool);
  }

  if (settings.gcalConnected) {
    registry.register(calendarTool);
  }

  return registry;
}
