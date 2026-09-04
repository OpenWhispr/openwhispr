import { create } from "zustand";
import reasoningService from "../services/ReasoningService";
import { getSettings, selectResolvedNoteFormatting } from "./settingsStore";
import { appendDictionarySuffix } from "../config/prompts";
import { generateNoteTitle } from "../utils/generateTitle";
import { buildNoteFormattingOverrides } from "../helpers/noteFormattingOverrides";
import type { ActionItem } from "../types/electron";

export type ActionProcessingStatus = "idle" | "processing" | "success";

export interface NoteActionState {
  status: ActionProcessingStatus;
  actionName: string | null;
  /** Only set for a multi-pass local run; a single call leaves these null. */
  phase?: "extracting" | "folding" | "composing" | null;
  currentPass?: number | null;
  totalPasses?: number | null;
  /** True when some section could not be extracted and was marked as a gap. */
  partial?: boolean;
}

export interface TranscriptSegmentPayload {
  label: string;
  text: string;
}

export interface ActionErrorEvent {
  noteId: number;
  message: string;
  /** "warning" is used for a run that finished with a gap in it. */
  severity?: "error" | "warning";
}

interface ActionProcessingStoreState {
  noteStates: Record<number, NoteActionState>;
  errorEvents: ActionErrorEvent[];
}

const cancelledFlags = new Map<number, boolean>();
const processingFlags = new Map<number, boolean>();
const successTimers = new Map<number, NodeJS.Timeout>();

const IDLE_STATE: NoteActionState = {
  status: "idle",
  actionName: null,
  phase: null,
  currentPass: null,
  totalPasses: null,
  partial: false,
};

let progressUnsubscribe: (() => void) | null = null;

/**
 * Multi-pass runs report progress from the main process. Subscribing lazily
 * keeps this store usable in tests and in the dictation window, neither of which
 * has the listener bridged.
 */
