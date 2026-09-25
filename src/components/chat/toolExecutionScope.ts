import type { HoldDeliveryOptions, ToolExecutionContext } from "../../services/tools/ToolRegistry";

export interface ToolExecutionScope {
  createContext: (toolCallId: string) => ToolExecutionContext;
  abort: () => void;
}

interface ToolExecutionHandlers {
  onApprovalRequested?: () => void;
  onHoldDelivery?: (options?: HoldDeliveryOptions) => void;
}

/**
 * One scope per chat send. Its signal is the single thing every
 * conversation-ending path (Esc, new chat, unmount) aborts, so tools waiting
 * on the user (approval cards) are released no matter how the turn ended.
 * Notices from a tool that finishes after that are dropped, so a late result
 * cannot reopen a panel the user dismissed.
 */
export function createToolExecutionScope(handlers: ToolExecutionHandlers = {}): ToolExecutionScope {
  const controller = new AbortController();
  const turnSlots = new Map<string, number>();
  const notify =
    <Args extends unknown[]>(handler?: (...args: Args) => void) =>
    (...args: Args): void => {
      if (!controller.signal.aborted) handler?.(...args);
    };
  const claimTurnSlot = (key: string, limit: number): boolean => {
    const used = turnSlots.get(key) ?? 0;
    if (used >= limit) return false;
    turnSlots.set(key, used + 1);
    return true;
  };
  const releaseTurnSlot = (key: string): void => {
    const used = turnSlots.get(key) ?? 0;
    if (used > 0) turnSlots.set(key, used - 1);
  };
  return {
    createContext: (toolCallId) => ({
      toolCallId,
      signal: controller.signal,
      onApprovalRequested: notify(handlers.onApprovalRequested),
      onHoldDelivery: notify(handlers.onHoldDelivery),
      claimTurnSlot,
      releaseTurnSlot,
    }),
    abort: () => controller.abort(),
  };
}
