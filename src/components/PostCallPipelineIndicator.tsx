import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, AlertCircle } from "lucide-react";
import {
  usePostCallPipelineStore,
  selectAnyActivePipeline,
  selectActivePipelineCount,
  type PipelineStep,
} from "../stores/postCallPipelineStore";

const STEP_LABELS: Record<PipelineStep, string> = {
  retranscribe: "pipeline.steps.retranscribe",
  title: "pipeline.steps.title",
  classify: "pipeline.steps.classify",
  notes: "pipeline.steps.notes",
  pipeline: "pipeline.steps.pipeline",
};

const SUBSTAGE_LABELS: Record<string, string> = {
  converting: "pipeline.substages.converting",
  transcribing: "pipeline.substages.transcribing",
  diarizing: "pipeline.substages.diarizing",
};

export default function PostCallPipelineIndicator({
  onNavigateToNote,
}: {
  onNavigateToNote?: (noteId: number) => void;
}) {
  const { t } = useTranslation();
  const pipeline = usePostCallPipelineStore(selectAnyActivePipeline);
  const count = usePostCallPipelineStore(selectActivePipelineCount);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!pipeline) return;
    const interval = setInterval(() => setTick((prev) => prev + 1), 1000);
    return () => clearInterval(interval);
  }, [pipeline?.noteId]);

  if (!pipeline) return null;

  const isError = pipeline.currentStatus === "error";
  const elapsed = Math.round((Date.now() - pipeline.startedAt) / 1000);

  const stepLabel = t(STEP_LABELS[pipeline.currentStep]);
  const subStageLabel = pipeline.subStage ? t(SUBSTAGE_LABELS[pipeline.subStage]) : null;
  const displayLabel = subStageLabel || stepLabel;

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-t border-border text-xs cursor-pointer hover:bg-muted/80 transition-colors"
      onClick={() => onNavigateToNote?.(pipeline.noteId)}
      role="button"
      tabIndex={0}
    >
      {isError ? (
        <AlertCircle size={14} className="text-destructive shrink-0" />
      ) : (
        <Loader2 size={14} className="animate-spin text-primary shrink-0" />
      )}
      <span className="truncate">
        {isError
          ? t("pipeline.error", { step: stepLabel })
          : t("pipeline.processing", { step: displayLabel })}
      </span>
      {!isError && (
        <span className="text-muted-foreground tabular-nums">{elapsed}s</span>
      )}
      {count > 1 && (
        <span className="text-muted-foreground">
          +{count - 1} {t("pipeline.queued")}
        </span>
      )}
    </div>
  );
}
