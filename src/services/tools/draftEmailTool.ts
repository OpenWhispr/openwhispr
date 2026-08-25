import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { EMAIL_REGEX } from "../../utils/validation";

function invalidRecipient(addresses: string[]): string | undefined {
  return addresses.find((address) => !EMAIL_REGEX.test(address));
}

// The tool only composes — sending happens when the user presses Send on the
// draft card, so the model can never dispatch an email on its own.
export function createDraftEmailTool(fromEmail: string): ToolDefinition {
  return {
    name: "draft_email",
    description:
      "Draft an email for the user to review, edit, and send from their connected Gmail account. The draft is shown as an editable card; it is never sent automatically.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description: "Recipient email addresses. Leave empty if no address is known.",
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description: "CC email addresses",
        },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Plain-text email body" },
      },
      required: ["subject", "body"],
      additionalProperties: false,
    },
    readOnly: false,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const to = Array.isArray(args.to) ? (args.to as string[]) : [];
      const cc = Array.isArray(args.cc) ? (args.cc as string[]) : [];
      const subject = String(args.subject ?? "");
      const body = String(args.body ?? "");

      const invalid = invalidRecipient([...to, ...cc]);
      if (invalid) {
        return {
          success: false,
          data: null,
          displayText: `Invalid email address: ${invalid}`,
        };
      }

      return {
        success: true,
        data: { to, cc, subject, body, from: fromEmail, status: "draft" },
        displayText: `Drafted email: "${subject}"`,
      };
    },
  };
}
