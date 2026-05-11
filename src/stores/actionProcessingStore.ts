import { create } from "zustand";
import reasoningService from "../services/ReasoningService";
import { getEffectiveCleanupModel, getSettings } from "./settingsStore";
import { generateNoteTitle } from "../utils/generateTitle";
import type { ActionItem } from "../types/electron";

export type ActionProcessingStatus = "idle" | "processing" | "success";

export interface NoteActionState {
  status: ActionProcessingStatus;
  actionName: string | null;
}

/** Event emitted when a background action completes or fails. */
export interface ActionCompletionEvent {
  noteId: number;
  type: "success" | "error";
  message?: string;
}

interface ActionProcessingStoreState {
  /** Processing state keyed by note ID. */
  noteStates: Record<number, NoteActionState>;
  /**
   * Completion events for background actions (actions that finished while the
   * user was viewing a different note or a different view entirely).
   * Components consume and clear these to show toast notifications.
   */
  completionEvents: ActionCompletionEvent[];
}

// ---------- internal mutable state (not in Zustand) ----------

/** Soft-cancel flags per note — mutable refs outside React. */
const cancelledFlags = new Map<number, boolean>();

/** Mutex to prevent concurrent runs on the same note. */
const processingFlags = new Map<number, boolean>();

/** Success-display timers per note. */
const successTimers = new Map<number, NodeJS.Timeout>();

// ---------- helpers ----------

const IDLE_STATE: NoteActionState = { status: "idle", actionName: null };

function getNoteState(state: ActionProcessingStoreState, noteId: number): NoteActionState {
  return state.noteStates[noteId] ?? IDLE_STATE;
}

function setNoteState(noteId: number, patch: Partial<NoteActionState>) {
  const { noteStates } = useActionProcessingStore.getState();
  const prev = noteStates[noteId] ?? IDLE_STATE;
  useActionProcessingStore.setState({
    noteStates: { ...noteStates, [noteId]: { ...prev, ...patch } },
  });
}

function clearNoteState(noteId: number) {
  const { noteStates } = useActionProcessingStore.getState();
  const next = { ...noteStates };
  delete next[noteId];
  useActionProcessingStore.setState({ noteStates: next });
}

function pushCompletionEvent(event: ActionCompletionEvent) {
  const { completionEvents } = useActionProcessingStore.getState();
  useActionProcessingStore.setState({
    completionEvents: [...completionEvents, event],
  });
}

// ---------- store ----------

export const useActionProcessingStore = create<ActionProcessingStoreState>()(() => ({
  noteStates: {},
  completionEvents: [],
}));

// ---------- system prompts ----------

const BASE_SYSTEM_PROMPT = `You are a note enhancement assistant. The user will provide raw notes — possibly voice-transcribed, rough, or unstructured. Your job is to clean them up according to the instructions below while preserving all original meaning and information. Output clean markdown.

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no date/time/location, no attendee list, no topic header. Start directly with the content.
- Do NOT use tables, horizontal rules, or block quotes.
- Do NOT list or guess participant names/roles.
- Keep the tone professional and concise. Bias toward brevity.

Instructions: `;

const MEETING_SYSTEM_PROMPT = `You are a professional meeting notes assistant. You will receive a dual-speaker transcript where "You:" marks the user's speech and "Them:" marks the other participant(s), along with any manual notes the user took.

Your job is to produce clean, actionable meeting notes in markdown. Follow these rules:

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no "# Meeting Notes", no date/time/location, no attendee list, no topic header. Start directly with the summary.
- Do NOT use tables, horizontal rules, or block quotes.
- Do NOT list or guess participant names/roles.
- Start with a concise 1–2 sentence summary of what the meeting was about.
- Use clear section headings: ## Key Discussion Points, ## Decisions Made, ## Action Items, ## Follow-ups (omit any section that has no content).
- Under Action Items, use checkboxes (\`- [ ]\`) and attribute each item to "You" or "Them" where clear.

CONTENT RULES:
- Preserve important quotes or specific commitments verbatim when they carry meaning.
- Remove filler, small talk, false starts, and repeated/redundant content.
- Where speakers refer to the same topic across multiple turns, consolidate into a coherent point rather than listing every utterance.
- If the user included manual notes alongside the transcript, integrate them — they represent the user's emphasis on what matters most.
- Keep the tone professional and concise. Bias toward brevity.

Instructions: `;

