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
 * panel: an approval card must be visible, and content a tool put on the
 * clipboard (a long email body) must not be overwritten by delivery, which
 * copies the answer in clipboard mode and whenever a paste fails.
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
      onApprovalRequested: holdInPanel,
      onClipboardReserved: holdInPanel,
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
