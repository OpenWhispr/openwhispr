import type { ToolDefinition, ToolResult } from "./ToolRegistry";

export const listFoldersTool: ToolDefinition = {
  name: "list_folders",
  description:
    "List all available note folders. Use before create_note or update_note to reuse an existing folder instead of creating a near-duplicate.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  readOnly: true,

  async execute(): Promise<ToolResult> {
    try {
      const folders = await window.electronAPI.getFolders();
      const data = folders.map((f) => ({ id: f.id, name: f.name }));
      const displayText = folders.length
        ? `Folders: ${folders.map((f) => f.name).join(", ")}`
        : "No folders";
      return { success: true, data, displayText };
    } catch (error) {
      return {
        success: false,
        data: null,
        displayText: `Failed to list folders: ${(error as Error).message}`,
      };
    }
  },
};
