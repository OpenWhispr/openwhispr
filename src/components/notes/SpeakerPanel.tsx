import React, { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Users, Merge, X } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface Speaker {
  id: string;
  name: string;
  isPlaceholder: boolean;
  segmentCount: number;
  talkTimePercent: number;
}

interface SpeakerPanelProps {
  noteId: number;
  segments: Array<{
    id?: string;
    text: string;
    speaker?: string;
    speakerName?: string;
    speakerIsPlaceholder?: boolean;
    timestamp?: number;
    end?: number;
  }>;
  onFilterSpeaker: (speakerId: string | null) => void;
  activeSpeakerFilter: string | null;
}

const SPEAKER_COLORS = [
  "bg-blue-500", "bg-emerald-500", "bg-amber-500", "bg-purple-500",
  "bg-rose-500", "bg-cyan-500", "bg-orange-500", "bg-teal-500",
  "bg-pink-500", "bg-indigo-500", "bg-lime-500", "bg-red-500",
  "bg-sky-500", "bg-violet-500", "bg-fuchsia-500",
];

export default function SpeakerPanel({
  noteId,
  segments,
  onFilterSpeaker,
  activeSpeakerFilter,
}: SpeakerPanelProps) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [selectedForMerge, setSelectedForMerge] = useState<string[]>([]);

  const speakers = useMemo(() => {
    const map = new Map<string, Speaker>();
    let totalDuration = 0;

    for (const seg of segments) {
      if (!seg.speaker) continue;
      const duration =
        seg.end != null && seg.timestamp != null
          ? (seg.end - seg.timestamp) / 1000
          : 1;
      totalDuration += duration;

      const existing = map.get(seg.speaker);
      if (existing) {
        existing.segmentCount++;
        existing.talkTimePercent += duration;
        if (seg.speakerName && !seg.speakerIsPlaceholder) {
          existing.name = seg.speakerName;
          existing.isPlaceholder = false;
        }
      } else {
        map.set(seg.speaker, {
          id: seg.speaker,
          name: seg.speakerName || seg.speaker,
          isPlaceholder: seg.speakerIsPlaceholder !== false,
          segmentCount: 1,
          talkTimePercent: duration,
        });
      }
    }

    for (const s of map.values()) {
      s.talkTimePercent =
        totalDuration > 0 ? Math.round((s.talkTimePercent / totalDuration) * 100) : 0;
    }

    return Array.from(map.values()).sort((a, b) => b.talkTimePercent - a.talkTimePercent);
  }, [segments]);

  const handleStartEdit = (speaker: Speaker) => {
    setEditingId(speaker.id);
    setEditValue(speaker.name);
  };

  const handleCommitEdit = () => {
    if (editingId && editValue.trim()) {
      (window as any).electronAPI?.renameSpeaker?.(noteId, editingId, editValue.trim());
    }
    setEditingId(null);
  };

  const handleToggleMergeSelect = (id: string) => {
    setSelectedForMerge((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev.slice(-1), id]
    );
  };

  const handleMerge = () => {
    if (selectedForMerge.length === 2) {
      (window as any).electronAPI?.mergeSpeakers?.(noteId, selectedForMerge[0], selectedForMerge[1]);
      setSelectedForMerge([]);
    }
  };

  return (
    <div className="border-t border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Users size={14} />
          <span>
            {t("speakers.panel.title", { count: speakers.length })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {selectedForMerge.length === 2 && (
            <Button variant="outline" size="sm" onClick={handleMerge} className="h-6 text-xs">
              <Merge size={12} className="mr-1" />
              {t("speakers.panel.merge")}
            </Button>
          )}
          {activeSpeakerFilter && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onFilterSpeaker(null)}
              className="h-6 text-xs"
            >
              <X size={12} className="mr-1" />
              {t("speakers.panel.clearFilter")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
        {speakers.map((speaker, idx) => {
          const isFiltered = activeSpeakerFilter === speaker.id;
          const isMergeSelected = selectedForMerge.includes(speaker.id);
          const colorClass = SPEAKER_COLORS[idx % SPEAKER_COLORS.length];

          return (
            <div
              key={speaker.id}
              className={`flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors
                ${isFiltered ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/30"}
                ${isMergeSelected ? "ring-2 ring-primary" : ""}`}
              onClick={() => onFilterSpeaker(isFiltered ? null : speaker.id)}
            >
              <div className={`w-6 h-6 rounded-full ${colorClass} shrink-0 flex items-center justify-center text-white text-xs font-bold`}>
                {speaker.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                {editingId === speaker.id ? (
                  <Input
                    value={editValue}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditValue(e.target.value)}
                    onBlur={handleCommitEdit}
                    onKeyDown={(e: React.KeyboardEvent) => e.key === "Enter" && handleCommitEdit()}
                    className="h-5 text-xs p-1"
                    autoFocus
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="text-xs font-medium truncate block"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      handleStartEdit(speaker);
                    }}
                  >
                    {speaker.name}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {speaker.segmentCount} {t("speakers.panel.segments")} &middot; {speaker.talkTimePercent}%
                </span>
              </div>
              <input
                type="checkbox"
                className="shrink-0"
                checked={isMergeSelected}
                onChange={(e) => {
                  e.stopPropagation();
                  handleToggleMergeSelect(speaker.id);
                }}
                title={t("speakers.panel.selectForMerge")}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
