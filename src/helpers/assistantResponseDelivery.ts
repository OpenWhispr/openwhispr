import { markdownToPlainText } from "./markdownToPlainText";

export type AssistantResponseDelivery =
  | {
      mode: "paste";
      sessionId: string;
      restoreClipboard: boolean;
      allowClipboardFallback: boolean;
      /** Ask for prose and strip markdown before pasting. False for a markdown-friendly target. */
      plainText: boolean;
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
  acceptsMarkdown = false,
  restoreClipboard,
  allowClipboardFallback,
}: {
  autoPasteEnabled: boolean;
  deliverySessionId?: string;
  acceptsMarkdown?: boolean;
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
    plainText: !acceptsMarkdown,
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
    // plainText is the main process's verdict on the captured app. When set,
    // the model was asked for prose (plainTextResponse) and this is the floor
    // under a model that drifts back to markdown. It covers the clipboard
    // fallback too: a refused paste leaves the user about to paste the same
    // text by hand into the same field. A markdown-friendly target (Obsidian,
    // an AI prompt box) gets the answer exactly as written. A strip that
    // leaves nothing at all — an answer that is only fences and rules — falls
    // back to the raw answer, because pasting the markdown beats pasting
    // nothing into the user's field.
    const text = delivery.plainText ? markdownToPlainText(content) || content : content;
    try {
      const result = await electronAPI?.pasteAtCapturedTarget?.(delivery.sessionId, text, {
        restoreClipboard: delivery.restoreClipboard,
        allowClipboardFallback: delivery.allowClipboardFallback,
      });
      if (result?.success === true) return { pasted: true, copied: false };
    } catch {}
    return {
      pasted: false,
      copied: await copyAssistantResponse(text, electronAPI, clipboard),
    };
  }

  // A clipboard-only delivery is shown in the panel as rendered markdown and
  // its Copy button yields the raw markdown; keep the two copy paths equal.
  return {
    pasted: false,
    copied: await copyAssistantResponse(content, electronAPI, clipboard),
  };
}
