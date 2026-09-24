import type { SendToAIOptions } from "../chat/useChatStreaming";
import type { ChatImageAttachment } from "../chat/types";
import type { AgentSelectionContext } from "../../utils/agentSelectionContext";
import type { AssistantResponseDelivery } from "../../helpers/assistantResponseDelivery";

interface CommandInput {
  attachment: ChatImageAttachment | null;
  selectedContext: AgentSelectionContext | null;
  delivery: AssistantResponseDelivery | null;
}

interface CommandHandlers {
  onResponseContent: () => void;
  deliver: (
    delivery: AssistantResponseDelivery,
    content: string
  ) => Promise<{ pasted: boolean; copied: boolean }>;
  confirmCopied: (content: string) => void;
}

/**
 * Send options for one voice command. Two tool events hold the turn in the
 * panel instead of delivering it at the caret: an approval card must be
 * visible, and a tool can ask for the hold (it opened a compose window that
 * took focus, put content on the clipboard that delivery would overwrite, or
 * needs the user to answer a question that must not land in their document).
 */
export function buildAssistantCommandSendOptions(
  command: CommandInput,
  handlers: CommandHandlers
): { options: SendToAIOptions; wasDelivered: () => boolean } {
  const { delivery } = command;
  let deliveryHeld = false;
  let delivered = false;
  const holdInPanel = (): void => {
    deliveryHeld = true;
    handlers.onResponseContent();
  };

  return {
    options: {
      attachment: command.attachment ?? undefined,
      selectedContext: command.selectedContext ?? undefined,
      suppressResponseContent: delivery?.mode === "paste",
      // A caret in a markdown-friendly app still keeps the compact pill.
      plainTextResponse: delivery?.mode === "paste" && delivery.plainText,
      onApprovalRequested: holdInPanel,
      onHoldDelivery: holdInPanel,
      onComplete: delivery
        ? async ({ content }) => {
            if (deliveryHeld) return;
            const result = await handlers.deliver(delivery, content);
            delivered = result.pasted;
            if (result.copied) handlers.confirmCopied(content);
          }
        : undefined,
    },
    wasDelivered: () => delivered,
  };
}
