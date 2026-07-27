import { create } from "zustand";

export type PipelineStep = "retranscribe" | "title" | "notes" | "pipeline";
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
}) {
  const { noteId, step, status, subStage, error, diff } = payload;
  const { activePipelines } = usePostCallPipelineStore.getState();

  if (step === "pipeline" && status === "complete") {
    const next = { ...activePipelines };
    delete next[noteId];
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
  };

  const updated: PipelineNoteState = {
    ...existing,
    currentStep: step,
    currentStatus: status,
    subStage: subStage ?? null,
    error: error ?? null,
    steps: { ...existing.steps, [step]: status },
    diff: diff ?? existing.diff,
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
