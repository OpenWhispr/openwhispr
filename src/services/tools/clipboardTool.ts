import type { ToolDefinition, ToolResult } from "./ToolRegistry";

export const clipboardTool: ToolDefinition = {
  name: "copy_to_clipboard",
  description: "Copy text to the user's system clipboard.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to copy to the clipboard",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
  readOnly: false,

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const text = args.text as string;

    try {
      await window.electronAPI.writeClipboard(text);

      const preview = text.length > 100 ? text.slice(0, 100) + "..." : text;
      return {
        success: true,
        data: null,
        displayText: `Copied to clipboard: "${preview}"`,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        displayText: `Failed to copy to clipboard: ${(error as Error).message}`,
      };
    }
  },
};
