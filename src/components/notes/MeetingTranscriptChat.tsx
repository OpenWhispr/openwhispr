import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Sparkles, Users, X } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { cn } from "../lib/utils";
import { MAX_SPEAKER_COUNT } from "../../constants/speakerDetection.json";
import type { TranscriptSegment } from "../../stores/meetingRecordingStore";
import {
  isTranscriptSpeakerLocked,
  type TranscriptSpeakerStatus,
} from "../../utils/transcriptSpeakerState";

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

const SPEAKER_COLORS = [
  "text-blue-400",
  "text-green-400",
  "text-purple-400",
  "text-orange-400",
  "text-pink-400",
  "text-cyan-400",
  "text-yellow-400",
  "text-red-400",
];

const SPEAKER_BORDER_COLORS = [
  "border-l-blue-400/50",
  "border-l-green-400/50",
  "border-l-purple-400/50",
  "border-l-orange-400/50",
  "border-l-pink-400/50",
  "border-l-cyan-400/50",
  "border-l-yellow-400/50",
  "border-l-red-400/50",
];

const STICKY_SCROLL_THRESHOLD_PX = 80;

const getSpeakerKey = (segment: TranscriptSegment) => segment.speaker || segment.source;

const getEffectiveSpeakerKey = (
  segment: TranscriptSegment,
  speakerMappings?: Record<string, string>
): string => {
  const mapped = segment.speaker ? speakerMappings?.[segment.speaker] : undefined;
  if (mapped) return `name:${mapped.toLowerCase()}`;
  if (segment.speakerName) return `name:${segment.speakerName.toLowerCase()}`;
  if (segment.speaker) return `id:${segment.speaker}`;
  return `src:${segment.source}`;
};

const getSpeakerNumber = (speakerId: string) => {
  const match = speakerId.match(/speaker_(\d+)/);
  return match ? Number(match[1]) + 1 : 1;
};

const getSpeakerStateLabel = (state: TranscriptSpeakerStatus, t: (key: string) => string) => {
  switch (state) {
    case "locked":
      return t("notes.speaker.state.locked");
    case "provisional":
      return t("notes.speaker.state.provisional");
    case "suggested":
      return t("notes.speaker.state.suggested");
    case "confirmed":
    default:
      return t("notes.speaker.state.confirmed");
  }
};

