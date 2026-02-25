import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Loader2, FolderOpen, MoreHorizontal, Pencil, Trash2, Check } from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/Toast";
import NoteListItem from "./NoteListItem";
import NoteEditor from "./NoteEditor";
import ActionPicker from "./ActionPicker";
import ActionManagerDialog from "./ActionManagerDialog";
import AddNotesToFolderDialog from "./AddNotesToFolderDialog";
import { useNoteRecording } from "../../hooks/useNoteRecording";
import { useActionProcessing } from "../../hooks/useActionProcessing";
import { useSettingsStore, selectIsCloudReasoningMode } from "../../stores/settingsStore";
import { useFolderManagement } from "../../hooks/useFolderManagement";
import { useNoteDragAndDrop } from "../../hooks/useNoteDragAndDrop";
import { cn } from "../lib/utils";
import { MEETINGS_FOLDER_NAME } from "./shared";
import logger from "../../utils/logger";
import {
  useNotes,
  useActiveNoteId,
  useActiveFolderId,
  initializeNotes,
  setActiveNoteId,
  setActiveFolderId,
} from "../../stores/noteStore";
import { useNotesOnboarding } from "../../hooks/useNotesOnboarding";
import NotesOnboarding from "./NotesOnboarding";
import RealtimeTranscriptionBanner from "./RealtimeTranscriptionBanner";

const FOLDER_INPUT_CLASS =
  "w-full h-6 bg-foreground/5 dark:bg-white/5 rounded px-2 text-xs text-foreground outline-none border border-primary/30 focus:border-primary/50";

function makeContentHash(content: string): string {
  return String(content.length) + "-" + content.slice(0, 50);
}

interface PersonalNotesViewProps {
  onOpenSettings?: (section: string) => void;
}