function ensureProgressSubscription() {
  if (progressUnsubscribe || typeof window === "undefined") return;
  const onProgress = window.electronAPI?.onNoteActionProgress;
  if (!onProgress) return;
  progressUnsubscribe = onProgress(({ noteId, phase, currentPass, totalPasses }) => {
    if (!processingFlags.get(noteId)) return;
    setNoteState(noteId, { phase, currentPass, totalPasses });
  });
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

function pushErrorEvent(event: ActionErrorEvent) {
  const { errorEvents } = useActionProcessingStore.getState();
  useActionProcessingStore.setState({ errorEvents: [...errorEvents, event] });
}

export const useActionProcessingStore = create<ActionProcessingStoreState>()(() => ({
  noteStates: {},
  errorEvents: [],
}));

const BASE_SYSTEM_PROMPT = `You are a note enhancement assistant. The user will provide raw notes — possibly voice-transcribed, rough, or unstructured. Your job is to clean them up according to the instructions below while preserving all original meaning and information. Output clean markdown.

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no date/time/location, no attendee list, no topic header. Start directly with the content.
- Do NOT use tables, horizontal rules, or block quotes.
- Do NOT list or guess participant names/roles.
- Keep the tone professional and concise. Bias toward brevity.

Instructions: `;

const MEETING_SYSTEM_PROMPT = `You are a sharp, thorough meeting notes assistant that captures not just what was said, but what it means. You will receive a dual-speaker transcript where "You:" marks the user's speech and "Them:" marks the other participant(s), along with any manual notes the user took.

Produce notes in the following structure:

## TL;DR
3-5 bullets. Lead each with **topic in bold**, then what happened + the "so what."

## Meeting Overview
One short paragraph: what this meeting was about, who participated, and the overall tone.

## Topics Covered
One subsection per distinct topic, ordered by importance:
### [Topic Name]
**What was discussed:** Key points, positions taken. Use "You" and "Them" as speaker labels.
**Decisions made:** What was agreed, or "None."
**Open questions:** Anything unresolved.

## Decisions & Open Items
- **Decided:** [list]
- **Still open:** [list]

## Action Items
- [ ] **You:** [action] — [deadline if stated]
- [ ] **Them:** [action] — [deadline if stated]

## Key Takeaways
2-3 sentences: implications, risks, soft commitments, things carefully avoided.

FORMAT RULES (strict):
- Do NOT repeat the meeting title.
- Do NOT use tables, horizontal rules, or block quotes.
- Use markdown headings and bullets for scannability.
- Preserve important quotes or commitments verbatim when they carry weight.
- Consolidate repeated points. Remove filler, small talk, false starts.
- If manual notes were included, integrate them — they represent the user's emphasis.
- Keep the tone professional but direct. Capture meaning and sentiment, not just words.

Instructions: `;

export interface RunActionOptions {
  modelId: string;
  isMeetingNote?: boolean;
  /** Opt-in so enhancement never renames a note the user has titled. */
  allowTitleGeneration?: boolean;
  /**
   * Speaker-labelled transcript segments, carried so a local run can split a
   * transcript on segment boundaries. The main process cannot read these from
   * the database: the editor buffer and the realtime transcript are both ahead
   * of the stored copy, which is only flushed every 30 seconds.
   */
  segments?: TranscriptSegmentPayload[];
}

export interface RunActionLabels {
  noModel: string;
  noEndpoint: string;
  actionFailed: string;
  promptTooLong: string;
  partialResult: string;
  runTimedOut: string;
  runDegraded: string;
  notEnoughMemory: string;
}

/** Known failure codes get a translated message rather than a raw English one. */
const CODE_LABELS: Record<string, keyof RunActionLabels> = {
  LOCAL_CONTEXT_EXCEEDED: "promptTooLong",
  LOCAL_MULTIPASS_TIMEOUT: "runTimedOut",
  LOCAL_MULTIPASS_DEGRADED: "runDegraded",
  LOCAL_INSUFFICIENT_MEMORY: "notEnoughMemory",
};

/**
 * Start processing an action on a note. Runs in the background — survives
 * component unmounts and navigation so the user can switch notes mid-action.
 */
export function runBackgroundAction(
  noteId: number,
  noteContent: string,
  contentHash: string,
  action: ActionItem,
  options: RunActionOptions,
  labels: RunActionLabels
): void {
  if (processingFlags.get(noteId)) return;

  const modelId = options.modelId;
  if (!modelId) {
    pushErrorEvent({ noteId, message: labels.noModel });
    return;
  }

  const settings = getSettings();
  const noteFormatting = selectResolvedNoteFormatting(settings);
  // A self-hosted config without a URL would fall through to a cloud provider.
  if (noteFormatting.mode === "self-hosted" && !noteFormatting.remoteUrl) {
    pushErrorEvent({ noteId, message: labels.noEndpoint });
    return;
  }

  cancelledFlags.set(noteId, false);
  processingFlags.set(noteId, true);
  setNoteState(noteId, { status: "processing", actionName: action.name });

  (async () => {
    try {
      const basePrompt = options.isMeetingNote ? MEETING_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
      const providerOverrides = buildNoteFormattingOverrides(
        noteFormatting,
        settings.noteFormattingCustomApiKey
      );
      const systemPrompt = appendDictionarySuffix(
        basePrompt + action.prompt,
        options.isMeetingNote ? settings.customDictionary : undefined,
        settings.uiLanguage
      );
      // Local models get the main-process runner: it can split a transcript
      // that exceeds the context into passes, and it shares the scheduler that
      // keeps a long run from starving dictation. Every other provider keeps
      // today's single renderer call — no cloud model declares a context length,
      // so there is nothing to chunk against.
      let enhanced: string;
      let partial = false;
      if (noteFormatting.mode === "local" && window.electronAPI?.runNoteAction) {
        ensureProgressSubscription();
        const result = await window.electronAPI.runNoteAction({
          noteId,
          noteContent,
          segments: options.segments ?? [],
          systemPrompt,
          modelId,
          disableThinking: settings.noteFormattingDisableThinking,
        });
        if (!result.success || typeof result.text !== "string") {
          const error: Error & { code?: string } = new Error(
            result.error || labels.actionFailed
          );
          error.code = result.code;
          throw error;
        }
        enhanced = result.text;
        partial = result.partial === true;
      } else {
        enhanced = await reasoningService.processText(noteContent, modelId, null, {
          systemPrompt,
          temperature: 0.3,
          disableThinking: settings.noteFormattingDisableThinking,
          ...providerOverrides,
        });
      }

      if (cancelledFlags.get(noteId)) return;

      let title: string | undefined;
      if (options.allowTitleGeneration && getSettings().autoGenerateNoteTitle) {
        const generated = await generateNoteTitle(enhanced, modelId, providerOverrides);
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

      if (partial) {
        // A note with a hole in it must say so. Silently handing back notes
        // that are missing a stretch of the call is the failure this whole
        // feature exists to prevent.
        pushErrorEvent({ noteId, message: labels.partialResult, severity: "warning" });
      }

      setNoteState(noteId, {
        status: "success",
        actionName: action.name,
        phase: null,
        currentPass: null,
        totalPasses: null,
        partial,
      });

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
      const code = (err as { code?: string })?.code;
      const labelKey = code ? CODE_LABELS[code] : undefined;
      const message = labelKey
        ? labels[labelKey]
        : err instanceof Error
          ? err.message
          : labels.actionFailed;
      pushErrorEvent({ noteId, message });
    } finally {
      cancelledFlags.delete(noteId);
    }
  })();
}

/**
 * Cloud calls are cancelled softly — the request continues and the result is
 * discarded. A local multi-pass run is told to stop for real, so cancelling a
 * ten-minute job stops it after the pass in flight rather than at the end.
 */
export function cancelAction(noteId: number): void {
  cancelledFlags.set(noteId, true);
  processingFlags.set(noteId, false);
  window.electronAPI?.cancelNoteAction?.(noteId).catch(() => {});
  const timer = successTimers.get(noteId);
  if (timer) {
    clearTimeout(timer);
    successTimers.delete(noteId);
  }
  clearNoteState(noteId);
}

export function consumeErrorEvents(): ActionErrorEvent[] {
  const { errorEvents } = useActionProcessingStore.getState();
  if (errorEvents.length === 0) return [];
  useActionProcessingStore.setState({ errorEvents: [] });
  return errorEvents;
}

export function selectNoteActionState(
  state: ActionProcessingStoreState,
  noteId: number | null
): NoteActionState {
  if (noteId == null) return IDLE_STATE;
  return state.noteStates[noteId] ?? IDLE_STATE;
}
