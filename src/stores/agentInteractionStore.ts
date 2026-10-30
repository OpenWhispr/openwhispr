import { create } from "zustand";
import type { ToolExecutionContext } from "../services/tools/ToolRegistry";
import type { ChatImageAttachment } from "../components/chat/types";
import type {
  ConnectionTarget,
  InteractionAnswers,
  InteractionPayload,
  InteractionQuestion,
  InteractionResult,
} from "../types/agentInteractions";
import { APPROVAL_TTL_MS, approvalKey } from "./connectorApprovalStore";
import {
  isConnectorReady,
  readyConnectorIds,
  refreshConnectorStatus,
} from "./connectorStatusStore";
import type { CalendarProvider } from "../utils/calendarConnect";
import type { SettingsState } from "./settingsStore";
import { getCachedPlatform } from "../utils/platform";

// Every surface that renders a card imports this store, and the settings
// store brings the app's i18n setup with it, so it loads only when used.
const loadSettingsStore = () => import("./settingsStore");

// The model providers whose key the agent may ask for (BYOK_API_KEYS bases in
// config/secretKeys.js), with the setter that saves each one securely.
const API_KEY_SETTERS = {
  openai: "setOpenaiApiKey",
  anthropic: "setAnthropicApiKey",
  gemini: "setGeminiApiKey",
  groq: "setGroqApiKey",
  openrouter: "setOpenrouterApiKey",
  tinfoil: "setTinfoilApiKey",
} as const satisfies Record<string, keyof SettingsState>;

type ApiKeyProvider = keyof typeof API_KEY_SETTERS;
export const API_KEY_PROVIDERS = Object.keys(API_KEY_SETTERS) as ApiKeyProvider[];

/** Same as an approval card: a question nobody answers stops holding the turn. */
export const INTERACTION_TTL_MS = APPROVAL_TTL_MS;

export interface InteractionEntry {
  /** approvalKey(messageId, toolCallId), the same key an approval card uses. */
  key: string;
  messageId: string;
  toolCallId: string;
  payload: InteractionPayload;
  /** working: a connect, capture or check started from the card is running. */
  state: "pending" | "working" | "settled";
  /** The answer being put together (option ids, typed text), kept while the card remounts. */
  draft: InteractionAnswers;
  result?: InteractionResult;
  /** Why the last attempt from the card failed (an error code); the card stays open to retry. */
  error?: string;
}

interface InteractionStoreState {
  entries: Record<string, InteractionEntry>;
}

export const useAgentInteractionStore = create<InteractionStoreState>(() => ({ entries: {} }));

interface Waiter {
  settle: (result: InteractionResult) => void;
  detach: () => void;
}

// Resolvers stay outside zustand state: they are not renderable.
const waiters = new Map<string, Waiter>();
// A granted screenshot goes to the turn that asked, never into a saved result.
const grantedImages = new Map<string, ChatImageAttachment>();

function entryFor(key: string): InteractionEntry | undefined {
  return useAgentInteractionStore.getState().entries[key];
}

function patchEntry(key: string, patch: Partial<InteractionEntry>): void {
  useAgentInteractionStore.setState((state) => {
    const entry = state.entries[key];
    if (!entry) return state;
    return { entries: { ...state.entries, [key]: { ...entry, ...patch } } };
  });
}

function addEntry(
  key: string,
  request: { messageId: string; toolCallId: string; payload: InteractionPayload },
  waiter: Waiter
): void {
  waiters.set(key, waiter);
  useAgentInteractionStore.setState((state) => ({
    entries: { ...state.entries, [key]: { key, ...request, state: "pending", draft: {} } },
  }));
}

function settle(key: string, result: InteractionResult): void {
  const waiter = waiters.get(key);
  if (!waiter) return;
  waiters.delete(key);
  waiter.detach();
  patchEntry(key, { state: "settled", result, error: undefined });
  waiter.settle(result);
}

function isOpen(key: string): boolean {
  return waiters.has(key);
}

function cancelRunningConnect(entry: InteractionEntry | undefined): void {
  if (entry?.state !== "working" || entry.payload.kind !== "connection") return;
  void window.electronAPI?.connectorCancelConnect?.(entry.payload.target);
}

function withdraw(key: string, reason: "conversation_ended" | "expired"): void {
  cancelRunningConnect(entryFor(key));
  settle(key, { status: "not_answered", reason });
}

/**
 * Shows an interaction and waits for the user. Resolves on an answer, a
 * cancel, the TTL or the turn ending, like requestApproval: the tool call,
 * and with it the turn, stays paused until then.
 */
