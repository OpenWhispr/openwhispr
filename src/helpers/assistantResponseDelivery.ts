import { markdownToPlainText } from "./markdownToPlainText";
import type { ToneAppCategory } from "../config/toneStyle";

export type AssistantResponseDelivery =
  | {
      mode: "paste";
      sessionId: string;
      restoreClipboard: boolean;
      allowClipboardFallback: boolean;
      /** Ask for prose and strip markdown before pasting. False for a markdown-friendly target. */
      plainText: boolean;
      /** Tone & Style: the kind of app the answer is pasted into, when known. */
      appCategory?: ToneAppCategory;
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
  acceptsMarkdown,
  appCategory,
  restoreClipboard,
  allowClipboardFallback,
}: {
  autoPasteEnabled: boolean;
  deliverySessionId?: string;
  acceptsMarkdown?: boolean;
  appCategory?: ToneAppCategory;
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
    ...(appCategory ? { appCategory } : {}),
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

// An answer typed in the user's Tone & Style is their own words, which no tone
// writes with em dashes. The prompt says so, but models still use them, so a
// dash between words becomes a comma; one beside , . ; : ! ? or at a line's
// edge is dropped.
function withoutEmDashes(text: string): string {
  return text
    .replace(/^[^\S\r\n]*\u2014+[^\S\r\n]*/gm, "")
    .replace(/[^\S\r\n]*\u2014+[^\S\r\n]*(?=[,.;:!?]|$)/gm, "")
    .replace(/(?<=[,.;:!?])[^\S\r\n]*\u2014+[^\S\r\n]*/g, " ")
    .replace(/[^\S\r\n]*\u2014+[^\S\r\n]*/g, ", ");
}

export async function deliverAssistantResponse(
  delivery: AssistantResponseDelivery,
  content: string,
  dependencies: AssistantResponseDeliveryDependencies = {}
): Promise<{ pasted: boolean; copied: boolean }> {
  const electronAPI = dependencies.electronAPI ?? window.electronAPI;
  const clipboard = dependencies.clipboard ?? navigator.clipboard;

  if (delivery.mode === "paste") {
    // Both strips also cover the clipboard fallback (the user pastes into the
    // same field by hand); an answer the markdown strip empties is pasted raw.
    const body = delivery.plainText ? markdownToPlainText(content) || content : content;
    const text = delivery.appCategory ? withoutEmDashes(body) : body;
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
