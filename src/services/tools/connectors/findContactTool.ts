import type { ToolDefinition, ToolResult } from "../ToolRegistry";
import { needsClarificationResult } from "./toolOutcome";

export const findContactTool: ToolDefinition = {
  name: "find_contact",
  description:
    "Look up people's email addresses by name from the user's calendar meetings. Returns up to 5 matches with name, email and the most recent meeting date.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "A name or part of an email address" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  readOnly: true,

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return needsClarificationResult("Ask the user whose email address to look up.");

    const response = await window.electronAPI?.connectorFindContacts?.(name);
    const contacts = response?.contacts ?? [];
    const guidance =
      contacts.length === 0
        ? "No match. Ask the user for the email address."
        : contacts.length > 1
          ? "Several people match. Ask the user which one unless the request makes it clear."
          : undefined;

    return {
      success: true,
      data: { contacts, ...(guidance ? { guidance } : {}) },
      displayText: `Found ${contacts.length} contact${contacts.length === 1 ? "" : "s"}`,
    };
  },
};
