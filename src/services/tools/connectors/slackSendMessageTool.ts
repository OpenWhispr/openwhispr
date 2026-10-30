import i18n from "../../../i18n";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../ToolRegistry";
import { requestInteraction } from "../../../stores/agentInteractionStore";
import { unansweredResult } from "../interactionTools";
import type { ApprovalEdits, ConnectorChoice } from "../../../types/connectors";
import { runApprovalAction } from "./runApprovalAction";
import { failedResult, needsClarificationResult } from "./toolOutcome";
import type { ConnectorToolModule } from "./connectorToolModules";

// By Send the card was already shown, so a channel that disappeared after
// prepare comes back as a failure. The model should ask where to send it,
// with the message as the user left it on the card.
function askAboutVanishedChannel(result: ToolResult, destination: string): ToolResult {
  const data = result.data as ({ status?: string; errorCode?: string } & ApprovalEdits) | null;
  if (data?.status === "failed" && data.errorCode === "channel_not_found") {
    return needsClarificationResult(
      `${destination} couldn't be found in Slack anymore. Ask the user where to send the message.`,
      [],
      undefined,
      { finalText: data.finalText, final: data.final }
    );
  }
  return result;
}

// Whether a reply meant for a thread went into it, as Slack's response said.
function withThreadReply(result: ToolResult, thread: string): ToolResult {
  const data = result.data as { status?: string; outsideThread?: true } | null;
  if (!thread || data?.status !== "sent") return result;
  const { outsideThread, ...sent } = data;
  return { ...result, data: { ...sent, repliedInThread: !outsideThread } };
}

export const slackSendMessageTool: ToolDefinition = {
  name: "slack_send_message",
  description:
    "Post a message to Slack as the user. Nothing is sent until the user approves it on a card. `destination` is a #channel the user is in, a person's name, an @handle, an email address, a Slack id (C…, U… or D…) or a Slack link to the conversation. `text` is the message in Markdown. `thread` replies in a thread instead of posting a new message: a Slack link to any message in that thread.",
  parameters: {
    type: "object",
    properties: {
      destination: {
        type: "string",
        description:
          "#channel, a person's name, @handle, email address, Slack id, or a Slack link to the conversation",
      },
      text: { type: "string", description: "The message, in Markdown" },
      thread: {
        type: "string",
        description:
          "To reply in a thread: a Slack link to a message in it, such as https://<workspace>.slack.com/archives/C…/p…",
      },
    },
    required: ["destination", "text"],
    additionalProperties: false,
  },
  readOnly: false,
  connectorId: "slack",
  promptInstruction:
    'Use slack_send_message to post to a Slack channel or person as the user; the user approves each message on a card before it is sent. For a person, pass their name, @handle or email address. When the user asks to reply in a thread ("in the same thread", "reply to this"), pass a Slack link to a message in that thread as thread (from the selected text, or the link an earlier slack_send_message returned) and the conversation it is in as destination (the same person or channel, or that link). If there is no such link, ask for one instead of posting a new message. When a result says repliedInThread is false, Slack posted it as a new message, not in the thread: tell the user so.',

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    const destination = typeof args.destination === "string" ? args.destination.trim() : "";
    const text = typeof args.text === "string" ? args.text : "";
    const thread = typeof args.thread === "string" ? args.thread.trim() : "";
    if (!destination) {
      return needsClarificationResult(
        "Ask the user which Slack channel or person to send this to."
      );
    }
    if (!text.trim()) return failedResult("no_text", "The message is empty.");
    const result = await runApprovalAction(context, "slack", "send_message", {
      destination,
      text,
      ...(thread ? { thread } : {}),
    });
    return withThreadReply(askAboutVanishedChannel(result, destination), thread);
  },
};

function destinationChoices(result: ToolResult): ConnectorChoice[] {
  const data = result.data as { status?: string; choices?: ConnectorChoice[] } | null;
  return data?.status === "needs_clarification" ? (data.choices ?? []) : [];
}

/**
 * In a chat that can ask the user: a name that matched several people or
 * channels is picked on a question card, once, and the message goes there,
 * as the user last wrote it on the card when they had. An answer typed in
 * place of a pick is tried as the destination, as written; if that is
 * unclear too, the model hears the question.
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
      const written = (result.data as { finalText?: unknown } | null)?.finalText;
      // The user rewrote the message on the card: whatever comes of the pick
      // (sent, another question, a failure, no answer), the model hears that text.
      const withWritten = (outcome: ToolResult): ToolResult => {
        const data = outcome.data as (Record<string, unknown> & ApprovalEdits) | null;
        if (typeof written !== "string" || !data || data.finalText !== undefined) return outcome;
        return { ...outcome, data: { ...data, finalText: written } };
      };
      if (answer.status !== "answered") return withWritten(unansweredResult(answer));
      // A single-choice answer is one string: the pick, or the typed text.
      return withWritten(
        await tool.execute(
          {
            ...args,
            destination: String(answer.answers.destination),
            ...(typeof written === "string" ? { text: written } : {}),
          },
          context
        )
      );
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
