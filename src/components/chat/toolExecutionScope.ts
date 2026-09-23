import type { ToolExecutionContext } from "../../services/tools/ToolRegistry";

export interface ToolExecutionScope {
  createContext: (toolCallId: string) => ToolExecutionContext;
  abort: () => void;
}

interface ToolExecutionHandlers {
  onApprovalRequested?: () => void;
  onClipboardReserved?: () => void;
}

/**
 * One scope per chat send. Its signal is the single thing every
 * conversation-ending path (Esc, new chat, unmount) aborts, so tools waiting
 * on the user (approval cards) are released no matter how the turn ended.
 */
export function createToolExecutionScope(handlers: ToolExecutionHandlers = {}): ToolExecutionScope {
  const controller = new AbortController();
  return {
    createContext: (toolCallId) => ({
      toolCallId,
      signal: controller.signal,
      onApprovalRequested: () => handlers.onApprovalRequested?.(),
      onClipboardReserved: () => handlers.onClipboardReserved?.(),
    }),
    abort: () => controller.abort(),
  };
}