export function requestInteraction(
  context: ToolExecutionContext,
  payload: InteractionPayload
): Promise<InteractionResult> {
  const { messageId, toolCallId, signal } = context;
  const key = approvalKey(messageId, toolCallId);
  if (signal.aborted) {
    return Promise.resolve({ status: "not_answered", reason: "conversation_ended" });
  }
  if (isOpen(key)) {
    return Promise.resolve({ status: "not_answered", reason: "duplicate_tool_call" });
  }
  return new Promise((resolve) => {
    const onAbort = (): void => withdraw(key, "conversation_ended");
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => withdraw(key, "expired"), INTERACTION_TTL_MS);
    addEntry(
      key,
      { messageId, toolCallId, payload },
      {
        settle: (result) => {
          context.onInteraction({ payload, state: "settled", result });
          resolve(result);
        },
        detach: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        },
      }
    );
    context.onHoldDelivery();
    context.onApprovalRequested();
    context.onInteraction({ payload, state: "pending" });
  });
}

/**
 * Reopens an interaction whose turn ended before it was answered. Nothing is
 * waiting on it any more, so its outcome goes to `onSettled`, which continues
 * the task in a new turn. False when it is already open.
 */
export function restoreInteraction(
  request: { messageId: string; toolCallId: string; payload: InteractionPayload },
  onSettled: (result: InteractionResult) => void
): boolean {
  const key = approvalKey(request.messageId, request.toolCallId);
  if (isOpen(key)) return false;
  addEntry(key, request, { settle: onSettled, detach: () => {} });
  return true;
}

/**
 * Takes a restored interaction away unanswered (its conversation moved on or
 * closed), so it stays saved as interrupted and nothing continues from it.
 */
export function forgetInteraction(key: string): void {
  cancelRunningConnect(entryFor(key));
  waiters.delete(key);
  useAgentInteractionStore.setState((state) => {
    const { [key]: _removed, ...entries } = state.entries;
    return { entries };
  });
}

export function updateInteractionDraft(key: string, draft: InteractionAnswers): void {
  if (entryFor(key)?.state === "pending") patchEntry(key, { draft });
}

// Every question answered: one known option, any known options, or some text.
function completeAnswers(
  questions: readonly InteractionQuestion[],
  draft: InteractionAnswers
): InteractionAnswers | null {
  const answers: InteractionAnswers = {};
  for (const question of questions) {
    const value = draft[question.id];
    const isOption = (id: unknown) => question.options?.some((option) => option.id === id);
    if (question.kind === "text") {
      if (typeof value !== "string" || !value.trim()) return null;
      answers[question.id] = value.trim();
    } else if (question.kind === "single") {
      if (!isOption(value)) return null;
      answers[question.id] = value;
    } else {
      answers[question.id] = Array.isArray(value) ? value.filter(isOption) : [];
    }
  }
  return answers;
}

/** Whether a questions card's draft answers every question, so it can be submitted. */
export function answersComplete(
  questions: readonly InteractionQuestion[],
  draft: InteractionAnswers
): boolean {
  return completeAnswers(questions, draft) !== null;
}

/** Submits the card's draft once every question has an answer. */
export function answerQuestions(key: string): boolean {
  const entry = entryFor(key);
  if (entry?.state !== "pending" || entry.payload.kind !== "questions") return false;
  const answers = completeAnswers(entry.payload.questions, entry.draft);
  if (!answers) return false;
  settle(key, { status: "answered", answers });
  return true;
}

export function cancelInteraction(key: string): void {
  const entry = entryFor(key);
  if (entry?.state !== "pending" && entry?.state !== "working") return;
  cancelRunningConnect(entry);
  settle(key, { status: "cancelled" });
}

type ConnectOutcome =
  | { status: "connected" }
  | { status: "cancelled" }
  | { status: "failed"; errorCode: string }
  | { status: "unavailable"; reason: string };

async function connectTarget(
  target: Exclude<ConnectionTarget, "calendar">
): Promise<ConnectOutcome> {
  if (target === "google" || target === "microsoft" || target === "apple") {
    const { connectCalendar } = await import("../utils/calendarConnect");
    const result = await connectCalendar(target);
    if (result === "connected" || result === "cancelled") return { status: result };
    return {
      status: "failed",
      errorCode: result === "denied" ? "permission_denied" : "connect_failed",
    };
  }
  let result;
  try {
    result = await window.electronAPI?.connectorConnect?.(target);
  } catch {
    result = undefined;
  }
  if (!result) return { status: "failed", errorCode: "connect_failed" };
  if (result.status === "unavailable") return result;
  if (result.status === "failed") {
    // A newer attempt or a closed browser tab cancels the older one; not an error.
    return result.errorCode === "oauth_cancelled" ? { status: "cancelled" } : result;
  }
  // Connected only once the status main reports says so.
  await refreshConnectorStatus();
  return isConnectorReady(target)
    ? { status: "connected" }
    : { status: "failed", errorCode: "connect_failed" };
}

