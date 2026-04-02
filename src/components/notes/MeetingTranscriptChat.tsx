import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import type { TranscriptSegment } from "../../hooks/useMeetingTranscription";

const BUBBLE_STYLES = {
  mic: {
    align: "justify-start",
    radius: "rounded-bl-sm",
    bg: "bg-primary/60 text-primary-foreground/80",
    cursor: "bg-primary-foreground/60",
  },
  system: {
    align: "justify-end",
    radius: "rounded-br-sm",
    bg: "bg-surface-2/70 border border-border/20 text-foreground/80",
    cursor: "bg-foreground/40",
  },
} as const;

function PartialBubble({ text, source }: { text: string; source: "mic" | "system" }) {
  const s = BUBBLE_STYLES[source];
  return (
    <div
      className={cn("flex", s.align)}
      style={{ animation: "agent-message-in 150ms ease-out both" }}
    >
      <div
        className={cn(
          "max-w-[80%] px-3 py-1.5 rounded-lg",
          s.radius,
          s.bg,
          "text-[13px] leading-relaxed italic"
        )}
      >
        {text}
        <span
          className={cn("inline-block w-[2px] h-[13px] align-middle ml-0.5", s.cursor)}
          style={{ animation: "agent-cursor-blink 800ms steps(1) infinite" }}
        />
      </div>
    </div>
  );
}

interface MeetingTranscriptChatProps {
  segments: TranscriptSegment[];
  micPartial?: string;
  systemPartial?: string;
}

export function MeetingTranscriptChat({
  segments,
  micPartial,
  systemPartial,
}: MeetingTranscriptChatProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Auto-scroll only when near the bottom (within 80px)
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [segments, micPartial, systemPartial]);

  const hasContent = segments.length > 0 || micPartial || systemPartial;

  if (!hasContent) {
    return (
      <div className="h-full flex items-center justify-center px-5">
        <p className="text-xs text-muted-foreground/40 select-none">
          {t("notes.editor.conversationWillAppear")}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto px-4 pt-3 pb-24 flex flex-col gap-1.5 agent-chat-scroll"
    >
      {segments.map((segment, i) => {
        const isMic = segment.source === "mic";
        const prevSegment = i > 0 ? segments[i - 1] : null;
        const sameSpeaker = prevSegment?.source === segment.source;

        return (
          <div
            key={segment.id}
            className={cn(
              "flex",
              isMic ? "justify-start" : "justify-end",
              !sameSpeaker && i > 0 && "mt-2"
            )}
            style={{ animation: "agent-message-in 200ms ease-out both" }}
          >
            <div
              className={cn(
                "max-w-[80%] px-3 py-1.5",
                "text-[13px] leading-relaxed",
                isMic
                  ? cn(
                      "bg-primary/90 text-primary-foreground",
                      sameSpeaker ? "rounded-lg rounded-tl-sm" : "rounded-lg rounded-bl-sm"
                    )
                  : cn(
                      "bg-surface-2 border border-border/30 text-foreground",
                      sameSpeaker ? "rounded-lg rounded-tr-sm" : "rounded-lg rounded-br-sm"
                    )
              )}
            >
              {segment.text}
            </div>
          </div>
        );
      })}

      {[
        { text: micPartial, source: "mic" as const },
        { text: systemPartial, source: "system" as const },
      ].map(
        ({ text, source }) => text && <PartialBubble key={source} text={text} source={source} />
      )}
    </div>
  );
}
