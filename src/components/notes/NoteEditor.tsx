import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Download, Loader2, FileText, Sparkles, AlignLeft } from "lucide-react";
import { MarkdownTextarea } from "../ui/MarkdownTextarea";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import type { NoteItem } from "../../types/electron";
import type { ActionProcessingState } from "../../hooks/useActionProcessing";
import ActionProcessingOverlay from "./ActionProcessingOverlay";
import DictationWidget from "./DictationWidget";
import { normalizeDbDate } from "../../utils/dateFormatting";

function formatNoteDate(dateStr: string): string {
  const date = normalizeDbDate(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  const datePart = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart} \u00b7 ${timePart}`;
}

export interface Enhancement {
  content: string;
  isStale: boolean;
  onChange: (content: string) => void;
}

interface NoteEditorProps {
  note: NoteItem;
  onTitleChange: (title: string) => void;
  onContentChange: (content: string) => void;
  isSaving: boolean;
  isRecording: boolean;
  partialTranscript: string;
  finalTranscript: string | null;
  onFinalTranscriptConsumed: () => void;
  streamingCommit: string | null;
  onStreamingCommitConsumed: () => void;
  isProcessing: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onExportNote?: (format: "md" | "txt") => void;
  enhancement?: Enhancement;
  actionPicker?: React.ReactNode;
  actionProcessingState?: ActionProcessingState;
  actionName?: string | null;
}

interface DictationRange {
  start: number;
  partialStart: number;
  end: number;
  committedChars: number;
}

interface TextSelectionRange {
  start: number;
  end: number;
}

interface PendingSelectionRestore extends TextSelectionRange {
  version: number;
}

function transformSelectionForReplacement(
  selection: TextSelectionRange,
  replaceStart: number,
  replaceEnd: number,
  insertLength: number
): TextSelectionRange {
  const replacementEnd = replaceStart + insertLength;

  const overlapsReplacement =
    selection.start === selection.end
      ? selection.start >= replaceStart && selection.start <= replaceEnd
      : selection.start < replaceEnd && selection.end > replaceStart;

  if (overlapsReplacement) {
    return { start: replacementEnd, end: replacementEnd };
  }

  const delta = insertLength - (replaceEnd - replaceStart);
  const shift = (index: number) => {
    if (index > replaceEnd) return index + delta;
    if (index === replaceEnd) return replacementEnd;
    return index;
  };

  return {
    start: shift(selection.start),
    end: shift(selection.end),
  };
}

function mapIndexThroughUserEdit(
  index: number,
  editStart: number,
  editEnd: number,
  insertLength: number
): number {
  const delta = insertLength - (editEnd - editStart);

  if (editStart === editEnd) {
    return index < editStart ? index : index + delta;
  }

  if (index < editStart) return index;
  if (index > editEnd) return index + delta;
  return editStart + insertLength;
}

function mapIndexAfterRangeRemoval(index: number, removeStart: number, removeEnd: number): number {
  const removedLength = removeEnd - removeStart;

  if (index < removeStart) return index;
  if (index > removeEnd) return index - removedLength;
  return removeStart;
}

export default function NoteEditor({
  note,
  onTitleChange,
  onContentChange,
  isSaving,
  isRecording,
  isProcessing,
  partialTranscript,
  finalTranscript,
  onFinalTranscriptConsumed,
  streamingCommit,
  onStreamingCommitConsumed,
  onStartRecording,
  onStopRecording,
  onExportNote,
  enhancement,
  actionPicker,
  actionProcessingState,
  actionName,
}: NoteEditorProps) {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<"raw" | "enhanced">("raw");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const prevNoteIdRef = useRef<number>(note.id);

  const cursorPosRef = useRef(0);
  const selectionEndRef = useRef(0);
  const dictationRef = useRef<DictationRange | null>(null);
  const prevRecordingRef = useRef(false);
  const expectedSelectionRef = useRef<TextSelectionRange>({ start: 0, end: 0 });
  const selectionVersionRef = useRef(0);
  const pendingSelectionRestoreRef = useRef<PendingSelectionRestore | null>(null);
  const suppressSelectionCaptureRef = useRef(false);
  const beforeInputSelectionRef = useRef<TextSelectionRange | null>(null);
  const contentRef = useRef(note.content);
  contentRef.current = note.content;

  const syncSelectionRefs = useCallback((start: number, end: number) => {
    cursorPosRef.current = start;
    selectionEndRef.current = end;
    expectedSelectionRef.current = { start, end };
  }, []);

  const queueSelectionRestore = useCallback(
    (start: number, end: number, version = selectionVersionRef.current) => {
      syncSelectionRefs(start, end);
      pendingSelectionRestoreRef.current = { start, end, version };
    },
    [syncSelectionRefs]
  );

  const applyProgrammaticSelection = useCallback(
    (start: number, end: number) => {
      const ta = textareaRef.current;
      if (!ta) return;
      suppressSelectionCaptureRef.current = true;
      ta.setSelectionRange(start, end);
      queueMicrotask(() => {
        suppressSelectionCaptureRef.current = false;
      });
      syncSelectionRefs(start, end);
    },
    [syncSelectionRefs]
  );

  const commitContentChange = useCallback(
    (newContent: string, nextSelection?: TextSelectionRange, selectionVersion?: number) => {
      if (nextSelection) {
        queueSelectionRestore(nextSelection.start, nextSelection.end, selectionVersion);
      }
      contentRef.current = newContent;
      onContentChange(newContent);
    },
    [onContentChange, queueSelectionRestore]
  );

  const replaceContentRange = useCallback(
    (replaceStart: number, replaceEnd: number, insertText: string) => {
      const currentContent = contentRef.current;
      const before = currentContent.slice(0, replaceStart);
      const after = currentContent.slice(replaceEnd);
      const newContent = before + insertText + after;
      const selectionBefore = expectedSelectionRef.current;
      const selectionVersion = selectionVersionRef.current;
      const nextSelection = transformSelectionForReplacement(
        selectionBefore,
        replaceStart,
        replaceEnd,
        insertText.length
      );

      commitContentChange(newContent, nextSelection, selectionVersion);
      return newContent;
    },
    [commitContentChange]
  );

  const reanchorDictationToSelection = useCallback(
    (anchorStart: number, anchorEnd: number, selectionVersion: number) => {
      const range = dictationRef.current;
      if (!range) return;

      if (range.partialStart === range.end) {
        range.start = anchorStart;
        range.partialStart = anchorStart;
        range.end = anchorEnd;
        return;
      }

      const currentContent = contentRef.current;
      const partialText = currentContent.slice(range.partialStart, range.end);

      if (!partialText) {
        range.start = anchorStart;
        range.partialStart = anchorStart;
        range.end = anchorEnd;
        return;
      }

      const withoutPartial =
        currentContent.slice(0, range.partialStart) + currentContent.slice(range.end);
      const targetStart = mapIndexAfterRangeRemoval(anchorStart, range.partialStart, range.end);
      const targetEnd = mapIndexAfterRangeRemoval(anchorEnd, range.partialStart, range.end);
      const newContent =
        withoutPartial.slice(0, targetStart) + partialText + withoutPartial.slice(targetEnd);

      const newPartialStart = targetStart;
      const newEnd = newPartialStart + partialText.length;

      range.start = newPartialStart;
      range.partialStart = newPartialStart;
      range.end = newEnd;

      commitContentChange(newContent, { start: newEnd, end: newEnd }, selectionVersion);
    },
    [commitContentChange]
  );

  const captureUserSelection = useCallback(
    (start: number, end: number) => {
      const prev = expectedSelectionRef.current;
      const changed = prev.start !== start || prev.end !== end;

      syncSelectionRefs(start, end);

      if (!changed) return;

      selectionVersionRef.current += 1;

      if (dictationRef.current) {
        reanchorDictationToSelection(start, end, selectionVersionRef.current);
      }
    },
    [reanchorDictationToSelection, syncSelectionRefs]
  );

  useLayoutEffect(() => {
    const pending = pendingSelectionRestoreRef.current;
    if (!pending) return;
    pendingSelectionRestoreRef.current = null;
    if (pending.version !== selectionVersionRef.current) return;
    applyProgrammaticSelection(pending.start, pending.end);
  }, [note.content, applyProgrammaticSelection]);

  // Capture selection before browser applies user edits so dictation range
  // adjustments handle replacements/paste correctly.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const handler = () => {
      if (suppressSelectionCaptureRef.current) return;
      beforeInputSelectionRef.current = {
        start: ta.selectionStart,
        end: ta.selectionEnd,
      };
    };
    ta.addEventListener("beforeinput", handler);
    return () => {
      ta.removeEventListener("beforeinput", handler);
    };
  }, [viewMode]);

  // Capture cursor on mouse interaction — click for positioning,
  // mouseup for drag-selections (click may not fire if drag distance is large)
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const handler = () => {
      if (suppressSelectionCaptureRef.current) return;
      captureUserSelection(ta.selectionStart, ta.selectionEnd);
    };
    ta.addEventListener("click", handler);
    ta.addEventListener("mouseup", handler);
    return () => {
      ta.removeEventListener("click", handler);
      ta.removeEventListener("mouseup", handler);
    };
  }, [captureUserSelection, viewMode]);

  const segmentContainerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({ opacity: 0 });

  const updateSegmentIndicator = useCallback(() => {
    const container = segmentContainerRef.current;
    if (!container) return;

    const idx = viewMode === "raw" ? 0 : 1;

    const buttons = container.querySelectorAll<HTMLButtonElement>("[data-segment-button]");
    const btn = buttons[idx];
    if (!btn) return;

    const cr = container.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    setIndicatorStyle({
      width: br.width,
      height: br.height,
      transform: `translateX(${br.left - cr.left}px)`,
      opacity: 1,
    });
  }, [viewMode]);

  useEffect(() => {
    updateSegmentIndicator();
  }, [updateSegmentIndicator]);

  useEffect(() => {
    const observer = new ResizeObserver(() => updateSegmentIndicator());
    if (segmentContainerRef.current) observer.observe(segmentContainerRef.current);
    return () => observer.disconnect();
  }, [updateSegmentIndicator]);

  const prevProcessingStateRef = useRef(actionProcessingState);
  useEffect(() => {
    if (prevProcessingStateRef.current === "processing" && actionProcessingState === "success") {
      setViewMode("enhanced");
    }
    prevProcessingStateRef.current = actionProcessingState;
  }, [actionProcessingState]);

  useEffect(() => {
    if (note.id !== prevNoteIdRef.current) {
      prevNoteIdRef.current = note.id;
      setViewMode("raw");
      if (titleRef.current && titleRef.current.textContent !== note.title) {
        titleRef.current.textContent = note.title || "";
      }
      textareaRef.current?.focus();
      if (textareaRef.current) {
        const start = textareaRef.current.selectionStart;
        const end = textareaRef.current.selectionEnd;
        syncSelectionRefs(start, end);
      }
      pendingSelectionRestoreRef.current = null;
      beforeInputSelectionRef.current = null;
    }
  }, [note.id, syncSelectionRefs]);

  useEffect(() => {
    if (titleRef.current && titleRef.current.textContent !== note.title) {
      titleRef.current.textContent = note.title || "";
    }
  }, [note.title]);

  const handleTitleInput = useCallback(() => {
    if (titleRef.current) {
      const text = titleRef.current.textContent || "";
      onTitleChange(text);
    }
  }, [onTitleChange]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      textareaRef.current?.focus();
    }
  }, []);

  const handleTitlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain").replace(/\n/g, " ");
    document.execCommand("insertText", false, text);
  }, []);

  const handleStartRecording = useCallback(() => {
    if (textareaRef.current) {
      syncSelectionRefs(textareaRef.current.selectionStart, textareaRef.current.selectionEnd);
    }
    onStartRecording();
  }, [onStartRecording, syncSelectionRefs]);

  useEffect(() => {
    if (isRecording && !prevRecordingRef.current) {
      const selStart = cursorPosRef.current;
      const selEnd = selectionEndRef.current;
      dictationRef.current = {
        start: selStart,
        partialStart: selStart,
        end: selEnd,
        committedChars: 0,
      };
      if (viewMode === "enhanced") setViewMode("raw");
    }
    if (!isRecording && prevRecordingRef.current) {
      // Only clear if no progressive text was inserted (non-streaming case).
      // For streaming, keep dictationRef alive so the final transcript replaces
      // the partial zone instead of inserting a duplicate at cursor.
      const range = dictationRef.current;
      if (range && range.partialStart === range.start && range.end === range.start) {
        dictationRef.current = null;
      }
    }
    prevRecordingRef.current = isRecording;
  }, [isRecording]);

  // Partial effect: only replace the active partial zone [partialStart, end].
  // Committed text before partialStart is untouched — users can edit it freely.
  useEffect(() => {
    if (!partialTranscript || !dictationRef.current) return;

    const { partialStart, end } = dictationRef.current;
    const hasCommitted = partialStart > dictationRef.current.start;
    const textToInsert = (hasCommitted ? " " : "") + partialTranscript;
    const newEnd = partialStart + textToInsert.length;

    replaceContentRange(partialStart, end, textToInsert);
    dictationRef.current.end = newEnd;
  }, [partialTranscript, replaceContentRange]); // note.content intentionally excluded

  // Streaming commit: a Deepgram segment was finalized. Replace the partial zone
  // with the committed text and advance partialStart for the next utterance.
  useEffect(() => {
    if (streamingCommit == null || !dictationRef.current) return;

    const { partialStart, end } = dictationRef.current;
    const newPartialStart = partialStart + streamingCommit.length;

    replaceContentRange(partialStart, end, streamingCommit);
    dictationRef.current.partialStart = newPartialStart;
    dictationRef.current.end = newPartialStart;
    dictationRef.current.committedChars += streamingCommit.length;

    onStreamingCommitConsumed();
  }, [streamingCommit, onStreamingCommitConsumed, replaceContentRange]); // note.content intentionally excluded

  // Final transcript (on recording stop).
  useEffect(() => {
    if (finalTranscript == null) return;

    const range = dictationRef.current;
    if (!range) {
      // Non-streaming: insert at cursor with separator
      const pos = cursorPosRef.current;
      const before = contentRef.current.slice(0, pos);
      const after = contentRef.current.slice(pos);
      const separator = before && !before.endsWith("\n") ? "\n" : "";
      const newContent = before + separator + finalTranscript + after;
      commitContentChange(newContent);
      onFinalTranscriptConsumed();
      return;
    }

    // Streaming: committed text is already in the note. Only finalize the
    // remaining partial zone with the tail of the final transcript.
    const { partialStart, end, committedChars } = range;
    const remainingFinal = finalTranscript.slice(committedChars);

    // If partial zone is empty and nothing new to insert, just clean up
    if (partialStart === end && !remainingFinal.trim()) {
      dictationRef.current = null;
      onFinalTranscriptConsumed();
      return;
    }

    replaceContentRange(partialStart, end, remainingFinal);
    dictationRef.current = null;
    onFinalTranscriptConsumed();
  }, [finalTranscript, commitContentChange, onFinalTranscriptConsumed, replaceContentRange]); // note.content intentionally excluded

  // Safety: clear dictation range when processing ends without a final transcript
  // (e.g. cancelled recording with no captured text). Declared after the final
  // transcript effect so it runs second if both trigger in the same render.
  const prevDictationProcessingRef = useRef(false);
  useEffect(() => {
    if (prevDictationProcessingRef.current && !isProcessing && dictationRef.current) {
      dictationRef.current = null;
    }
    prevDictationProcessingRef.current = isProcessing;
  }, [isProcessing]);

  const handleSelect = () => {
    if (textareaRef.current && document.activeElement === textareaRef.current) {
      if (suppressSelectionCaptureRef.current) return;
      captureUserSelection(textareaRef.current.selectionStart, textareaRef.current.selectionEnd);
    }
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;

    // Skip no-op changes (e.g. React controlled-component echo during dictation)
    if (newValue === note.content) return;

    if (dictationRef.current) {
      const beforeInput = beforeInputSelectionRef.current;
      beforeInputSelectionRef.current = null;

      if (beforeInput) {
        const replacedLength = beforeInput.end - beforeInput.start;
        const insertLength = newValue.length - (note.content.length - replacedLength);
        const range = dictationRef.current;

        const nextStart = mapIndexThroughUserEdit(
          range.start,
          beforeInput.start,
          beforeInput.end,
          insertLength
        );
        const nextPartialStart = mapIndexThroughUserEdit(
          range.partialStart,
          beforeInput.start,
          beforeInput.end,
          insertLength
        );
        const nextEnd = mapIndexThroughUserEdit(
          range.end,
          beforeInput.start,
          beforeInput.end,
          insertLength
        );

        range.start = Math.min(nextStart, newValue.length);
        range.partialStart = Math.min(Math.max(nextPartialStart, range.start), newValue.length);
        range.end = Math.min(Math.max(nextEnd, range.partialStart), newValue.length);
      } else {
        const delta = newValue.length - note.content.length;
        const editPos = e.target.selectionStart - delta;
        if (editPos <= dictationRef.current.start) {
          dictationRef.current.start += delta;
          dictationRef.current.partialStart += delta;
          dictationRef.current.end += delta;
        } else if (editPos <= dictationRef.current.partialStart) {
          dictationRef.current.partialStart += delta;
          dictationRef.current.end += delta;
        } else if (editPos < dictationRef.current.end) {
          dictationRef.current.end += delta;
        }
      }
    }

    beforeInputSelectionRef.current = null;
    contentRef.current = newValue;
    onContentChange(newValue);
    captureUserSelection(e.target.selectionStart, e.target.selectionEnd);
  };

  const handleEnhancedChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      enhancement?.onChange(e.target.value);
    },
    [enhancement]
  );

  const wordCount = useMemo(() => {
    const trimmed = note.content.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [note.content]);

  const noteDate = formatNoteDate(note.created_at);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-5 pt-4 pb-0">
        <div
          ref={titleRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleTitleInput}
          onKeyDown={handleTitleKeyDown}
          onPaste={handleTitlePaste}
          data-placeholder={t("notes.editor.untitled")}
          className="text-base font-semibold text-foreground bg-transparent outline-none tracking-[-0.01em] empty:before:content-[attr(data-placeholder)] empty:before:text-foreground/15 empty:before:pointer-events-none"
          role="textbox"
          aria-label={t("notes.editor.noteTitle")}
        />
        <div className="flex items-center mt-1">
          <div className="flex items-center text-xs text-foreground/50 dark:text-foreground/20 min-w-0">
            {noteDate && <span>{noteDate}</span>}
            {noteDate && (isSaving || wordCount > 0) && <span className="mx-1.5">&middot;</span>}
            <span className="tabular-nums flex items-center gap-1 shrink-0">
              {isSaving && <Loader2 size={8} className="animate-spin" />}
              {isSaving
                ? t("notes.editor.saving")
                : wordCount > 0
                  ? t("notes.editor.wordsCount", { count: wordCount })
                  : ""}
            </span>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1">
            {enhancement && (
              <div
                ref={segmentContainerRef}
                className="relative flex items-center shrink-0 rounded-md bg-foreground/3 dark:bg-white/3 p-0.5"
              >
                <div
                  className="absolute top-0.5 left-0 rounded bg-background dark:bg-surface-2 shadow-sm transition-[width,height,transform,opacity] duration-200 ease-out pointer-events-none"
                  style={indicatorStyle}
                />
                <button
                  data-segment-button
                  onClick={() => setViewMode("raw")}
                  className={cn(
                    "relative z-1 px-1.5 h-5 rounded text-xs font-medium transition-colors duration-150 flex items-center gap-1",
                    viewMode === "raw"
                      ? "text-foreground/60"
                      : "text-foreground/25 hover:text-foreground/40"
                  )}
                >
                  <AlignLeft size={10} />
                  {t("notes.editor.raw")}
                </button>
                <button
                  data-segment-button
                  onClick={() => setViewMode("enhanced")}
                  className={cn(
                    "relative z-1 px-1.5 h-5 rounded text-xs font-medium transition-colors duration-150 flex items-center gap-1",
                    viewMode === "enhanced"
                      ? "text-foreground/60"
                      : "text-foreground/25 hover:text-foreground/40"
                  )}
                >
                  <Sparkles size={9} />
                  {t("notes.editor.enhanced")}
                  {enhancement.isStale && (
                    <span
                      className="w-1 h-1 rounded-full bg-amber-400/60"
                      title={t("notes.editor.staleIndicator")}
                    />
                  )}
                </button>
              </div>
            )}
            {onExportNote && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="shrink-0 h-6 w-6 flex items-center justify-center rounded-md bg-foreground/3 dark:bg-white/3 text-foreground/25 hover:text-foreground/40 hover:bg-foreground/6 dark:hover:bg-white/6 transition-colors duration-150"
                    aria-label={t("notes.editor.export")}
                  >
                    <Download size={11} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4}>
                  <DropdownMenuItem onClick={() => onExportNote("md")} className="text-xs gap-2">
                    <FileText size={13} className="text-foreground/40" />
                    {t("notes.editor.asMarkdown")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onExportNote("txt")} className="text-xs gap-2">
                    <FileText size={13} className="text-foreground/40" />
                    {t("notes.editor.asPlainText")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 relative min-h-0">
        <div className="h-full overflow-y-auto">
          {viewMode === "enhanced" && enhancement ? (
            <MarkdownTextarea value={enhancement.content} onChange={handleEnhancedChange} />
          ) : (
            <MarkdownTextarea
              value={note.content}
              onChange={handleContentChange}
              onSelect={handleSelect}
              textareaRef={textareaRef}
              placeholder={t("notes.editor.startWriting")}
              disabled={actionProcessingState === "processing"}
            />
          )}
        </div>
        <ActionProcessingOverlay
          state={actionProcessingState ?? "idle"}
          actionName={actionName ?? null}
        />
        <div
          className="absolute bottom-0 left-0 right-0 h-24 pointer-events-none"
          style={{ background: "linear-gradient(to bottom, transparent, var(--color-background))" }}
        />
        <DictationWidget
          isRecording={isRecording}
          isProcessing={isProcessing}
          onStart={handleStartRecording}
          onStop={onStopRecording}
          actionPicker={actionPicker}
        />
      </div>
    </div>
  );
}
