import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { joinFolderPath } from "../../components/notes/shared";

export const listFoldersTool: ToolDefinition = {
  name: "list_folders",
  description:
    'List all available note folders with the space each belongs to and, for a subfolder, its parent folder. Use before create_note or update_note to reuse an existing folder instead of creating a near-duplicate. Their folder argument takes a subfolder\'s plain name or its "Parent / Child" label.',
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  readOnly: true,

  async execute(): Promise<ToolResult> {
    try {
      const [folders, spaces] = await Promise.all([
        window.electronAPI.getFolders(),
        window.electronAPI.getSpaces?.() ?? Promise.resolve([]),
      ]);
      const spaceNameById = new Map(spaces.map((s) => [s.id, s.name]));
      const folderNameById = new Map(folders.map((f) => [f.id, f.name]));
      const data = folders.map((f) => ({
        id: f.id,
        name: f.name,
        parent:
          f.parent_folder_id == null ? null : (folderNameById.get(f.parent_folder_id) ?? null),
        space: spaceNameById.get(f.space_id) ?? null,
      }));
      const displayText = data.length
        ? `Folders: ${data
            .map((f) => {
              const label = f.parent ? joinFolderPath(f.parent, f.name) : f.name;
              return spaces.length > 1 && f.space ? `${label} (${f.space})` : label;
            })
            .join(", ")}`
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