// ---------- public API ----------

export interface RunActionOptions {
  isCloudMode: boolean;
  modelId: string;
  isMeetingNote?: boolean;
}

/**
 * Start processing an action on a note. Runs in the background — survives
 * component unmounts and navigation. On completion the result is persisted
 * directly via IPC.
 */
export function runBackgroundAction(
  noteId: number,
  noteContent: string,
  contentHash: string,
  action: ActionItem,
  options: RunActionOptions,
  errorLabel: string
): void {
  // Guard concurrent runs on same note
  if (processingFlags.get(noteId)) return;

  const modelId = getEffectiveCleanupModel() || options.modelId;
  if (!modelId && !options.isCloudMode) return;

  cancelledFlags.set(noteId, false);
  processingFlags.set(noteId, true);
  setNoteState(noteId, { status: "processing", actionName: action.name });

  // Fire-and-forget async — intentionally not awaited
  (async () => {
    try {
      const basePrompt = options.isMeetingNote ? MEETING_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
      const systemPrompt = basePrompt + action.prompt;
      const enhanced = await reasoningService.processText(noteContent, modelId, null, {
        systemPrompt,
        temperature: 0.3,
        disableThinking: getSettings().noteFormattingDisableThinking,
      });

      if (cancelledFlags.get(noteId)) return;

      let title: string | undefined;
      if (getSettings().autoGenerateNoteTitle) {
        const generated = await generateNoteTitle(enhanced, modelId);
        if (generated) title = generated;
      }

      if (cancelledFlags.get(noteId)) return;

      const updates: Record<string, string> = {
        enhanced_content: enhanced,
        enhancement_prompt: action.prompt,
        enhanced_at_content_hash: contentHash,
      };
      if (title) updates.title = title;
      await window.electronAPI.updateNote(noteId, updates);

      setNoteState(noteId, { status: "success", actionName: action.name });
      pushCompletionEvent({ noteId, type: "success" });

      const timer = setTimeout(() => {
        processingFlags.set(noteId, false);
        clearNoteState(noteId);
        successTimers.delete(noteId);
      }, 600);
      successTimers.set(noteId, timer);
    } catch (err) {
      if (cancelledFlags.get(noteId)) return;
      processingFlags.set(noteId, false);
      clearNoteState(noteId);
      const message = err instanceof Error ? err.message : errorLabel;
      pushCompletionEvent({ noteId, type: "error", message });
    } finally {
      cancelledFlags.delete(noteId);
    }
  })();
}

/**
 * Manually cancel an in-progress action on a note (e.g. user clicks a cancel
 * button). This is a soft cancel — the HTTP request continues but results are
 * discarded.
 */
export function cancelAction(noteId: number): void {
  cancelledFlags.set(noteId, true);
  processingFlags.set(noteId, false);
  const timer = successTimers.get(noteId);
  if (timer) {
    clearTimeout(timer);
    successTimers.delete(noteId);
  }
  clearNoteState(noteId);
}

/** Consume and clear all pending completion events. */
export function consumeCompletionEvents(): ActionCompletionEvent[] {
  const { completionEvents } = useActionProcessingStore.getState();
  if (completionEvents.length === 0) return [];
  useActionProcessingStore.setState({ completionEvents: [] });
  return completionEvents;
}

/** Selector: get the processing state for a specific note. */
export function selectNoteActionState(
  state: ActionProcessingStoreState,
  noteId: number | null
): NoteActionState {
  if (noteId == null) return IDLE_STATE;
  return state.noteStates[noteId] ?? IDLE_STATE;
}