function PartialBubble({
  text,
  source,
  speakerLabel,
  speakerState,
  t,
}: {
  text: string;
  source: "mic" | "system";
  speakerLabel?: string;
  speakerState?: TranscriptSpeakerStatus;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const s = BUBBLE_STYLES[source];
  return (
    <div
      className={cn("flex", s.align)}
      style={{ animation: "agent-message-in 150ms ease-out both" }}
    >
      <div className="max-w-[80%] flex flex-col">
        {speakerLabel && (
          <div className="mb-0.5 flex items-center gap-1 px-1">
            <span className="text-[11px] font-medium text-muted-foreground/70">{speakerLabel}</span>
            {speakerState === "provisional" && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground/40">
                <Sparkles size={9} />
                {getSpeakerStateLabel("provisional", t)}
              </span>
            )}
          </div>
        )}
        <div
          className={cn(
            "px-3 py-1.5 rounded-lg",
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
    </div>
  );
}

const isLikelyEmail = (value: string) => /.+@.+\..+/.test(value.trim());

const nameFromEmail = (email: string) => email.split("@")[0] || email;

interface SpeakerProfileLite {
  id?: number;
  display_name: string;
  email: string | null;
}

interface SpeakerPickerProps {
  speakerProfiles?: SpeakerProfileLite[];
  participants?: Array<{ email: string; displayName: string | null }>;
  onSelectName: (name: string, email?: string | null, profileId?: number) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function AddContactButton({
  profile,
  onAttachEmail,
  t,
}: {
  profile: { id: number; display_name: string };
  onAttachEmail: (profileId: number, email: string | null) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const canSave = isLikelyEmail(draft);

  const submit = () => {
    if (!canSave) return;
    onAttachEmail(profile.id, draft.trim().toLowerCase());
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setDraft("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center mb-0.5 px-1.5 py-0.5 rounded-md text-[11px] outline-none cursor-pointer",
            "border border-dashed border-border/60 dark:border-white/15",
            "text-foreground/50 hover:text-foreground hover:border-border/90 dark:hover:border-white/30",
            "transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-ring"
          )}
        >
          {t("notes.speaker.addContact")}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3">
        <div className="text-xs font-medium text-foreground truncate mb-2">
          {profile.display_name}
        </div>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={t("notes.speaker.emailPlaceholder")}
          className={cn(
            "w-full px-2 py-1.5 rounded-md bg-transparent text-xs text-foreground",
            "placeholder:text-foreground/25 outline-none",
            "border border-border/50 focus:border-border/90 transition-colors"
          )}
          autoFocus
          type="email"
        />
        <div className="flex justify-end gap-1 mt-2">
          <button
            onClick={() => setOpen(false)}
            className="px-2 py-1 rounded text-[11px] text-foreground/50 hover:text-foreground hover:bg-foreground/5 transition-colors cursor-pointer"
          >
            {t("notes.speaker.cancel")}
          </button>
          <button
            onClick={submit}
            disabled={!canSave}
            className={cn(
              "px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer",
              "bg-primary text-primary-foreground hover:bg-primary/90",
              "disabled:bg-primary/20 disabled:text-primary-foreground/40 disabled:pointer-events-none"
            )}
          >
            {t("notes.speaker.save")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SpeakerPicker({ speakerProfiles, participants, onSelectName, t }: SpeakerPickerProps) {
  const [search, setSearch] = useState("");
  const lower = search.toLowerCase();
  const trimmed = search.trim();
  const trimmedLower = trimmed.toLowerCase();

  const filteredParticipants = (participants || []).filter(
    (p) =>
      !search ||
      (p.displayName || "").toLowerCase().includes(lower) ||
      p.email.toLowerCase().includes(lower)
  );
  const filteredProfiles = (speakerProfiles || []).filter(
    (p) =>
      !search ||
      p.display_name.toLowerCase().includes(lower) ||
      (p.email && p.email.toLowerCase().includes(lower))
  );

  const hasExactMatch =
    filteredParticipants.some(
      (p) =>
        (p.displayName || "").toLowerCase() === trimmedLower ||
        p.email.toLowerCase() === trimmedLower
    ) ||
    filteredProfiles.some(
      (p) =>
        p.display_name.toLowerCase() === trimmedLower ||
        (p.email && p.email.toLowerCase() === trimmedLower)
    );
  const canCreate = !!trimmed && !hasExactMatch;
  const inputIsEmail = isLikelyEmail(trimmed);

  const submitCreate = () => {
    if (!canCreate) return;
    if (inputIsEmail) {
      const email = trimmed.toLowerCase();
      onSelectName(nameFromEmail(email), email);
    } else {
      onSelectName(trimmed, null);
    }
    setSearch("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canCreate) {
      e.preventDefault();
      submitCreate();
    }
  };

  const isEmpty = !filteredParticipants.length && !filteredProfiles.length && !canCreate;

  return (
    <>
      <div className="p-2 border-b border-border/50">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("notes.speaker.nameOrEmailPlaceholder")}
          className="w-full px-2 py-1.5 rounded-md bg-transparent text-xs text-foreground placeholder:text-foreground/20 outline-none border-none appearance-none"
          autoFocus
        />
      </div>
      <div className="max-h-52 overflow-y-auto">
        {filteredParticipants.length > 0 && (
          <div className="p-1 border-b border-border/30">
            <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {t("notes.speaker.meetingAttendees")}
            </div>
            {filteredParticipants.slice(0, 5).map((p) => (
              <button
                key={p.email}
                onClick={() => onSelectName(p.displayName || p.email.split("@")[0], p.email)}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-foreground/70 hover:bg-foreground/5 transition-colors cursor-pointer"
              >
                <span className="truncate flex-1 text-left">{p.displayName || p.email}</span>
                {p.displayName && (
                  <span className="text-foreground/30 truncate text-[11px]">{p.email}</span>
                )}
              </button>
            ))}
          </div>
        )}
        {filteredProfiles.length > 0 && (
          <div className="p-1 border-b border-border/30">
            <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {t("notes.speaker.knownSpeakers")}
            </div>
            {filteredProfiles.slice(0, 5).map((p) => (
              <button
                key={p.id ?? `name-${p.display_name}`}
                onClick={() => onSelectName(p.display_name, p.email, p.id)}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-foreground/70 hover:bg-foreground/5 transition-colors cursor-pointer"
              >
                <span className="truncate flex-1 text-left">{p.display_name}</span>
                {p.email && (
                  <span className="text-foreground/30 truncate text-[11px]">{p.email}</span>
                )}
              </button>
            ))}
          </div>
        )}
        {canCreate && (
          <div className="p-1">
            <button
              onClick={submitCreate}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-foreground/70 hover:bg-foreground/5 transition-colors cursor-pointer"
            >
              <span className="text-foreground/50 shrink-0">
                {t("notes.speaker.createNewPrefix")}
              </span>
              {inputIsEmail ? (
                <>
                  <span className="text-foreground truncate">{nameFromEmail(trimmed)}</span>
                  <span className="text-foreground/30 truncate text-[11px]">
                    {trimmed.toLowerCase()}
                  </span>
                </>
              ) : (
                <span className="text-foreground truncate">{trimmed}</span>
              )}
            </button>
          </div>
        )}
        {isEmpty && (
          <div className="px-3 py-4 text-center text-[11px] text-foreground/30">
            {t("notes.speaker.nameOrEmailPlaceholder")}
          </div>
        )}
      </div>
    </>
  );
}

function SpeakerLabel({
  speakerId,
  segment,
  mappedName,
  speakerProfiles,
  participants,
  colorIdx,
  isOriginallyYou,
  onMap,
  onConfirm,
  onDismiss,
  t,
}: {
  speakerId: string;
  segment: TranscriptSegment;
  mappedName?: string;
  speakerProfiles?: SpeakerProfileLite[];
  participants?: Array<{ email: string; displayName: string | null }>;
  colorIdx: number;
  isOriginallyYou: boolean;
  onMap?: (speakerId: string, name: string, email?: string | null, profileId?: number) => void;
  onConfirm?: (speakerId: string, name: string, profileId: number) => void;
  onDismiss?: (speakerId: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [open, setOpen] = useState(false);
  const speakerState =
    segment.speakerLocked || isTranscriptSpeakerLocked(segment)
      ? "locked"
      : segment.speakerStatus ||
        (segment.suggestedName && !mappedName
          ? "suggested"
          : segment.speakerName || mappedName
            ? "confirmed"
            : segment.speakerIsPlaceholder
              ? "provisional"
              : undefined);

  const hasSuggestion = !!segment.suggestedName && !mappedName;

  if (hasSuggestion) {
    return (
      <span className="group inline-flex items-center gap-1 mb-0.5 px-1">
        <span className="text-[11px] font-medium italic text-muted-foreground/60">
          {segment.suggestedName}
        </span>
        <button
          onClick={() =>
            onConfirm?.(speakerId, segment.suggestedName!, segment.suggestedProfileId!)
          }
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded transition-opacity cursor-pointer text-muted-foreground hover:text-emerald-500"
        >
          <Check size={12} />
        </button>
        <button
          onClick={() => onDismiss?.(speakerId)}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded transition-opacity cursor-pointer text-muted-foreground hover:text-destructive"
        >
          <X size={12} />
        </button>
      </span>
    );
  }

  const displayLabel =
    mappedName ||
    segment.speakerName ||
    (isOriginallyYou
      ? t("notes.speaker.you")
      : t("notes.speaker.label", { n: getSpeakerNumber(speakerId) }));
  const isUnmapped = !mappedName && !segment.speakerName;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center text-[11px] font-medium mb-0.5 px-1.5 py-0.5 rounded-md outline-none cursor-pointer",
            "border border-border/60 dark:border-white/20",
            "hover:bg-foreground/5 hover:border-border/90 dark:hover:border-white/30",
            "transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-ring",
            SPEAKER_COLORS[colorIdx],
            isUnmapped && "border-dashed",
            speakerState === "provisional" && "italic"
          )}
        >
          {displayLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <SpeakerPicker
          speakerProfiles={speakerProfiles}
          participants={participants}
          onSelectName={(name, email, profileId) => {
            onMap?.(speakerId, name, email, profileId);
            setOpen(false);
          }}
          t={t}
        />
      </PopoverContent>
    </Popover>
  );
}

function SelectCheckbox({
  isSelected,
  onToggle,
  className,
}: {
  isSelected: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={isSelected}
      className={cn(
        "w-4 h-4 rounded-full border flex items-center justify-center transition-all cursor-pointer",
        isSelected
          ? "border-primary bg-primary text-primary-foreground opacity-100"
          : "border-border/60 bg-background/80 opacity-0 group-hover:opacity-100 hover:border-foreground/50",
        className
      )}
    >
      {isSelected && <Check size={10} strokeWidth={3} />}
    </button>
  );
}

export function SelectionBar({
  count,
  onClear,
  speakerProfiles,
  participants,
  onAssignName,
  t,
}: {
  count: number;
  onClear: () => void;
  speakerProfiles?: SpeakerProfileLite[];
  participants?: Array<{ email: string; displayName: string | null }>;
  onAssignName: (name: string, email?: string | null, profileId?: number) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="flex items-center gap-3 rounded-md border border-border/40 bg-surface-2/95 backdrop-blur px-3 py-1.5 text-xs shadow-lg"
      style={{ animation: "agent-message-in 150ms ease-out both" }}
    >
      <span className="text-foreground/70 tabular-nums">
        {t("notes.speaker.selected", { n: count })}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1 px-2 py-1 rounded text-foreground hover:bg-foreground/10 transition-colors cursor-pointer">
            <Users size={12} />
            {t("notes.speaker.assignTo")}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0">
          <SpeakerPicker
            speakerProfiles={speakerProfiles}
            participants={participants}
            onSelectName={(name, email, profileId) => {
              onAssignName(name, email, profileId);
              setOpen(false);
            }}
            t={t}
          />
        </PopoverContent>
      </Popover>
      <button
        onClick={onClear}
        className="px-2 py-1 rounded text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors cursor-pointer"
      >
        {t("notes.speaker.deselectAll")}
      </button>
    </div>
  );
}

interface MeetingTranscriptChatProps {
  segments: TranscriptSegment[];
  micPartial?: string;
  systemPartial?: string;
  systemPartialSpeakerId?: string | null;
  systemPartialSpeakerName?: string | null;
  speakerMappings?: Record<string, string>;
  speakerProfiles?: SpeakerProfileLite[];
  participants?: Array<{ email: string; displayName: string | null }>;
  selectedSegmentIds?: Set<string>;
  isRecording?: boolean;
  isDiarizing?: boolean;
  sessionDiarizationEnabled?: boolean;
  sessionExpectedCount?: number;
  userTouchedStepper?: boolean;
  onSetSessionDiarizationEnabled?: (enabled: boolean) => void;
  onSetSessionExpectedCount?: (count: number) => void;
  onMapSpeaker?: (
    speakerId: string,
    displayName: string,
    email?: string | null,
    profileId?: number
  ) => void;
  onConfirmSuggestion?: (speakerId: string, suggestedName: string, profileId: number) => void;
  onDismissSuggestion?: (speakerId: string) => void;
  onAttachSpeakerEmail?: (profileId: number, email: string | null) => void;
  onToggleSelect?: (segmentId: string) => void;
}

export function MeetingTranscriptChat({
  segments,
  micPartial,
  systemPartial,
  systemPartialSpeakerId,
  systemPartialSpeakerName,
  speakerMappings,
  speakerProfiles,
  participants,
  selectedSegmentIds,
  isRecording,
  isDiarizing,
  sessionDiarizationEnabled = true,
  sessionExpectedCount = 2,
  userTouchedStepper = false,
  onSetSessionDiarizationEnabled,
  onSetSessionExpectedCount,
  onMapSpeaker,
  onConfirmSuggestion,
  onDismissSuggestion,
  onAttachSpeakerEmail,
  onToggleSelect,
}: MeetingTranscriptChatProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const [hintDismissed, setHintDismissed] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const updateStickyScroll = () => {
      shouldStickToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_SCROLL_THRESHOLD_PX;
    };

    updateStickyScroll();
    el.addEventListener("scroll", updateStickyScroll);
    return () => el.removeEventListener("scroll", updateStickyScroll);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !shouldStickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [segments, micPartial, systemPartial]);

  const hasContent = segments.length > 0 || micPartial || systemPartial;
  const systemPartialSpeakerLabel =
    systemPartialSpeakerName ||
    (systemPartialSpeakerId
      ? t("notes.speaker.label", { n: getSpeakerNumber(systemPartialSpeakerId) })
      : undefined);
  const systemPartialSpeakerState = systemPartialSpeakerId
    ? systemPartialSpeakerName
      ? "confirmed"
      : "provisional"
    : undefined;

  const colorByKey = useMemo(() => {
    const map = new Map<string, number>();
    let nextIdx = 0;
    for (const segment of segments) {
      if (segment.source === "mic" && !segment.speaker) continue;
      if (segment.speaker === "you") continue;
      const key = getEffectiveSpeakerKey(segment, speakerMappings);
      if (!map.has(key)) {
        map.set(key, nextIdx % SPEAKER_COLORS.length);
        nextIdx += 1;
      }
    }
    return map;
  }, [segments, speakerMappings]);

  if (!hasContent) {
    return (
      <div className="h-full flex items-center justify-center px-5">
        <p className="text-xs text-muted-foreground/40 select-none">
          {t("notes.editor.conversationWillAppear")}
        </p>
      </div>
    );
  }

  const isSelfSide = (segment: TranscriptSegment): boolean => {
    const mapped = segment.speaker ? speakerMappings?.[segment.speaker] : undefined;
    if (mapped) return mapped.trim().toLowerCase() === t("notes.speaker.you").toLowerCase();
    if (segment.speaker === "you") return true;
    if (segment.speakerName) return false;
    return segment.source === "mic";
  };

  const others = Math.max(0, sessionExpectedCount - 1);

  return (
    <div className="h-full relative">
      {(isRecording || isDiarizing) && !hintDismissed && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-2.5 py-1 rounded-md border border-border bg-background/95 backdrop-blur shadow-sm text-xs text-foreground">
          {isDiarizing ? (
            <Loader2 size={12} className="animate-spin text-muted-foreground" />
          ) : (
            <Sparkles
              size={12}
              className={cn(sessionDiarizationEnabled ? "text-primary" : "text-muted-foreground")}
            />
          )}
          <span>
            {isDiarizing
              ? t("notes.speaker.pill.finalizing")
              : sessionDiarizationEnabled
                ? others === 1 && !(participants && participants.length > 0) && !userTouchedStepper
                  ? t("notes.speaker.pill.defaultingHint")
                  : t("notes.speaker.pill.identifying")
                : t("notes.speaker.pill.notLabeled")}
          </span>
          {!isDiarizing && sessionDiarizationEnabled && (
            <>
              <span className="text-muted-foreground">
                {others === 0
                  ? t("notes.speaker.pill.justYou")
                  : t("notes.speaker.pill.othersInCall", { count: others })}
              </span>
              <div className="flex items-center gap-0.5 rounded-md border border-border bg-surface-2/60">
                <button
                  onClick={() => onSetSessionExpectedCount?.(sessionExpectedCount - 1)}
                  disabled={others <= 0}
                  className="px-1.5 py-0.5 rounded-l-md hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-30 disabled:pointer-events-none transition-colors"
                  aria-label={t("notes.speaker.pill.decAria")}
                >
                  −
                </button>
                <span className="px-1.5 tabular-nums" aria-live="polite">
                  {others}
                </span>
                <button
                  onClick={() => onSetSessionExpectedCount?.(sessionExpectedCount + 1)}
                  disabled={others >= MAX_SPEAKER_COUNT - 1}
                  className="px-1.5 py-0.5 rounded-r-md hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-30 disabled:pointer-events-none transition-colors"
                  aria-label={t("notes.speaker.pill.incAria")}
                >
                  +
                </button>
              </div>
            </>
          )}
          {!isDiarizing && (
            <div className="scale-75">
              <Toggle
                checked={sessionDiarizationEnabled}
                onChange={(next) => onSetSessionDiarizationEnabled?.(next)}
              />
            </div>
          )}
          <button
            onClick={() => setHintDismissed(true)}
            className="text-foreground/40 hover:text-foreground/70 transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto px-4 pt-3 pb-24 flex flex-col gap-1.5 agent-chat-scroll"
      >
        {segments.map((segment, i) => {
          const selfSide = isSelfSide(segment);
          const prevSegment = i > 0 ? segments[i - 1] : null;
          const sameSpeaker = prevSegment
            ? getSpeakerKey(prevSegment) === getSpeakerKey(segment)
            : false;

          const hasSpeaker = !!segment.speaker;
          const isOriginallyYou = segment.speaker === "you";
          const isSystemSpeaker = hasSpeaker && !selfSide;
          const effectiveKey = getEffectiveSpeakerKey(segment, speakerMappings);
          const colorIdx = isSystemSpeaker ? (colorByKey.get(effectiveKey) ?? 0) : 0;
          const isSelected = selectedSegmentIds?.has(segment.id) ?? false;
          const selectable = !!onToggleSelect;

          const activeName = speakerMappings?.[segment.speaker!] || segment.speakerName;
          const matchedProfile =
            activeName && speakerProfiles
              ? speakerProfiles.find((p) => p.id != null && p.display_name === activeName)
              : undefined;
          const canAddContact =
            !!matchedProfile &&
            matchedProfile.id != null &&
            !matchedProfile.email &&
            !!onAttachSpeakerEmail;

          const labelElement = hasSpeaker && (
            <div className="flex items-center gap-1">
              <SpeakerLabel
                speakerId={segment.speaker!}
                segment={segment}
                mappedName={speakerMappings?.[segment.speaker!]}
                speakerProfiles={speakerProfiles}
                participants={participants}
                colorIdx={colorIdx}
                isOriginallyYou={isOriginallyYou}
                onMap={onMapSpeaker}
                onConfirm={onConfirmSuggestion}
                onDismiss={onDismissSuggestion}
                t={t}
              />
              {canAddContact && matchedProfile && matchedProfile.id != null && (
                <AddContactButton
                  profile={{ id: matchedProfile.id, display_name: matchedProfile.display_name }}
                  onAttachEmail={onAttachSpeakerEmail!}
                  t={t}
                />
              )}
            </div>
          );

          return (
            <div
              key={segment.id}
              className={cn(
                "group flex flex-col",
                selfSide ? "items-start" : "items-end",
                !sameSpeaker && i > 0 && "mt-2",
                selectable && (selfSide ? "pl-6" : "pr-6")
              )}
              style={{ animation: "agent-message-in 200ms ease-out both" }}
            >
              {labelElement && !sameSpeaker && labelElement}
              {labelElement && sameSpeaker && (
                <div
                  className={cn(
                    "grid grid-rows-[0fr] opacity-0 pointer-events-none transition-[grid-template-rows,opacity] duration-150 ease-out",
                    "group-hover:grid-rows-[1fr] group-hover:opacity-100 group-hover:pointer-events-auto"
                  )}
                >
                  <div className="overflow-hidden">{labelElement}</div>
                </div>
              )}
              <div className="relative max-w-[80%]">
                <div
                  className={cn(
                    "px-3 py-1.5 cursor-default transition-colors",
                    "text-[13px] leading-relaxed",
                    selfSide
                      ? cn(
                          "bg-primary/90 text-primary-foreground",
                          sameSpeaker ? "rounded-lg rounded-tl-sm" : "rounded-lg rounded-bl-sm"
                        )
                      : cn(
                          "bg-surface-2 border border-border/30 text-foreground",
                          sameSpeaker ? "rounded-lg rounded-tr-sm" : "rounded-lg rounded-br-sm",
                          isSystemSpeaker && cn("border-l-2", SPEAKER_BORDER_COLORS[colorIdx])
                        ),
                    isSelected && "ring-2 ring-primary/60"
                  )}
                >
                  {segment.text}
                </div>
                {selectable && (
                  <SelectCheckbox
                    isSelected={isSelected}
                    onToggle={() => onToggleSelect?.(segment.id)}
                    className={cn("absolute top-1.5", selfSide ? "-left-6" : "-right-6")}
                  />
                )}
              </div>
            </div>
          );
        })}

        {[
          { text: micPartial, source: "mic" as const, speakerLabel: undefined },
          {
            text: systemPartial,
            source: "system" as const,
            speakerLabel: systemPartialSpeakerLabel,
          },
        ].map(
          ({ text, source, speakerLabel }) =>
            text && (
              <PartialBubble
                key={source}
                text={text}
                source={source}
                speakerLabel={speakerLabel}
                speakerState={source === "system" ? systemPartialSpeakerState : undefined}
                t={t}
              />
            )
        )}
      </div>
    </div>
  );
}
