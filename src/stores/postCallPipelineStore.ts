import { create } from "zustand";

export type PipelineStep = "retranscribe" | "title" | "classify" | "notes" | "pipeline";
export type PipelineStepStatus = "pending" | "running" | "complete" | "skipped" | "error";
export type RetranscribeSubStage = "converting" | "transcribing" | "diarizing";

export interface TranscriptDiff {
  totalSegments: number;
  changedSegments: number;
  newSpeakerSplits: number;
}

export interface PipelineNoteState {
  noteId: number;
  currentStep: PipelineStep;
  currentStatus: PipelineStepStatus;
  subStage: RetranscribeSubStage | null;
  error: string | null;
  startedAt: number;
  steps: Partial<Record<PipelineStep, PipelineStepStatus>>;
  diff: TranscriptDiff | null;
  preservedReason: string | null;
}

interface PostCallPipelineStoreState {
  activePipelines: Record<number, PipelineNoteState>;
}

export const usePostCallPipelineStore = create<PostCallPipelineStoreState>()(() => ({
  activePipelines: {},
}));

export function handlePipelineStatus(payload: {
  noteId: number;
  step: PipelineStep;
  status: PipelineStepStatus;
  subStage?: RetranscribeSubStage;
  error?: string;
  diff?: TranscriptDiff;
  preserved?: boolean;
  reason?: string;
}) {
  const { noteId, step, status, subStage, error, diff, preserved, reason } = payload;
  const { activePipelines } = usePostCallPipelineStore.getState();

  if (step === "pipeline" && status === "complete") {
    // A preserved re-transcription is the one outcome the user still needs to see after
    // the run ends: the note kept its old transcript instead of being upgraded.
    const finished = activePipelines[noteId];
    const next = { ...activePipelines };
    if (finished?.preservedReason) {
      next[noteId] = { ...finished, currentStep: step, currentStatus: status };
    } else {
      delete next[noteId];
    }
    usePostCallPipelineStore.setState({ activePipelines: next });
    return;
  }

  const existing = activePipelines[noteId] ?? {
    noteId,
    currentStep: step,
    currentStatus: status,
    subStage: null,
    error: null,
    startedAt: Date.now(),
    steps: {},
    diff: null,
    preservedReason: null,
  };

  const updated: PipelineNoteState = {
    ...existing,
    currentStep: step,
    currentStatus: status,
    subStage: subStage ?? null,
    error: error ?? null,
    steps: { ...existing.steps, [step]: status },
    diff: diff ?? existing.diff,
    preservedReason: preserved ? (reason ?? "unknown") : existing.preservedReason,
  };

  usePostCallPipelineStore.setState({
    activePipelines: { ...activePipelines, [noteId]: updated },
  });
}

export function selectActivePipelineCount(state: PostCallPipelineStoreState): number {
  return Object.keys(state.activePipelines).length;
}

export function selectPipelineForNote(
  state: PostCallPipelineStoreState,
  noteId: number | null
): PipelineNoteState | null {
  if (noteId == null) return null;
  return state.activePipelines[noteId] ?? null;
}

export function selectAnyActivePipeline(
  state: PostCallPipelineStoreState
): PipelineNoteState | null {
  const entries = Object.values(state.activePipelines);
  return entries.find((p) => p.currentStatus === "running") ?? entries[0] ?? null;
}