export default function PersonalNotesView({ onOpenSettings }: PersonalNotesViewProps) {
  const { t } = useTranslation();
  const notes = useNotes();
  const activeNoteId = useActiveNoteId();
  const activeFolderId = useActiveFolderId();
  const [isSaving, setIsSaving] = useState(false);
  const [localTitle, setLocalTitle] = useState("");
  const [localContent, setLocalContent] = useState("");
  const [localEnhancedContent, setLocalEnhancedContent] = useState<string | null>(null);
  const [finalTranscript, setFinalTranscript] = useState<string | null>(null);
  const [showActionManager, setShowActionManager] = useState(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const enhancedSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const activeNoteRef = useRef<number | null>(null);
  const localContentRef = useRef(localContent);
  localContentRef.current = localContent;
  const localTitleRef = useRef(localTitle);
  localTitleRef.current = localTitle;
  const { toast } = useToast();
  const isCloudMode = useSettingsStore(selectIsCloudReasoningMode);
  const effectiveModelId = useSettingsStore((s) => s.reasoningModel);
  const {
    isComplete: isOnboardingComplete,
    isProUser,
    isProLoading,
    complete: completeOnboarding,
  } = useNotesOnboarding();

  const {
    folders,
    folderCounts,
    isLoading,
    isCreatingFolder,
    newFolderName,
    renamingFolderId,
    renameValue,
    showAddNotesDialog,
    newFolderInputRef,
    renameInputRef,
    setIsCreatingFolder,
    setNewFolderName,
    setRenamingFolderId,
    setRenameValue,
    setShowAddNotesDialog,
    loadFolders,
    handleCreateFolder,
    handleConfirmRename,
    handleDeleteFolder,
  } = useFolderManagement();

  const activeNote = notes.find((n) => n.id === activeNoteId) ?? null;
  const isMeetingsFolder = useMemo(
    () => folders.find((f) => f.id === activeFolderId)?.name === MEETINGS_FOLDER_NAME,
    [folders, activeFolderId]
  );

  const {
    isRecording,
    isProcessing,
    partialTranscript,
    streamingCommit,
    consumeStreamingCommit,
    startRecording,
    stopRecording,
  } = useNoteRecording({
    onTranscriptionComplete: useCallback((text: string) => {
      setFinalTranscript(text);
    }, []),
    onError: useCallback(
      (error: { title: string; description: string }) => {
        toast({ title: error.title, description: error.description, variant: "destructive" });
      },
      [toast]
    ),
  });

  const handleFinalTranscriptConsumed = useCallback(() => setFinalTranscript(null), []);

  useEffect(() => {
    if (activeNote && activeNote.id !== activeNoteRef.current) {
      activeNoteRef.current = activeNote.id;
      setLocalTitle(activeNote.title);
      setLocalContent(activeNote.content);
      setLocalEnhancedContent(activeNote.enhanced_content ?? null);
    }
    if (!activeNote) {
      activeNoteRef.current = null;
    }
  }, [activeNote]);

  const debouncedSave = useCallback((noteId: number, title: string, content: string) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      setIsSaving(true);
      try {
        await window.electronAPI.updateNote(noteId, { title, content });
      } catch (err) {
        logger.warn("Failed to save note", { error: (err as Error).message }, "notes");
      } finally {
        setIsSaving(false);
      }
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (enhancedSaveTimeoutRef.current) clearTimeout(enhancedSaveTimeoutRef.current);
    };
  }, []);

  const handleTitleChange = useCallback(
    (title: string) => {
      setLocalTitle(title);
      if (activeNoteId) debouncedSave(activeNoteId, title, localContent);
    },
    [activeNoteId, localContent, debouncedSave]
  );

  const handleContentChange = useCallback(
    (content: string) => {
      setLocalContent(content);
      if (activeNoteId) debouncedSave(activeNoteId, localTitle, content);
    },
    [activeNoteId, localTitle, debouncedSave]
  );

  const handleEnhancedContentChange = useCallback(
    (content: string) => {
      setLocalEnhancedContent(content);
      if (!activeNoteId) return;
      if (enhancedSaveTimeoutRef.current) clearTimeout(enhancedSaveTimeoutRef.current);
      enhancedSaveTimeoutRef.current = setTimeout(async () => {
        setIsSaving(true);
        try {
          await window.electronAPI.updateNote(activeNoteId, { enhanced_content: content });
        } finally {
          setIsSaving(false);
        }
      }, 1000);
    },
    [activeNoteId]
  );

  const handleNewNote = useCallback(async () => {
    if (!activeFolderId || isMeetingsFolder) return;
    const result = await window.electronAPI.saveNote(
      t("notes.list.untitledNote"),
      "",
      "personal",
      null,
      null,
      activeFolderId
    );
    if (result.success && result.note) {
      setActiveNoteId(result.note.id);
      loadFolders();
    }
  }, [activeFolderId, isMeetingsFolder, loadFolders]);

  const handleNotesAdded = useCallback(async () => {
    if (activeFolderId) {
      await initializeNotes(null, 50, activeFolderId);
    }
    loadFolders();
  }, [activeFolderId, loadFolders]);

  const handleDelete = useCallback(
    async (id: number) => {
      await window.electronAPI.deleteNote(id);
      if (activeNoteId === id) {
        const remaining = notes.filter((n) => n.id !== id);
        setActiveNoteId(remaining.length > 0 ? remaining[0].id : null);
      }
      loadFolders();
    },
    [activeNoteId, notes, loadFolders]
  );

  const handleMoveToFolder = useCallback(
    async (noteId: number, folderId: number) => {
      await window.electronAPI.updateNote(noteId, { folder_id: folderId });
      if (activeFolderId) await initializeNotes(null, 50, activeFolderId);
      loadFolders();
    },
    [activeFolderId, loadFolders]
  );

  const { dragState, noteDragHandlers, folderDropHandlers } = useNoteDragAndDrop({
    onMoveToFolder: handleMoveToFolder,
    currentFolderId: activeFolderId,
  });

  const handleCreateFolderAndMove = useCallback(
    async (noteId: number, folderName: string) => {
      const result = await window.electronAPI.createFolder(folderName);
      if (result.success && result.folder) {
        await window.electronAPI.updateNote(noteId, { folder_id: result.folder.id });
        if (activeFolderId) await initializeNotes(null, 50, activeFolderId);
        await loadFolders();
      } else if (result.error) {
        toast({
          title: t("notes.folders.couldNotCreate"),
          description: result.error,
          variant: "destructive",
        });
      }
    },
    [activeFolderId, loadFolders, toast, t]
  );

  const handleApplyEnhancement = useCallback(
    async (enhancedContent: string, prompt: string) => {
      if (!activeNoteId) return;
      setLocalEnhancedContent(enhancedContent);
      const hash = makeContentHash(localContentRef.current);
      setIsSaving(true);
      try {
        await window.electronAPI.updateNote(activeNoteId, {
          enhanced_content: enhancedContent,
          enhancement_prompt: prompt,
          enhanced_at_content_hash: hash,
        });
      } finally {
        setIsSaving(false);
      }
    },
    [activeNoteId]
  );

  const {
    state: actionProcessingState,
    actionName,
    runAction,
    cancel: cancelAction,
  } = useActionProcessing({
    onSuccess: useCallback(
      (enhancedContent: string, prompt: string) => {
        handleApplyEnhancement(enhancedContent, prompt);
      },
      [handleApplyEnhancement]
    ),
    onError: useCallback(
      (errorMessage: string) => {
        toast({
          title: t("notes.enhance.title"),
          description: errorMessage,
          variant: "destructive",
        });
      },
      [toast, t]
    ),
  });

  useEffect(() => {
    return () => cancelAction();
  }, [activeNoteId, cancelAction]);

  const isEnhancementStale = useMemo(() => {
    if (!activeNote?.enhanced_content || !activeNote?.enhanced_at_content_hash) return false;
    const currentHash = makeContentHash(localContent);
    return currentHash !== activeNote.enhanced_at_content_hash;
  }, [activeNote?.enhanced_content, activeNote?.enhanced_at_content_hash, localContent]);

  const handleExportNote = useCallback(
    async (format: "md" | "txt") => {
      if (!activeNoteId) return;
      await window.electronAPI.exportNote(activeNoteId, format);
    },
    [activeNoteId]
  );

  const editorNote = activeNote
    ? { ...activeNote, title: localTitle, content: localContent }
    : null;

  if (!isOnboardingComplete) {
    return <NotesOnboarding onComplete={completeOnboarding} />;
  }

  return (
    <div className="flex h-full">
      <div className="w-52 shrink-0 border-r border-border/15 dark:border-white/4 flex flex-col">
        {/* Folders */}
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wider text-foreground/50 dark:text-foreground/25">
            {t("notes.folders.title")}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsCreatingFolder(true)}
            aria-label={t("notes.context.newFolder")}
            className="h-5 w-5 rounded-md text-muted-foreground/50 dark:text-muted-foreground/30 hover:text-foreground/60 hover:bg-foreground/5"
          >
            <Plus size={13} />
          </Button>
        </div>

        <div className="px-1.5 space-y-px">
          {folders.map((folder) => {
            const isActive = folder.id === activeFolderId;
            const isMeetings = folder.name === MEETINGS_FOLDER_NAME;
            const count = folderCounts[folder.id] || 0;
            const isRenaming = renamingFolderId === folder.id;

            if (isRenaming) {
              return (
                <div key={folder.id} className="px-2">
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleConfirmRename();
                      if (e.key === "Escape") {
                        setRenamingFolderId(null);
                        setRenameValue("");
                      }
                    }}
                    onBlur={handleConfirmRename}
                    className={FOLDER_INPUT_CLASS}
                  />
                </div>
              );
            }

            const isDragOver = dragState.dragOverFolderId === folder.id;
            const isDropSuccess = dragState.dropSuccessFolderId === folder.id;

            return (
              <button
                key={folder.id}
                onClick={() => setActiveFolderId(folder.id)}
                {...folderDropHandlers(folder.id, folder.name)}
                className={cn(
                  "group relative flex items-center gap-2 w-full h-7 px-2 rounded-md cursor-pointer text-left transition-all duration-150",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30",
                  isActive
                    ? "bg-primary/8 dark:bg-primary/10"
                    : "hover:bg-foreground/4 dark:hover:bg-white/4",
                  isDragOver &&
                    !isMeetings &&
                    "bg-primary/12 dark:bg-primary/15 ring-1 ring-primary/25 scale-[1.02]",
                  isDropSuccess &&
                    "bg-emerald-500/10 dark:bg-emerald-400/10 ring-1 ring-emerald-500/20"
                )}
              >
                {isActive && !isDragOver && !isDropSuccess && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-3 rounded-r-full bg-primary" />
                )}
                <FolderOpen
                  size={13}
                  className={cn(
                    "shrink-0 transition-colors duration-150",
                    isDragOver || isActive
                      ? "text-primary"
                      : "text-foreground/35 dark:text-foreground/20 group-hover:text-foreground/50 dark:group-hover:text-foreground/35"
                  )}
                />
                <span
                  className={cn(
                    "text-xs truncate flex-1 transition-colors duration-150",
                    isDragOver || isActive
                      ? "text-foreground font-medium"
                      : "text-foreground/50 group-hover:text-foreground/70"
                  )}
                >
                  {folder.name}
                </span>

                {isMeetings ? (
                  <span className="text-[7px] font-semibold uppercase tracking-wider text-foreground/20 bg-foreground/4 dark:bg-white/6 px-1.5 py-px rounded shrink-0">
                    {t("notes.folders.soon")}
                  </span>
                ) : (
                  <>
                    {isDropSuccess ? (
                      <Check
                        size={10}
                        className="text-emerald-500 dark:text-emerald-400 shrink-0 animate-[scale-in_200ms_ease-out]"
                      />
                    ) : (
                      <span
                        className={cn(
                          "text-xs tabular-nums shrink-0 transition-colors group-hover:opacity-0",
                          isActive
                            ? "text-foreground/50 dark:text-foreground/30"
                            : "text-foreground/35 dark:text-foreground/15"
                        )}
                      >
                        {count > 0 ? count : ""}
                      </span>
                    )}
                    {!folder.is_default && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <span
                            role="button"
                            tabIndex={-1}
                            onClick={(e) => e.stopPropagation()}
                            className="h-4 w-4 flex items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity absolute right-1.5 text-foreground/25 hover:text-foreground/50 cursor-pointer"
                          >
                            <MoreHorizontal size={11} />
                          </span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" sideOffset={4} className="min-w-32">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenamingFolderId(folder.id);
                              setRenameValue(folder.name);
                            }}
                            className="text-xs gap-2 rounded-md px-2 py-1"
                          >
                            <Pencil size={11} className="text-muted-foreground/60" />
                            {t("notes.context.rename")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteFolder(folder.id);
                            }}
                            className="text-xs gap-2 rounded-md px-2 py-1 text-destructive focus:text-destructive focus:bg-destructive/10"
                          >
                            <Trash2 size={11} />
                            {t("notes.context.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </>
                )}
              </button>
            );
          })}

          {isCreatingFolder && (
            <div className="px-2">
              <input
                ref={newFolderInputRef}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateFolder();
                  if (e.key === "Escape") {
                    setIsCreatingFolder(false);
                    setNewFolderName("");
                  }
                }}
                onBlur={handleCreateFolder}
                placeholder={t("notes.folders.folderName")}
                className={cn(FOLDER_INPUT_CLASS, "placeholder:text-foreground/20")}
              />
            </div>
          )}
        </div>

        <div className="mx-3 h-px bg-border/10 dark:bg-white/4 my-2" />

        {/* Notes list */}
        {!isMeetingsFolder && (
          <>
            <div className="flex items-center justify-between px-3 py-1">
              <span className="text-xs font-medium uppercase tracking-wider text-foreground/50 dark:text-foreground/25">
                {t("notes.list.title")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleNewNote}
                aria-label={t("notes.list.newNote")}
                className="h-5 w-5 rounded-md text-muted-foreground/50 dark:text-muted-foreground/30 hover:text-foreground/60 hover:bg-foreground/5"
              >
                <Plus size={13} />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={12} className="animate-spin text-foreground/15" />
                </div>
              ) : notes.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 px-4">
                  <svg
                    className="text-foreground dark:text-white mb-3"
                    width="40"
                    height="36"
                    viewBox="0 0 40 36"
                    fill="none"
                  >
                    <rect
                      x="12"
                      y="1"
                      width="20"
                      height="26"
                      rx="2"
                      transform="rotate(5 22 14)"
                      fill="currentColor"
                      fillOpacity={0.025}
                      stroke="currentColor"
                      strokeOpacity={0.06}
                    />
                    <rect
                      x="8"
                      y="3"
                      width="20"
                      height="26"
                      rx="2"
                      fill="currentColor"
                      fillOpacity={0.04}
                      stroke="currentColor"
                      strokeOpacity={0.08}
                    />
                    <rect
                      x="12"
                      y="9"
                      width="10"
                      height="1.5"
                      rx="0.75"
                      fill="currentColor"
                      fillOpacity={0.07}
                    />
                    <rect
                      x="12"
                      y="13"
                      width="12"
                      height="1.5"
                      rx="0.75"
                      fill="currentColor"
                      fillOpacity={0.05}
                    />
                    <rect
                      x="12"
                      y="17"
                      width="8"
                      height="1.5"
                      rx="0.75"
                      fill="currentColor"
                      fillOpacity={0.04}
                    />
                  </svg>
                  <p className="text-xs text-foreground/50 dark:text-foreground/25 mb-3">
                    {t("notes.empty.emptyFolder")}
                  </p>
                  <div className="flex flex-col gap-1.5 w-full max-w-36">
                    <button
                      onClick={handleNewNote}
                      className="flex items-center justify-center gap-1.5 h-6 rounded-md bg-primary/8 dark:bg-primary/10 border border-primary/12 dark:border-primary/15 text-xs font-medium text-primary/70 hover:bg-primary/12 hover:text-primary hover:border-primary/20 transition-colors"
                    >
                      <Plus size={10} />
                      {t("notes.empty.createNote")}
                    </button>
                    <button
                      onClick={() => setShowAddNotesDialog(true)}
                      className="flex items-center justify-center gap-1.5 h-6 rounded-md border border-foreground/8 dark:border-white/8 text-xs text-foreground/40 hover:text-foreground/60 hover:border-foreground/15 hover:bg-foreground/3 dark:hover:bg-white/3 transition-colors"
                    >
                      {t("notes.addToFolder.addExisting")}
                    </button>
                  </div>
                </div>
              ) : (
                notes.map((note) => (
                  <NoteListItem
                    key={note.id}
                    note={note}
                    isActive={note.id === activeNoteId}
                    onClick={() => setActiveNoteId(note.id)}
                    onDelete={handleDelete}
                    folders={folders}
                    currentFolderId={activeFolderId}
                    onMoveToFolder={handleMoveToFolder}
                    onCreateFolderAndMove={handleCreateFolderAndMove}
                    dragHandlers={noteDragHandlers(note.id, note.title)}
                    isDragging={dragState.draggingNoteId === note.id}
                  />
                ))
              )}
            </div>
          </>
        )}

        {isMeetingsFolder && <div className="flex-1" />}
      </div>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {!isProLoading && !isProUser && (
          <RealtimeTranscriptionBanner
            onUpgrade={onOpenSettings ? () => onOpenSettings("plansBilling") : undefined}
          />
        )}
        {isMeetingsFolder ? (
          <div className="flex flex-col items-center justify-center h-full -mt-6">
            <svg
              className="text-foreground dark:text-white mb-5"
              width="72"
              height="56"
              viewBox="0 0 72 56"
              fill="none"
            >
              <ellipse cx="36" cy="48" rx="24" ry="2" fill="currentColor" fillOpacity={0.03} />
              <circle
                cx="24"
                cy="20"
                r="7"
                fill="currentColor"
                fillOpacity={0.04}
                stroke="currentColor"
                strokeOpacity={0.08}
              />
              <path
                d="M13 40c0-6 5-11 11-11s11 5 11 11"
                fill="currentColor"
                fillOpacity={0.03}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <circle
                cx="48"
                cy="20"
                r="7"
                fill="currentColor"
                fillOpacity={0.04}
                stroke="currentColor"
                strokeOpacity={0.08}
              />
              <path
                d="M37 40c0-6 5-11 11-11s11 5 11 11"
                fill="currentColor"
                fillOpacity={0.03}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <rect
                x="16"
                y="6"
                width="14"
                height="8"
                rx="3"
                fill="currentColor"
                fillOpacity={0.04}
                stroke="currentColor"
                strokeOpacity={0.07}
              />
              <rect
                x="18.5"
                y="8.5"
                width="5"
                height="1"
                rx="0.5"
                fill="currentColor"
                fillOpacity={0.06}
              />
              <rect
                x="18.5"
                y="11"
                width="8"
                height="1"
                rx="0.5"
                fill="currentColor"
                fillOpacity={0.04}
              />
              <rect
                x="44"
                y="9"
                width="12"
                height="7"
                rx="2.5"
                fill="currentColor"
                fillOpacity={0.03}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <rect
                x="46.5"
                y="11.5"
                width="4"
                height="1"
                rx="0.5"
                fill="currentColor"
                fillOpacity={0.05}
              />
            </svg>
            <h3 className="text-xs font-semibold text-foreground/60 mb-1">
              {t("notes.meeting.title")}
            </h3>
            <p className="text-xs text-foreground/50 dark:text-foreground/25 text-center max-w-52 mb-3">
              {t("notes.meeting.description")}
            </p>
            <span className="text-[8px] font-semibold uppercase tracking-widest text-primary/40 bg-primary/5 dark:bg-primary/8 px-2.5 py-1 rounded-md border border-primary/8 dark:border-primary/12">
              {t("notes.meeting.comingSoon")}
            </span>
          </div>
        ) : editorNote ? (
          <>
            <NoteEditor
              note={editorNote}
              onTitleChange={handleTitleChange}
              onContentChange={handleContentChange}
              isSaving={isSaving}
              isRecording={isRecording}
              isProcessing={isProcessing}
              partialTranscript={partialTranscript}
              finalTranscript={finalTranscript}
              onFinalTranscriptConsumed={handleFinalTranscriptConsumed}
              streamingCommit={streamingCommit}
              onStreamingCommitConsumed={consumeStreamingCommit}
              onStartRecording={startRecording}
              onStopRecording={stopRecording}
              onExportNote={handleExportNote}
              enhancement={
                localEnhancedContent
                  ? {
                      content: localEnhancedContent,
                      isStale: isEnhancementStale,
                      onChange: handleEnhancedContentChange,
                    }
                  : undefined
              }
              actionProcessingState={actionProcessingState}
              actionName={actionName}
              actionPicker={
                <ActionPicker
                  onRunAction={(action) => {
                    if (!localContent.trim()) return;
                    runAction(action, localContent, { isCloudMode, modelId: effectiveModelId });
                  }}
                  onManageActions={() => setShowActionManager(true)}
                  disabled={!localContent.trim() || actionProcessingState === "processing"}
                />
              }
            />
            <ActionManagerDialog open={showActionManager} onOpenChange={setShowActionManager} />
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center -mt-6">
            <svg
              className="text-foreground dark:text-white mb-5"
              width="72"
              height="64"
              viewBox="0 0 72 64"
              fill="none"
            >
              <rect
                x="22"
                y="2"
                width="32"
                height="42"
                rx="3"
                transform="rotate(6 38 23)"
                fill="currentColor"
                fillOpacity={0.025}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <rect
                x="18"
                y="5"
                width="32"
                height="42"
                rx="3"
                transform="rotate(3 34 26)"
                fill="currentColor"
                fillOpacity={0.04}
                stroke="currentColor"
                strokeOpacity={0.08}
              />
              <rect
                x="14"
                y="8"
                width="32"
                height="42"
                rx="3"
                fill="currentColor"
                fillOpacity={0.05}
                stroke="currentColor"
                strokeOpacity={0.1}
              />
              <rect
                x="20"
                y="16"
                width="16"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.08}
              />
              <rect
                x="20"
                y="21"
                width="20"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.06}
              />
              <rect
                x="20"
                y="26"
                width="12"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.05}
              />
              <rect
                x="20"
                y="31"
                width="18"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.04}
              />
              <circle
                cx="54"
                cy="50"
                r="5"
                fill="currentColor"
                fillOpacity={0.03}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <path
                d="M51.5 50L53 51.5L56.5 48"
                stroke="currentColor"
                strokeOpacity={0.12}
                strokeWidth={1.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {notes.length === 0 ? (
              <>
                <h3 className="text-xs font-semibold text-foreground/60 mb-1">
                  {t("notes.empty.title")}
                </h3>
                <p className="text-xs text-foreground/50 dark:text-foreground/25 text-center max-w-55 mb-4">
                  {t("notes.empty.description")}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleNewNote}
                    className="flex items-center gap-1.5 px-4 h-7 rounded-md bg-primary/8 dark:bg-primary/10 border border-primary/12 dark:border-primary/15 text-xs font-medium text-primary/70 hover:bg-primary/12 hover:text-primary hover:border-primary/20 transition-colors"
                  >
                    <Plus size={11} />
                    {t("notes.empty.createNote")}
                  </button>
                  <button
                    onClick={() => setShowAddNotesDialog(true)}
                    className="flex items-center gap-1.5 px-4 h-7 rounded-md border border-foreground/8 dark:border-white/8 text-xs text-foreground/40 hover:text-foreground/60 hover:border-foreground/15 hover:bg-foreground/3 dark:hover:bg-white/3 transition-colors"
                  >
                    {t("notes.addToFolder.addExisting")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-xs font-semibold text-foreground/60 mb-1">
                  {t("notes.empty.selectTitle")}
                </h3>
                <p className="text-xs text-foreground/50 dark:text-foreground/25 text-center max-w-50">
                  {t("notes.empty.selectDescription")}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {activeFolderId && (
        <AddNotesToFolderDialog
          open={showAddNotesDialog}
          onOpenChange={setShowAddNotesDialog}
          targetFolderId={activeFolderId}
          onNotesAdded={handleNotesAdded}
        />
      )}
    </div>
  );
}
