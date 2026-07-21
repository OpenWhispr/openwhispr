import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle } from "../ui/toggle";
import { useToast } from "../ui/useToast";
import type {
  NoteItem,
  NotionDestination,
  NotionLayoutKey,
  NotionNoteDraft,
  NotionPublication,
} from "../../types/electron";

interface NotionPublishDialogProps {
  note: NoteItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enhancedIsStale?: boolean;
  enhancedContent?: string | null;
  onPublished: (publication: NotionPublication) => void;
}

export default function NotionPublishDialog({
  note,
  open,
  onOpenChange,
  enhancedIsStale = false,
  enhancedContent,
  onPublished,
}: NotionPublishDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [destination, setDestination] = useState<NotionDestination | null>(null);
  const [layoutKey, setLayoutKey] = useState<NotionLayoutKey>(
    note.note_type === "meeting" ? "meeting" : "general"
  );
  const [contentSource, setContentSource] = useState<"enhanced" | "original">(
    (enhancedContent ?? note.enhanced_content) && !enhancedIsStale ? "enhanced" : "original"
  );
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [preview, setPreview] = useState("");
  const [blockCount, setBlockCount] = useState(0);
  const [duplicate, setDuplicate] = useState<NotionPublication | null>(null);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertainPageUrl, setUncertainPageUrl] = useState<string | null>(null);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const availableEnhancedContent =
    enhancedContent === undefined ? note.enhanced_content || null : enhancedContent;
  const draft = useMemo<NotionNoteDraft>(
    () => ({
      title: note.title,
      content: note.content,
      enhancedContent: availableEnhancedContent,
      transcript: note.transcript || null,
    }),
    [availableEnhancedContent, note.content, note.title, note.transcript]
  );

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await window.electronAPI?.notionGetStatus?.();
      if (!status?.connected || !status.destination) {
        setDestination(null);
        setPreview("");
        setDuplicate(null);
        return;
      }
      setDestination(status.destination);
      const result = await window.electronAPI?.notionPreviewPublication?.(note.id, {
        layoutKey,
        contentSource,
        includeTranscript,
        draft,
      });
      if (!result?.success) {
        throw new Error(result?.error || t("noteEditor.notion.previewFailedFallback"));
      }
      setPreview(result.preview || "");
      setBlockCount(result.blockCount || 0);
      setDuplicate(result.duplicate || null);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : String(previewError));
    } finally {
      setLoading(false);
    }
  }, [contentSource, draft, includeTranscript, layoutKey, note.id, t]);

  useEffect(() => {
    if (!open) return;
    setLayoutKey(note.note_type === "meeting" ? "meeting" : "general");
    setContentSource(availableEnhancedContent && !enhancedIsStale ? "enhanced" : "original");
    setUncertainPageUrl(null);
    setOutcomeUnknown(false);
    void window.electronAPI?.notionGetStatus?.().then((status) => {
      if (status?.destination) {
        setIncludeTranscript(
          status.destination.include_transcript === 1 && Boolean(note.transcript)
        );
      }
    });
  }, [availableEnhancedContent, enhancedIsStale, note.note_type, note.transcript, open]);

  useEffect(() => {
    if (open) void loadPreview();
  }, [loadPreview, open]);

  const publish = async (allowDuplicate = false) => {
    setPublishing(true);
    setError(null);
    setUncertainPageUrl(null);
    setOutcomeUnknown(false);
    try {
      const result = await window.electronAPI?.notionPublish?.(note.id, {
        layoutKey,
        contentSource,
        includeTranscript,
        allowDuplicate,
        draft,
      });
      if (result?.code === "DUPLICATE" && result.duplicate) {
        setDuplicate(result.duplicate);
        return;
      }
      if (result?.code === "OUTCOME_UNKNOWN") {
        setUncertainPageUrl(result.pageUrl || null);
        setOutcomeUnknown(true);
      }
      if (!result?.success || !result.publication) {
        throw new Error(result?.error || t("noteEditor.notion.publishFailedFallback"));
      }
      onPublished(result.publication);
      onOpenChange(false);
      toast({
        title: t("noteEditor.notion.publishedToast"),
        variant: "success",
        action: result.pageUrl ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.electronAPI?.openExternal?.(result.pageUrl!)}
          >
            {t("noteEditor.notion.openInNotion")}
          </Button>
        ) : undefined,
      });
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : String(publishError));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("noteEditor.notion.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("noteEditor.notion.dialogDescription")}</DialogDescription>
        </DialogHeader>

        {!loading && !destination ? (
          <div className="rounded-lg border border-border/60 bg-muted/30 p-4 text-sm">
            <p className="font-medium text-foreground">
              {t("noteEditor.notion.noDestinationTitle")}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t("noteEditor.notion.noDestinationDescription")}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="mb-1.5 text-xs font-medium text-foreground">
                  {t("noteEditor.notion.destinationLabel")}
                </p>
                <div className="flex h-10 items-center rounded-lg border border-border/60 px-3 text-sm text-muted-foreground">
                  {destination?.data_source_name || t("common.loading")}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-foreground">
                  {t("noteEditor.notion.layoutLabel")}
                </p>
                <Select
                  value={layoutKey}
                  onValueChange={(value: NotionLayoutKey) => setLayoutKey(value)}
                >
                  <SelectTrigger className="rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">{t("noteEditor.notion.layoutGeneral")}</SelectItem>
                    <SelectItem value="meeting">{t("noteEditor.notion.layoutMeeting")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium text-foreground">
                {t("noteEditor.notion.contentLabel")}
              </p>
              <Select
                value={contentSource}
                onValueChange={(value: "enhanced" | "original") => setContentSource(value)}
              >
                <SelectTrigger className="rounded-lg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="original">{t("noteEditor.notion.contentOriginal")}</SelectItem>
                  {availableEnhancedContent && !enhancedIsStale && (
                    <SelectItem value="enhanced">
                      {t("noteEditor.notion.contentEnhanced")}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              {note.note_type === "meeting" && (!availableEnhancedContent || enhancedIsStale) && (
                <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                  {t("noteEditor.notion.staleEnhancedWarning")}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
              <div>
                <p className="text-xs font-medium text-foreground">
                  {t("noteEditor.notion.transcriptLabel")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {note.transcript
                    ? t("noteEditor.notion.transcriptAvailable")
                    : t("noteEditor.notion.transcriptUnavailable")}
                </p>
              </div>
              <Toggle
                checked={includeTranscript}
                disabled={!note.transcript}
                onChange={setIncludeTranscript}
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-xs font-medium text-foreground">
                  {t("noteEditor.notion.previewLabel")}
                </p>
                <span className="text-[10px] text-muted-foreground">
                  {t("noteEditor.notion.previewBlocks", { count: blockCount })}
                </span>
              </div>
              <div className="h-36 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  preview || t("noteEditor.notion.previewEmpty")
                )}
              </div>
            </div>

            {duplicate && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-xs font-medium text-foreground">
                  {t("noteEditor.notion.duplicateNotice")}
                </p>
                <div className="mt-2 flex gap-2">
                  {duplicate.notion_page_url && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => window.electronAPI?.openExternal?.(duplicate.notion_page_url!)}
                    >
                      <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                      {t("noteEditor.notion.openExisting")}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => void publish(true)}>
                    {t("noteEditor.notion.publishAnother")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between gap-3 text-xs text-destructive">
            <p>{error}</p>
            {uncertainPageUrl && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => window.electronAPI?.openExternal?.(uncertainPageUrl)}
              >
                {t("noteEditor.notion.openInNotion")}
              </Button>
            )}
            {outcomeUnknown && (
              <Button
                size="sm"
                variant="outline"
                disabled={publishing}
                onClick={() => void publish(true)}
              >
                {t("noteEditor.notion.publishAnother")}
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={publishing}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void publish(false)}
            disabled={!destination || loading || publishing || Boolean(duplicate)}
          >
            {publishing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              t("noteEditor.notion.publish")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
