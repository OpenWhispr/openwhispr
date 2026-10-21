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
  writeClipboard?: (text: string) => Promise<{ success: boolean; xwaylandOnly?: boolean }>;
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
    // The user's app still has focus, so it can't read this copy (#2621); the
    // renderer's clipboard would land in the same place.
    if (result?.xwaylandOnly) return false;
    if (result?.success === true) return true;
  } catch {}

  try {
    await clipboard?.writeText(content);
    return Boolean(clipboard);
  } catch {
    return false;
  }
}

// A run of em dashes with the spaces around it, on one line.
const EM_DASH_RUN = /[^\S\r\n]*\u2014(?:[^\S\r\n]*\u2014)*[^\S\r\n]*/g;
// Code and links keep their dashes.
const LITERAL_TEXT = /```[\s\S]*?```|`[^`\n]*`|\bhttps?:\/\/\S+/g;
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const DIGIT = /\p{Nd}/u;
const CLOSES_CLAUSE = /[,.;:!?)\]}\u201d\u2019\u00bb]/;
const OPENS = /[([{\u201c\u2018\u00ab]/;
const PUNCTUATION = /[,.;:!?]/;

function replaceEmDashRun(run: string, before: string, after: string): string {
  // Russian, Chinese and other scripts use the dash in their own grammar.
  if (NON_LATIN_LETTER.test(before) || NON_LATIN_LETTER.test(after)) return run;
  // A range (1990\u20142000, Q3\u2014Q4) is not a pause, so it takes an en dash.
  const unspaced = run.trim() === run;
  if (
    (DIGIT.test(before) && DIGIT.test(after)) ||
    (unspaced && (DIGIT.test(before) || DIGIT.test(after)) && /\w/.test(before + after))
  ) {
    return run.replace(/\u2014(?:[^\S\r\n]*\u2014)*/, "\u2013");
  }
  if (!after || after === "\n" || after === "\r" || CLOSES_CLAUSE.test(after)) return "";
  if (!before || before === "\n" || before === "\r" || OPENS.test(before)) return "";
  return PUNCTUATION.test(before) ? " " : ", ";
}

// An answer typed in the user's Tone & Style is their own words, which no tone
// writes with em dashes. The prompt says so, but models still use them, so a
// dash between words becomes a comma; one at a line's edge or beside
// punctuation or a bracket is dropped. Ranges, code, links and non-Latin
// scripts keep theirs, since there the dash carries meaning.
function withoutEmDashes(text: string): string {
  const literals = [...text.matchAll(LITERAL_TEXT)].map((match) => [
    match.index,
    match.index + match[0].length,
  ]);
  return text.replace(EM_DASH_RUN, (run: string, offset: number) =>
    literals.some(([start, end]) => offset >= start && offset < end)
      ? run
      : replaceEmDashRun(run, text[offset - 1] ?? "", text[offset + run.length] ?? "")
  );
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
