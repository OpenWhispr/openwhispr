export type AssistantResponseDelivery =
  | {
      mode: "paste";
      sessionId: string;
      restoreClipboard: boolean;
      allowClipboardFallback: boolean;
    }
  | { mode: "clipboard" };

interface AssistantResponseDeliveryApi {
  pasteAtCapturedTarget?: (
    sessionId: string,
    text: string,
    options?: { restoreClipboard?: boolean; allowClipboardFallback?: boolean }
  ) => Promise<{ success: boolean }>;
  writeClipboard?: (text: string) => Promise<{ success: boolean }>;
}

interface ClipboardWriter {
  writeText: (text: string) => Promise<void>;
}

interface AssistantResponseDeliveryDependencies {
  electronAPI?: AssistantResponseDeliveryApi;
  clipboard?: ClipboardWriter;
}

export function createAssistantResponseDelivery({
  autoPasteEnabled,
  deliverySessionId,
  restoreClipboard,
  allowClipboardFallback,
}: {
  autoPasteEnabled: boolean;
  deliverySessionId?: string;
  restoreClipboard: boolean;
  allowClipboardFallback: boolean;
}): AssistantResponseDelivery | null {
  if (!autoPasteEnabled) return null;
  if (!deliverySessionId) return { mode: "clipboard" };

  return {
    mode: "paste",
    sessionId: deliverySessionId,
    restoreClipboard,
    allowClipboardFallback,
  };
}

async function copyAssistantResponse(
  content: string,
  electronAPI: AssistantResponseDeliveryApi | undefined,
  clipboard: ClipboardWriter | undefined
): Promise<boolean> {
  try {
    const result = await electronAPI?.writeClipboard?.(content);
    if (result?.success === true) return true;
  } catch {}

  try {
    await clipboard?.writeText(content);
    return Boolean(clipboard);
  } catch {
    return false;
  }
}

export async function deliverAssistantResponse(
  delivery: AssistantResponseDelivery,
  content: string,
  dependencies: AssistantResponseDeliveryDependencies = {}
): Promise<{ pasted: boolean; copied: boolean }> {
  const electronAPI = dependencies.electronAPI ?? window.electronAPI;
  const clipboard = dependencies.clipboard ?? navigator.clipboard;

  if (delivery.mode === "paste") {
    try {
      const result = await electronAPI?.pasteAtCapturedTarget?.(delivery.sessionId, content, {
        restoreClipboard: delivery.restoreClipboard,
        allowClipboardFallback: delivery.allowClipboardFallback,
      });
      if (result?.success === true) return { pasted: true, copied: false };
    } catch {}
  }

  return {
    pasted: false,
    copied: await copyAssistantResponse(content, electronAPI, clipboard),
  };
}
