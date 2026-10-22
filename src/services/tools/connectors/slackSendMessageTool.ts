import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../ToolRegistry";
import { runApprovalAction } from "./runApprovalAction";
import { failedResult, needsClarificationResult } from "./toolOutcome";
import type { ConnectorToolModule } from "./connectorToolModules";

// By Send the card was already shown, so a channel that disappeared after
// prepare comes back as a failure. The model should ask where to send it.
function askAboutVanishedChannel(result: ToolResult, destination: string): ToolResult {
  const data = result.data as { status?: string; errorCode?: string } | null;
  if (data?.status === "failed" && data.errorCode === "channel_not_found") {
    return needsClarificationResult(
      `${destination} couldn't be found in Slack anymore. Ask the user where to send the message.`
    );
  }
  return result;
}

export const slackSendMessageTool: ToolDefinition = {
  name: "slack_send_message",
  description:
    "Post a message to Slack as the user. Nothing is sent until the user approves it on a card. `destination` is a #channel the user is in, a person's name, an @handle, or an email address. `text` is the message in Markdown.",
  parameters: {
    type: "object",
    properties: {
      destination: {
        type: "string",
        description: "#channel, a person's name, @handle, or email address",
      },
      text: { type: "string", description: "The message, in Markdown" },
    },
    required: ["destination", "text"],
    additionalProperties: false,
  },
  readOnly: false,
  connectorId: "slack",
  promptInstruction:
    "Use slack_send_message to post to a Slack channel or person as the user; the user approves each message on a card before it is sent. For a person, pass their name, @handle or email address.",

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    // Every outcome keeps the turn off the caret: a card, a question back and
    // a receipt all belong in the panel, never in the user's document.
    context?.onHoldDelivery();
    const destination = typeof args.destination === "string" ? args.destination.trim() : "";
    const text = typeof args.text === "string" ? args.text : "";
    if (!destination) {
      return needsClarificationResult(
        "Ask the user which Slack channel or person to send this to."
      );
    }
    if (!text.trim()) return failedResult("no_text", "The message is empty.");
    const result = await runApprovalAction(context, "slack", "send_message", { destination, text });
    return askAboutVanishedChannel(result, destination);
  },
};

export const slackToolModule: ConnectorToolModule = {
  connectorId: "slack",
  requiresConnection: true,
  createTools: () => [slackSendMessageTool],
};
