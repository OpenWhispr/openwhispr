import i18n from "../../../i18n";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../ToolRegistry";
import { requestInteraction } from "../../../stores/agentInteractionStore";
import { unansweredResult } from "../interactionTools";
import type { ConnectorChoice } from "../../../types/connectors";
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

function destinationChoices(result: ToolResult): ConnectorChoice[] {
  const data = result.data as { status?: string; choices?: ConnectorChoice[] } | null;
  return data?.status === "needs_clarification" ? (data.choices ?? []) : [];
}

/**
 * In a chat that can ask the user: a name that matched several people or
 * channels is picked on a question card, once, and the message goes there.
 * A pick still unclear (an answer typed instead) goes back to the model.
 */
function withDestinationPicker(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    async execute(args, context) {
      const result = await tool.execute(args, context);
      const choices = destinationChoices(result);
      if (!context || choices.length < 2) return result;
      const answer = await requestInteraction(context, {
        kind: "questions",
        questions: [
          {
            id: "destination",
            kind: "single",
            prompt: i18n.t("connectors.slack.pickDestination", { destination: args.destination }),
            options: choices.map((choice) => ({ id: choice.destination, label: choice.label })),
          },
        ],
      });
      if (answer.status !== "answered") return unansweredResult(answer);
      const picked = answer.answers.destination;
      return typeof picked === "string"
        ? tool.execute({ ...args, destination: picked }, context)
        : result;
    },
  };
}

export const slackToolModule: ConnectorToolModule = {
  connectorId: "slack",
  requiresConnection: true,
  createTools: (env) => [
    env.asksUser ? withDestinationPicker(slackSendMessageTool) : slackSendMessageTool,
  ],
};
