import { create } from "zustand";
import {
  BASE_SYSTEM_PROMPT,
  MEETING_INPUT_PREAMBLE,
  MEETING_SYSTEM_PROMPT,
  NOTE_INPUT_PREAMBLE,
  NOTE_OUTPUT_MAX_TOKENS,
  STANDALONE_PROMPT_KEYS,
} from "../helpers/builtinActions";
import reasoningService from "../services/ReasoningService";
import { getSettings, selectResolvedNoteFormatting } from "./settingsStore";
import { appendDictionarySuffix } from "../config/prompts";
import { generateNoteTitle } from "../utils/generateTitle";
import { buildNoteFormattingOverrides } from "../helpers/noteFormattingOverrides";
import { tagActionItemOwners, type MentionPerson } from "../utils/mentionMarkdown";
import type { ActionItem } from "../types/electron";

export type ActionProcessingStatus = "idle" | "processing" | "success";

export interface NoteActionState {
  status: ActionProcessingStatus;
  actionName: string | null;
}

export interface ActionErrorEvent {
  noteId: number;
  message: string;
  /** Set when the failure has a translatable form; the toast prefers it. */
  messageKey?: string;
  messageParams?: Record<string, string | number>;
}

interface ActionProcessingStoreState {
  noteStates: Record<number, NoteActionState>;
  errorEvents: ActionErrorEvent[];
}

const cancelledFlags = new Map<number, boolean>();
const processingFlags = new Map<number, boolean>();
const successTimers = new Map<number, NodeJS.Timeout>();

const IDLE_STATE: NoteActionState = { status: "idle", actionName: null };

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

export interface RunActionOptions {
  isCloudMode: boolean;
  modelId: string;
  isMeetingNote?: boolean;
  /** Opt-in so enhancement never renames a note the user has titled. */
  allowTitleGeneration?: boolean;
  /** People whose names in generated action-item owners become mention tags. */
  knownPeople?: MentionPerson[];
}

export interface RunActionLabels {
  noModel: string;
  noEndpoint: string;
  actionFailed: string;
}

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
  if (!modelId && !options.isCloudMode) {
    pushErrorEvent({ noteId, message: labels.noModel });
    return;
  }

  const settings = getSettings();
  const noteFormatting = selectResolvedNoteFormatting(settings);
  // A self-hosted config without a URL would fall through to a cloud provider.
  if (!options.isCloudMode && noteFormatting.mode === "self-hosted" && !noteFormatting.remoteUrl) {
    pushErrorEvent({ noteId, message: labels.noEndpoint });
    return;
  }

  cancelledFlags.set(noteId, false);
  processingFlags.set(noteId, true);
  setNoteState(noteId, { status: "processing", actionName: action.name });

  (async () => {
    try {
      const standalone =
        !!action.translation_key && STANDALONE_PROMPT_KEYS.has(action.translation_key);
      const basePrompt = standalone
        ? options.isMeetingNote
          ? MEETING_INPUT_PREAMBLE
          : NOTE_INPUT_PREAMBLE
        : options.isMeetingNote
          ? MEETING_SYSTEM_PROMPT
          : BASE_SYSTEM_PROMPT;
      const providerOverrides = buildNoteFormattingOverrides(noteFormatting, options.isCloudMode);
      const systemPrompt = appendDictionarySuffix(
        basePrompt + action.prompt,
        options.isMeetingNote ? settings.customDictionary : undefined,
        settings.uiLanguage
      );
      const enhanced = await reasoningService.processText(noteContent, modelId, null, {
        systemPrompt,
        maxTokens: NOTE_OUTPUT_MAX_TOKENS,
        temperature: 0.3,
        disableThinking: settings.noteFormattingDisableThinking,
        ...providerOverrides,
      });

      // IPC-bridged providers relay whatever the model returned; a blank
      // result must not be saved as the enhanced note.
      if (!enhanced.trim()) {
        throw new Error("Model returned no text");
      }

      if (cancelledFlags.get(noteId)) return;

      let title: string | undefined;
      if (options.allowTitleGeneration && getSettings().autoGenerateNoteTitle) {
        const generated = await generateNoteTitle(enhanced, modelId, providerOverrides);
        if (generated) title = generated;
      }

      if (cancelledFlags.get(noteId)) return;

      const updates: Record<string, string> = {
        enhanced_content: options.knownPeople?.length
          ? tagActionItemOwners(enhanced, options.knownPeople)
          : enhanced,
        enhancement_prompt: action.prompt,
        enhanced_at_content_hash: contentHash,
      };
      if (title) updates.title = title;
      await window.electronAPI.updateNote(noteId, updates);

      setNoteState(noteId, { status: "success", actionName: action.name });

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
      const message = err instanceof Error ? err.message : labels.actionFailed;
      const { messageKey, messageParams } = (err ?? {}) as {
        messageKey?: string;
        messageParams?: Record<string, string | number>;
      };
      pushErrorEvent({ noteId, message, messageKey, messageParams });
    } finally {
      cancelledFlags.delete(noteId);
    }
  })();
}

/** Soft cancel: the HTTP request continues but the result is discarded. */
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
