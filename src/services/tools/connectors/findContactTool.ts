import i18n from "../../../i18n";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../ToolRegistry";
import { needsClarificationResult } from "./toolOutcome";

export const findContactTool: ToolDefinition = {
  name: "find_contact",
  description:
    "Look up people's email addresses by name from the user's calendar meetings and saved contacts. Returns up to 5 matches with name, email and the date of the most recent past meeting (null when none is on record).",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "A name or part of an email address" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  readOnly: true,

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    // Without exactly one match the answer is a question for the user, which
    // must not be pasted into their document.
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) {
      context?.onHoldDelivery();
      return needsClarificationResult("Ask the user whose email address to look up.");
    }

    const response = await window.electronAPI?.connectorFindContacts?.(name);
    const contacts = response?.contacts ?? [];
    if (contacts.length !== 1) context?.onHoldDelivery();
    const guidance =
      contacts.length === 0
        ? "No match. Ask the user for the email address."
        : contacts.length > 1
          ? "Several people match. Ask the user which one unless the request makes it clear."
          : undefined;

    return {
      success: true,
      data: { contacts, ...(guidance ? { guidance } : {}) },
      displayText: i18n.t("connectors.toolStatus.contactsFound", { total: contacts.length }),
    };
  },
};
