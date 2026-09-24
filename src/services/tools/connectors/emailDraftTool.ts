import i18n from "../../../i18n";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../ToolRegistry";
import { isValidEmailAddress } from "../../../helpers/connectors/emailCompose";
import type { EmailDraftTarget } from "../../../utils/emailDraftTarget";
import {
  failedResult,
  needsClarificationResult,
  notSentResult,
  unavailableResult,
} from "./toolOutcome";

function addressList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : [];
}

export function createEmailDraftTool(target: EmailDraftTarget): ToolDefinition {
  return {
    name: "email_draft",
    description:
      "Open a pre-filled email draft in the user's email app so they can review and send it themselves. This never sends email. `to` and `cc` must be full email addresses; call find_contact first when you only have a name.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Recipient email addresses",
        },
        cc: { type: "array", items: { type: "string" }, description: "Cc email addresses" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Plain-text body; blank lines between paragraphs" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
    readOnly: false,

    async execute(
      args: Record<string, unknown>,
      context?: ToolExecutionContext
    ): Promise<ToolResult> {
      // Every outcome keeps the turn off the caret: an opened compose window
      // takes focus, and a question back must not land in the user's document.
      context?.onHoldDelivery();
      const to = addressList(args.to);
      const cc = addressList(args.cc);
      const invalid = [...to, ...cc].filter((address) => !isValidEmailAddress(address));
      if (to.length === 0 || invalid.length > 0) {
        return needsClarificationResult(
          "Every recipient must be a full email address. Call find_contact with the person's name, or ask the user for the address.",
          invalid
        );
      }

      if (context?.signal.aborted) return notSentResult("cancelled");
      const result = await window.electronAPI?.connectorRunDirect?.("email", "draft", {
        target,
        to,
        cc,
        subject: typeof args.subject === "string" ? args.subject : "",
        body: typeof args.body === "string" ? args.body : "",
      });
      if (!result) return unavailableResult("connectors_unavailable");
      if (result.state === "unavailable") return unavailableResult(result.reason);
      if (result.state === "failed") return failedResult(result.errorCode, result.message);

      const bodyCopied = Boolean(result.bodyCopied);
      const subjectCopied = Boolean(result.subjectCopied);

      return {
        success: true,
        data: {
          status: "draft_opened",
          recipients: to,
          bodyCopied,
          subjectCopied,
          guidance: subjectCopied
            ? "The subject and body were too long for a link, so they are on the user's clipboard (subject first, then a blank line, then the body). Tell them to paste the subject and body into the draft."
            : bodyCopied
              ? "The body was too long for a link, so it is on the user's clipboard. Tell them to paste it into the draft."
              : "Tell the user the draft is open for them to review and send.",
        },
        displayText: i18n.t(
          subjectCopied
            ? "connectors.toolStatus.draftOpenedSubjectCopied"
            : bodyCopied
              ? "connectors.toolStatus.draftOpenedBodyCopied"
              : "connectors.toolStatus.draftOpened",
          { destination: result.destinationLabel }
        ),
      };
    },
  };
}
