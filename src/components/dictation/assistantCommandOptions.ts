import type { SendToAIOptions } from "../chat/useChatStreaming";
import type { ChatImageAttachment } from "../chat/types";
import type { AgentSelectionContext } from "../../utils/agentSelectionContext";
import type { AssistantResponseDelivery } from "../../helpers/assistantResponseDelivery";
import type { HoldDeliveryOptions } from "../../services/tools/ToolRegistry";

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

const PANEL_DELIVERY: AssistantResponseDelivery = { mode: "clipboard" };

/**
 * Send options for one voice command. Two tool events hold the turn in the
 * panel instead of pasting it at the caret: an approval card must be visible,
 * and a tool can ask for the hold (it opened a compose window that took focus,
 * or needs the user to answer a question that must not land in their
 * document). A held answer is still copied like any panel answer, unless the
 * tool may have put content on the clipboard that the copy would overwrite.
 */
export function buildAssistantCommandSendOptions(
  command: CommandInput,
  handlers: CommandHandlers
): { options: SendToAIOptions; wasDelivered: () => boolean } {
  const { delivery } = command;
  let pasteHeld = false;
  let clipboardPreserved = false;
  let delivered = false;
  const holdInPanel = (hold?: HoldDeliveryOptions): void => {
    pasteHeld = true;
    if (hold?.preserveClipboard) clipboardPreserved = true;
    handlers.onResponseContent();
  };

  return {
    options: {
      attachment: command.attachment ?? undefined,
      selectedContext: command.selectedContext ?? undefined,
      suppressResponseContent: delivery?.mode === "paste",
      // A caret in a markdown-friendly app still keeps the compact pill.
      plainTextResponse: delivery?.mode === "paste" && delivery.plainText,
      onApprovalRequested: () => holdInPanel(),
      onHoldDelivery: holdInPanel,
      onComplete: delivery
        ? async ({ content }) => {
            if (clipboardPreserved) return;
            const result = await handlers.deliver(pasteHeld ? PANEL_DELIVERY : delivery, content);
            delivered = result.pasted;
            if (result.copied) handlers.confirmCopied(content);
          }
        : undefined,
    },
    wasDelivered: () => delivered,
  };
}
