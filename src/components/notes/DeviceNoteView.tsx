import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { PAGE_CONTENT_WIDTH_CLASS } from "../ui/pageWidth";
import { useToast } from "../ui/useToast";
import { useUiLocale } from "../../hooks/useUiLocale";
import { openNote, useSpaces } from "../../stores/noteStore";
import { useDeviceNotesStore } from "../../stores/deviceNotesStore";
import { useSpacesInWorkspaceScope } from "../../hooks/useWorkspace";
import { privateSectionSpaces } from "../../lib/privateSection";
import { formatNoteDate } from "../../utils/dateFormatting";
import { parseTranscriptSegments } from "../../utils/parseTranscriptSegments";
import { resolveLlmSpeakerLabel } from "../../utils/llmTranscript";
import type { DeviceNote } from "../../types/electron";

interface DeviceNoteViewProps {
  id: number;
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {heading}
      </h2>
      {children}
    </section>
  );
}

/**
 * An ownerless note, read-only: it never mounts the editor, so nothing can write to it until
 * "Move to my Private" gives it an owner.
 */
export function DeviceNoteView({ id }: DeviceNoteViewProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const locale = useUiLocale();
  const closeView = useDeviceNotesStore((s) => s.closeView);
  const move = useDeviceNotesStore((s) => s.move);
  const [note, setNote] = useState<DeviceNote | null>(null);
  const [moving, setMoving] = useState(false);

  // The same Private workspace the sidebar section moves into.
  const spaces = useSpacesInWorkspaceScope(useSpaces());
  const workspaceId = privateSectionSpaces(spaces)[0]?.workspace_id ?? null;

  useEffect(() => {
    let cancelled = false;
    setNote(null);
    window.electronAPI
      ?.getDeviceNote?.(id)
      .then((loaded) => {
        if (cancelled) return;
        if (loaded) setNote(loaded);
        else closeView();
      })
      .catch(() => !cancelled && closeView());
    return () => {
      cancelled = true;
    };
  }, [id, closeView]);

  const transcript = note?.transcript ?? "";
  // Plain "Speaker: text" lines, labelled as the assistant reads them: nobody owns the note, so
  // no line is the viewer's and no speaker can be named here.
  const transcriptLines = useMemo(() => {
    const noteTaker = t("notes.speaker.noteTaker");
    return parseTranscriptSegments(transcript).map((segment) => ({
      id: segment.id,
      speaker: resolveLlmSpeakerLabel(segment, {}, noteTaker, t),
      text: segment.text,
    }));
  }, [transcript, t]);

  const handleMove = useCallback(async () => {
    setMoving(true);
    const result = await move({ noteIds: [id] }, { workspaceId });
    setMoving(false);
    if ("error" in result) {
      toast({ title: t("notes.deviceNotes.moveFailed"), variant: "destructive" });
      return;
    }
    const [movedNote] = result.moved;
    // Nothing moved: the note left the list another way (another window's move, say), and the view
    // follows it there; the move already reloaded the folders.
    if (!movedNote) {
      void useDeviceNotesStore.getState().followView();
      return;
    }
    // The user may have opened something else while the move ran.
    if (useDeviceNotesStore.getState().viewNoteId === id) {
      closeView();
      openNote(movedNote);
    }
    toast({ title: t("notes.deviceNotes.moved") });
  }, [move, id, workspaceId, closeView, toast, t]);

  if (!note) return null;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className={`${PAGE_CONTENT_WIDTH_CLASS} px-5 pt-5 pb-10`}>
        <div className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/40 px-3 py-2">
          <p className="text-sm text-muted-foreground">{t("notes.deviceNotes.banner")}</p>
          <Button size="sm" onClick={handleMove} disabled={moving}>
            {t("notes.deviceNotes.moveNote")}
          </Button>
        </div>
        <h1
          dir="auto"
          className="text-3xl font-medium leading-tight tracking-[-0.01em] text-foreground [overflow-wrap:anywhere]"
        >
          {note.title || t("notes.editor.untitled")}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {formatNoteDate(note.created_at, locale)}
        </p>
        {note.content && (
          <Section heading={t("notes.deviceNotes.notesHeading")}>
            <MarkdownRenderer content={note.content} />
          </Section>
        )}
        {note.enhanced_content && (
          <Section heading={t("notes.deviceNotes.summaryHeading")}>
            <MarkdownRenderer content={note.enhanced_content} />
          </Section>
        )}
        {transcript && (
          <Section heading={t("notes.deviceNotes.transcriptHeading")}>
            {transcriptLines.length > 0 ? (
              <div className="space-y-1.5 text-sm text-foreground">
                {transcriptLines.map((line) => (
                  <p key={line.id} dir="auto">
                    <span className="font-medium text-muted-foreground">{line.speaker}:</span>{" "}
                    {line.text}
                  </p>
                ))}
              </div>
            ) : (
              <p className="whitespace-pre-wrap text-sm text-foreground">{transcript}</p>
            )}
          </Section>
        )}
      </div>
    </div>
  );
}
