import i18n from "../../../i18n";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../ToolRegistry";
import { needsClarificationResult, unavailableResult } from "./toolOutcome";

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
    // A lookup is almost always followed by a question for the user ("what
    // should the email say?", "which Josh?"), and that must never be pasted
    // into their document, so the answer stays in the panel whatever it finds.
    context?.onHoldDelivery();
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return needsClarificationResult("Ask the user whose email address to look up.");

    const response = await window.electronAPI?.connectorFindContacts?.(name);
    if (response?.unavailableReason) return unavailableResult(response.unavailableReason);
    const contacts = response?.contacts ?? [];
    const guidance =
      contacts.length === 0
        ? "No match. Ask the user for the email address."
        : response?.hasMore
          ? `More than ${contacts.length} people match and only the closest are listed. Unless one is clearly meant, ask the user for the last name or email address.`
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