/**
 * Runs the real connect flow for a connection card. A failure keeps the card
 * open with its error so the user can try again or dismiss it.
 */
export async function connectInteraction(key: string, provider?: CalendarProvider): Promise<void> {
  const entry = entryFor(key);
  if (entry?.state !== "pending" || entry.payload.kind !== "connection") return;
  const target = entry.payload.target === "calendar" ? provider : entry.payload.target;
  if (!target) return;
  patchEntry(key, { state: "working", error: undefined });
  const outcome = await connectTarget(target);
  if (!isOpen(key)) return;
  if (outcome.status === "connected") settle(key, { status: "connected", target });
  else if (outcome.status === "unavailable") {
    settle(key, { status: "unavailable", reason: outcome.reason });
  } else {
    patchEntry(key, {
      state: "pending",
      error: outcome.status === "failed" ? outcome.errorCode : undefined,
    });
  }
}

// macOS asks for Screen Recording first; elsewhere capture needs no grant.
async function captureScreen(): Promise<
  { image: ChatImageAttachment } | { failure: "permission_denied" | "capture_failed" }
> {
  if (getCachedPlatform() === "darwin") {
    const granted =
      (await window.electronAPI?.checkScreenRecordingAccess?.())?.granted ||
      (await window.electronAPI?.requestScreenRecordingAccess?.())?.granted;
    if (!granted) return { failure: "permission_denied" };
  }
  // Capture yields null on any failure (or an org block); it never throws.
  const image = await window.electronAPI?.captureScreenContext?.();
  return image
    ? { image: { image: image.data, mediaType: image.mediaType } }
    : { failure: "capture_failed" };
}

export async function respondToAccess(key: string, allow: boolean): Promise<void> {
  const entry = entryFor(key);
  if (entry?.state !== "pending" || entry.payload.kind !== "access") return;
  if (!allow) {
    settle(key, { status: "declined" });
    return;
  }
  patchEntry(key, { state: "working", error: undefined });
  const capture = await captureScreen();
  if (!isOpen(key)) return;
  if ("failure" in capture) {
    settle(key, { status: "unavailable", reason: capture.failure });
    return;
  }
  grantedImages.set(key, capture.image);
  settle(key, { status: "granted" });
}

/** The screenshot an access card captured, handed over once and then forgotten. */
export function takeGrantedImage(key: string): ChatImageAttachment | undefined {
  const image = grantedImages.get(key);
  grantedImages.delete(key);
  return image;
}

/**
 * Hands a key straight to the secure settings saver. The value never enters
 * the entry, the result or the conversation: the model only learns it was saved.
 */
export async function submitApiKey(key: string, value: string): Promise<void> {
  const entry = entryFor(key);
  if (entry?.state !== "pending" || entry.payload.kind !== "apiKey") return;
  const secret = value.trim();
  const { provider } = entry.payload;
  if (!secret || !Object.hasOwn(API_KEY_SETTERS, provider)) return;
  const { useSettingsStore } = await loadSettingsStore();
  if (!isOpen(key)) return;
  useSettingsStore.getState()[API_KEY_SETTERS[provider as ApiKeyProvider]](secret);
  settle(key, { status: "saved" });
}

export function openInteractionSettings(key: string): void {
  const entry = entryFor(key);
  if (entry?.state !== "pending" || entry.payload.kind !== "settings") return;
  void window.electronAPI?.openSettingsSection?.(entry.payload.target);
}

// Readiness the app can check for itself; other targets report done without it.
async function settingsReady(target: string): Promise<boolean | undefined> {
  if (target === "integrations.connectors") {
    await refreshConnectorStatus();
    return readyConnectorIds().length > 0;
  }
  if (target === "integrations.calendars") {
    const { getSettings, selectCalendarConnected } = await loadSettingsStore();
    return selectCalendarConnected(getSettings());
  }
  return undefined;
}

/** The user says they're done in Settings; the capability is checked again before resuming. */
export async function confirmSettingsDone(key: string): Promise<void> {
  const entry = entryFor(key);
  if (entry?.state !== "pending" || entry.payload.kind !== "settings") return;
  patchEntry(key, { state: "working" });
  const ready = await settingsReady(entry.payload.target);
  if (!isOpen(key)) return;
  settle(key, { status: "done", ...(ready !== undefined ? { ready } : {}) });
}
