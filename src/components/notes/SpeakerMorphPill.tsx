import React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Users, ChevronDown, ChevronUp } from "lucide-react";
import {
  usePostCallPipelineStore,
  selectPipelineForNote,
} from "../../stores/postCallPipelineStore";

interface SpeakerMorphPillProps {
  noteId: number;
  isDiarizing: boolean;
  speakerCount: number;
  showPanel: boolean;
  onTogglePanel: () => void;
}

export default function SpeakerMorphPill({
  noteId,
  isDiarizing,
  speakerCount,
  showPanel,
  onTogglePanel,
}: SpeakerMorphPillProps) {
  const { t } = useTranslation();
  const pipeline = usePostCallPipelineStore((s) =>
    selectPipelineForNote(s, noteId)
  );
  const isPipelineActive =
    pipeline != null && pipeline.currentStatus === "running";
  const diff = pipeline?.diff;

  // State 1: Diarizing or pipeline running — show spinner
  if (isDiarizing || isPipelineActive) {
    const label = isDiarizing
      ? t("speakers.pill.finalizing")
      : pipeline?.subStage
        ? t(`pipeline.substages.${pipeline.subStage}`)
        : t(`pipeline.steps.${pipeline?.currentStep}`);

    return (
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted text-xs text-muted-foreground animate-in fade-in">
        <Loader2 size={12} className="animate-spin" />
        <span>{label}</span>
      </div>
    );
  }

  // State 2: No speakers detected
  if (speakerCount === 0) return null;

  // State 3: Complete — show speaker count + toggle
  return (
    <div className="inline-flex items-center gap-1.5">
      <button
        onClick={onTogglePanel}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted hover:bg-muted/80 text-xs text-muted-foreground transition-colors"
      >
        <Users size={12} />
        <span>{t("speakers.pill.detected", { count: speakerCount })}</span>
        {showPanel ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      </button>
      {diff && diff.changedSegments > 0 && (
        <span className="text-[10px] text-muted-foreground/70">
          {t("speakers.pill.diffSummary", {
            changed: diff.changedSegments,
            total: diff.totalSegments,
          })}
        </span>
      )}
    </div>
  );
}
