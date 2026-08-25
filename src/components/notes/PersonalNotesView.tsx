import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Plus, Sparkles } from "lucide-react";
import { useToast } from "../ui/useToast";
import NoteEditor from "./NoteEditor";
import SpacesTree from "./SpacesTree";
import { ContainerOverview } from "./overview/ContainerOverview";
import NotesStructureIntroDialog from "./NotesStructureIntroDialog";
import ActionPicker from "./ActionPicker";
import ActionManagerDialog from "./ActionManagerDialog";
import AddNotesToFolderDialog from "./AddNotesToFolderDialog";
import { useActionProcessing } from "../../hooks/useActionProcessing";
import type { NoteMoveTarget } from "../../hooks/useNoteDragAndDrop";
import type { NoteItem } from "../../types/electron";
import {
  useSettingsStore,
  selectIsCloudNoteFormattingMode,
  selectPolicyEffectiveSettings,
  selectResolvedNoteFormatting,
} from "../../stores/settingsStore";
import { cn } from "../lib/utils";
import logger from "../../utils/logger";
import { parseTranscriptSegments } from "../../utils/parseTranscriptSegments";
import { isExplicitSpeakerCount, resolveExpectedSpeakerCount } from "../../utils/participants";
import {
  buildLlmTranscript,
  buildMeetingContext,
  collectKnownPeople,
  type MeetingIdentity,
} from "../../utils/llmTranscript";
import type { MentionPerson } from "../../utils/mentionMarkdown";
import type { CalendarAttendee } from "../../types/calendar";
import {
  useNotes,
  useSpaces,
  useFolders,
  useActiveNote,
  useActiveNoteId,
  useActiveFolderId,
  useActiveContext,
  useIsTreeLoading,
  initializeNotes,
  initializeNotesTree,
  loadFolders,
  setActiveNoteId,
  setActiveContext,
  revealContainer,
  createFolder,
  getNoteFromStore,
} from "../../stores/noteStore";
import {
  useMeetingRecordingStore,
  useIsMeetingMode,
  useIsNarrowWindow,
  startRecording as storeStartRecording,
  stopRecording as storeStopRecording,
  lockSpeaker,
  setSessionDiarizationEnabled,
  setSessionExpectedCount,
} from "../../stores/meetingRecordingStore";
import { useNotesOnboarding } from "../../hooks/useNotesOnboarding";
import { useTeamSpacesCapability } from "../../hooks/useTeamSpacesCapability";
import { useAuth } from "../../hooks/useAuth";
import { usePolicySnapshot, useTranscriptionContextAllowed } from "../../hooks/usePolicy";
import NotesOnboarding from "./NotesOnboarding";
import { notesEmptyTitleKey } from "./shared";
import { isRegenerableNoteTitle } from "../../helpers/regenerableNoteTitle";
import { isMeetingAutoEndEligible } from "../../helpers/meetingRecordingSession";
import { handleMeetingRecordingRequest } from "../../helpers/meetingRecordingRequest";
import { markIntroSeen, NOTES_STRUCTURE_INTRO, shouldShowIntro } from "../../lib/versionedIntro";
import {
  applyNoteDraftMutation,
  collectPendingNoteWrites,
  planNoteTransition,
  shouldCancelPendingSavesForDelete,
  type NoteEditorDraft,
  type PendingDocumentSnapshot,
  type PendingEnhancedSnapshot,
  type PendingNoteWrite,
} from "../../lib/noteEditorPendingSave";

function makeContentHash(content: string): string {
  return String(content.length) + "-" + content.slice(0, 50);
}

function parseNoteParticipants(raw: string | null | undefined): CalendarAttendee[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function draftFromNote(note: NoteItem): NoteEditorDraft {
  return {
    noteId: note.id,
    title: note.title,
    content: note.content,
    enhancedContent: note.enhanced_content ?? null,
  };
}

interface PendingDocumentSave extends PendingDocumentSnapshot {
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingEnhancedSave extends PendingEnhancedSnapshot {
  readonly timer: ReturnType<typeof setTimeout>;
}

type PendingSaveReason = "switch" | "overview" | "unmount";

interface PersonalNotesViewProps {
  onOpenSettings?: (section: string) => void;
  meetingRecordingRequest?: {
    noteId: number;
    folderId: number;
    event: any;
  } | null;
  onMeetingRecordingRequestHandled?: () => void;
  invitationEntry?: { workspaceId: string; teamIds: string[] } | null;
  onInvitationEntryHandled?: () => void;
}

export default function PersonalNotesView({
  onOpenSettings,
  meetingRecordingRequest,
  onMeetingRecordingRequestHandled,
  invitationEntry,
  onInvitationEntryHandled,
}: PersonalNotesViewProps) {
  const isMeetingMode = useIsMeetingMode();
  const isNarrowWindow = useIsNarrowWindow();
  const { t } = useTranslation();
  const notes = useNotes();
  const activeNoteId = useActiveNoteId();
  const isSidePanelLayout = isMeetingMode || (isNarrowWindow && activeNoteId != null);
  const activeFolderId = useActiveFolderId();
  const [isSaving, setIsSaving] = useState(false);
  const [draft, setDraftState] = useState<NoteEditorDraft | null>(null);
  const draftRef = useRef<NoteEditorDraft | null>(null);
  const [showActionManager, setShowActionManager] = useState(false);
  const [showAddNotesDialog, setShowAddNotesDialog] = useState(false);
  const pendingDocumentRef = useRef<PendingDocumentSave | null>(null);
  const pendingEnhancedRef = useRef<PendingEnhancedSave | null>(null);

  const commitDraft = useCallback((next: NoteEditorDraft | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  // Conflict-banner Refresh applies an external cloud copy: a queued
  // debounced save would clobber it with the pre-refresh buffer, so the
  // editor cancels pending saves for that note before the copy is applied.
  const cancelPendingSaves = useCallback((noteId: number) => {
    const document = pendingDocumentRef.current;
    if (document?.noteId === noteId) {
      clearTimeout(document.timer);
      pendingDocumentRef.current = null;
    }
    const enhanced = pendingEnhancedRef.current;
    if (enhanced?.noteId === noteId) {
      clearTimeout(enhanced.timer);
      pendingEnhancedRef.current = null;
    }
  }, []);

  const takePendingSnapshots = useCallback((): {
    document: PendingDocumentSnapshot | null;
    enhanced: PendingEnhancedSnapshot | null;
  } => {
    const document = pendingDocumentRef.current;
    const enhanced = pendingEnhancedRef.current;

    if (document) clearTimeout(document.timer);
    if (enhanced) clearTimeout(enhanced.timer);
    pendingDocumentRef.current = null;
    pendingEnhancedRef.current = null;

    return { document, enhanced };
  }, []);

  const persistPendingWrites = useCallback(
    (writes: PendingNoteWrite[], reason: PendingSaveReason) => {
      for (const write of writes) {
        void window.electronAPI.updateNote(write.noteId, write.updates).catch((err: unknown) => {
          logger.warn(
            `Failed to flush note before ${reason}`,
            { error: (err as Error).message },
            "notes"
          );
        });
      }
    },
    []
  );

  const flushPendingSaves = useCallback(
    (reason: PendingSaveReason) => {
      const pending = takePendingSnapshots();
      persistPendingWrites(collectPendingNoteWrites(pending.document, pending.enhanced), reason);
    },
    [persistPendingWrites, takePendingSnapshots]
  );

  const transitionToNote = useCallback(
    (nextNote: NoteItem | null, reason: Extract<PendingSaveReason, "switch" | "overview">) => {
      const pending = takePendingSnapshots();
      const transition = planNoteTransition(nextNote, pending.document, pending.enhanced);
      persistPendingWrites(transition.writes, reason);
      commitDraft(transition.nextDraft);
    },
    [commitDraft, persistPendingWrites, takePendingSnapshots]
  );
  const { toast } = useToast();
  const policyState = usePolicySnapshot();
  const noteFormatting = useSettingsStore(
    useShallow((settings) => {
      const effectiveSettings = selectPolicyEffectiveSettings(settings, policyState);
      return {
        isCloudMode: selectIsCloudNoteFormattingMode(effectiveSettings),
        modelId: selectResolvedNoteFormatting(effectiveSettings).model,
      };
    })
  );
  const isCloudMode = noteFormatting.isCloudMode;
  const effectiveModelId = noteFormatting.modelId;
  const { isComplete: isOnboardingComplete, complete: completeOnboarding } = useNotesOnboarding();
  const { isSignedIn, user } = useAuth();
  const teamSpacesAvailable = useTeamSpacesCapability(isSignedIn);
  const isTreeLoading = useIsTreeLoading();
  const [structureIntroPending, setStructureIntroPending] = useState(() =>
    shouldShowIntro(localStorage, NOTES_STRUCTURE_INTRO)
  );
  const [showStructureIntro, setShowStructureIntro] = useState(false);

  const isTranscribing = useMeetingRecordingStore((s) => s.isRecording);
  const diarizationSessionId = useMeetingRecordingStore((s) => s.diarizationSessionId);
  const recordingNoteId = useMeetingRecordingStore((s) => s.recordingNoteId);
  const sessionDiarizationEnabled = useMeetingRecordingStore((s) => s.sessionDiarizationEnabled);
  const sessionExpectedCount = useMeetingRecordingStore((s) => s.sessionExpectedCount);
  const userTouchedStepper = useMeetingRecordingStore((s) => s.userTouchedStepper);
  const meetingRecordingAllowed = useTranscriptionContextAllowed("meeting");

  const spaces = useSpaces();
  const folders = useFolders();
  const activeContext = useActiveContext();
  const overviewSpace = useMemo(
    () => (activeContext ? (spaces.find((s) => s.id === activeContext.spaceId) ?? null) : null),
    [activeContext, spaces]
  );
  const overviewFolder = useMemo(
    () =>
      activeContext?.folderId != null
        ? (folders.find((f) => f.id === activeContext.folderId) ?? null)
        : null,
    [activeContext, folders]
  );

  useEffect(() => {
    initializeNotesTree();
  }, []);

  useEffect(() => {
    if (
      structureIntroPending &&
      isOnboardingComplete &&
      isSignedIn &&
      teamSpacesAvailable &&
      !isTreeLoading &&
      !isSidePanelLayout
    ) {
      setShowStructureIntro(true);
    }
  }, [
    structureIntroPending,
    isOnboardingComplete,
    isSignedIn,
    teamSpacesAvailable,
    isTreeLoading,
    isSidePanelLayout,
  ]);

  // Arriving via an accepted invitation reopens the structure intro even when
  // this device has already seen it, and even before notes onboarding is done
  // (the dialog also renders in the onboarding branch below).
  useEffect(() => {
    if (invitationEntry && !isSidePanelLayout) setShowStructureIntro(true);
  }, [invitationEntry, isSidePanelLayout]);

  // The acceptance modal starts a sync before navigating here. Once the first
  // space an invited team can access appears in the local mirror, take the
  // user to it instead of leaving the newly shared content hidden behind
  // Personal.
  useEffect(() => {
    if (!invitationEntry) return;
    const invitedTeamIds = new Set(invitationEntry.teamIds);
    const invitedSpace = spaces.find(
      (space) =>
        space.kind === "team" &&
        space.workspace_id === invitationEntry.workspaceId &&
        space.cloud_space_id != null &&
        // Workspace owners/admins receive implicit access, so their invitation
        // may not enumerate team ids. In that case, open the first accessible
        // team space belonging to the accepted workspace.
        (invitedTeamIds.size === 0 || space.teams.some((team) => invitedTeamIds.has(team.id)))
    );
    if (!invitedSpace) return;

    setActiveNoteId(null);
    revealContainer(invitedSpace.id, null);
    setActiveContext(invitedSpace.id, null);
    onInvitationEntryHandled?.();
  }, [invitationEntry, onInvitationEntryHandled, spaces]);

  const handleStructureIntroOpenChange = useCallback((open: boolean) => {
    setShowStructureIntro(open);
    if (!open) {
      markIntroSeen(localStorage, NOTES_STRUCTURE_INTRO);
      setStructureIntroPending(false);
    }
  }, []);

  const activeNote = useActiveNote();

  // Derive folder name and calendar event name for the metadata chips
  const activeFolderName = useMemo(() => {
    if (!activeNote?.folder_id) return null;
    return folders.find((f) => f.id === activeNote.folder_id)?.name ?? null;
  }, [activeNote?.folder_id, folders]);

  // The editor's move-to-folder chip only offers folders in the note's own
  // space; cross-space moves change the audience and need an explicit confirm.
  const editorFolders = useMemo(
    () => (activeNote ? folders.filter((f) => f.space_id === activeNote.space_id) : folders),
    [activeNote, folders]
  );

  const [calendarEventName, setCalendarEventName] = useState<string | null>(null);
  useEffect(() => {
    if (!activeNote?.calendar_event_id) {
      setCalendarEventName(null);
      return;
    }
    window.electronAPI.gcalGetEvent?.(activeNote.calendar_event_id).then((result) => {
      setCalendarEventName(result?.success && result.event?.summary ? result.event.summary : null);
    });
  }, [activeNote?.calendar_event_id]);

  const startRecording = useCallback(async () => {
    const note = activeNote ?? null;
    const noteId = note?.id ?? null;
    const seedSegments = note?.transcript ? parseTranscriptSegments(note.transcript) : [];
    await storeStartRecording({
      noteId,
      noteTitle: note?.title ?? null,
      folderId: note?.folder_id ?? null,
      seedSegments,
      diarizationEnabled: note?.diarization_enabled == null ? null : note.diarization_enabled === 1,
      expectedCount: resolveExpectedSpeakerCount(note),
      expectedCountIsExplicit: isExplicitSpeakerCount(note?.expected_speaker_count),
      autoEndEligible: isMeetingAutoEndEligible(note),
    });
  }, [activeNote]);

  const stopRecording = useCallback(async () => {
    await storeStopRecording();
  }, []);

  useEffect(() => {
    const currentDraft = draftRef.current;

    if (!activeNote) {
      // Space/folder activation shows its overview by clearing activeNoteId.
      if (currentDraft || pendingDocumentRef.current || pendingEnhancedRef.current) {
        transitionToNote(null, "overview");
      }
      return;
    }

    if (!currentDraft || activeNote.id !== currentDraft.noteId) {
      // Captured writes retain the old owner while the complete next draft is
      // installed atomically.
      transitionToNote(activeNote, "switch");
      return;
    }

    const hasPendingLocalSave =
      pendingDocumentRef.current?.noteId === activeNote.id ||
      pendingEnhancedRef.current?.noteId === activeNote.id;
    if (!hasPendingLocalSave) {
      // External update (e.g. AI chat tool) — replace the complete draft only
      // when it has no local save pending.
      commitDraft(draftFromNote(activeNote));
    }
  }, [activeNote, commitDraft, transitionToNote]);

  const scheduleDocumentSave = useCallback((snapshot: NoteEditorDraft) => {
    const current = pendingDocumentRef.current;
    if (current) clearTimeout(current.timer);

    const pending: PendingDocumentSave = {
      noteId: snapshot.noteId,
      title: snapshot.title,
      content: snapshot.content,
      timer: setTimeout(async () => {
        if (pendingDocumentRef.current !== pending) return;
        pendingDocumentRef.current = null;
        setIsSaving(true);
        try {
          await window.electronAPI.updateNote(pending.noteId, {
            title: pending.title,
            content: pending.content,
          });
        } catch (err) {
          logger.warn("Failed to save note", { error: (err as Error).message }, "notes");
        } finally {
          setIsSaving(false);
        }
      }, 1000),
    };
    pendingDocumentRef.current = pending;
  }, []);

  const scheduleEnhancedSave = useCallback((snapshot: NoteEditorDraft) => {
    const current = pendingEnhancedRef.current;
    if (current) clearTimeout(current.timer);

    const pending: PendingEnhancedSave = {
      noteId: snapshot.noteId,
      enhancedContent: snapshot.enhancedContent,
      timer: setTimeout(async () => {
        if (pendingEnhancedRef.current !== pending) return;
        pendingEnhancedRef.current = null;
        setIsSaving(true);
        try {
          await window.electronAPI.updateNote(pending.noteId, {
            enhanced_content: pending.enhancedContent,
          });
        } catch (err) {
          logger.warn(
            "Failed to save enhanced note content",
            { error: (err as Error).message },
            "notes"
          );
        } finally {
          setIsSaving(false);
        }
      }, 1000),
    };
    pendingEnhancedRef.current = pending;
  }, []);

  const handleTitleChange = useCallback(
    (sourceNoteId: number, title: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "title",
        value: title,
      });
      if (!next) return;
      commitDraft(next);
      scheduleDocumentSave(next);
    },
    [commitDraft, scheduleDocumentSave]
  );

  const handleContentChange = useCallback(
    (sourceNoteId: number, content: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "content",
        value: content,
      });
      if (!next) return;
      commitDraft(next);
      scheduleDocumentSave(next);
    },
    [commitDraft, scheduleDocumentSave]
  );

  const handleEnhancedContentChange = useCallback(
    (sourceNoteId: number, content: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "enhancedContent",
        value: content,
      });
      if (!next) return;
      commitDraft(next);
      scheduleEnhancedSave(next);
    },
    [commitDraft, scheduleEnhancedSave]
  );

  useEffect(() => {
    return () => flushPendingSaves("unmount");
  }, [flushPendingSaves]);

  const handleNewNoteIn = useCallback(
    async (spaceId: number, folderId: number | null) => {
      const result = await window.electronAPI.saveNote(
        t("notes.list.untitledNote"),
        "",
        "personal",
        null,
        null,
        folderId,
        spaceId
      );
      if (result.success && result.note) {
        setActiveContext(result.note.space_id, result.note.folder_id);
        revealContainer(result.note.space_id, result.note.folder_id);
        setActiveNoteId(result.note.id);
      }
    },
    [t]
  );

  const privateSpaceId = useMemo(
    () => spaces.find((s) => s.kind === "private")?.id ?? null,
    [spaces]
  );

  const handleNewNoteInPrivate = useCallback(() => {
    if (privateSpaceId == null) return;
    handleNewNoteIn(privateSpaceId, null);
  }, [privateSpaceId, handleNewNoteIn]);

  const handleNewNote = useCallback(() => {
    if (activeContext) handleNewNoteIn(activeContext.spaceId, activeContext.folderId);
    else handleNewNoteInPrivate();
  }, [activeContext, handleNewNoteIn, handleNewNoteInPrivate]);

  const handleNotesAdded = useCallback(async () => {
    if (activeFolderId) {
      await initializeNotes(null, 50, activeFolderId);
    }
    loadFolders();
  }, [activeFolderId]);

  const handleDelete = useCallback(
    async (id: number) => {
      if (shouldCancelPendingSavesForDelete(draftRef.current?.noteId ?? null, id)) {
        cancelPendingSaves(id);
      }
      await window.electronAPI.deleteNote(id);
    },
    [cancelPendingSaves]
  );

  const handleMoveNote = useCallback(
    async (noteId: number, target: NoteMoveTarget) => {
      await window.electronAPI.updateNote(noteId, {
        folder_id: target.folderId,
        space_id: target.spaceId,
      });
      if (noteId === activeNoteId) {
        setActiveContext(target.spaceId, target.folderId);
        revealContainer(target.spaceId, target.folderId);
      }
    },
    [activeNoteId]
  );

  const handleMoveToFolder = useCallback(
    async (noteId: number, folderId: number) => {
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) return;
      await handleMoveNote(noteId, { spaceId: folder.space_id, folderId });
    },
    [folders, handleMoveNote]
  );

  const handleCreateFolderAndMove = useCallback(
    async (noteId: number, folderName: string) => {
      const spaceId = getNoteFromStore(noteId)?.space_id ?? privateSpaceId;
      if (spaceId == null) return;
      const result = await createFolder(folderName, spaceId);
      if (result.success && result.folder) {
        await handleMoveToFolder(noteId, result.folder.id);
      } else if (result.error) {
        toast({
          title: t("notes.folders.couldNotCreate"),
          description: result.error,
          variant: "destructive",
        });
      }
    },
    [privateSpaceId, handleMoveToFolder, toast, t]
  );

  const {
    state: actionProcessingState,
    actionName,
    runAction,
  } = useActionProcessing(activeNoteId ?? null);

  // Boolean flag so actions enable during recording without re-rendering on every transcript update.
  const hasLiveTranscript = useMeetingRecordingStore(
    (s) => s.recordingNoteId === activeNote?.id && !!s.transcript
  );
  const activeNoteRawTranscript = activeNote?.transcript || "";
  const activeDraft = draft?.noteId === activeNote?.id ? draft : null;
  const editorNote = activeNote
    ? {
        ...activeNote,
        title: activeDraft ? activeDraft.title : activeNote.title,
        content: activeDraft ? activeDraft.content : activeNote.content,
        enhanced_content: activeDraft
          ? activeDraft.enhancedContent
          : (activeNote.enhanced_content ?? null),
      }
    : null;
  const editorEnhancedContent = editorNote?.enhanced_content ?? null;

  const isEnhancementStale = useMemo(() => {
    if (!editorEnhancedContent || !activeNote?.enhanced_at_content_hash) return false;
    const currentHash = makeContentHash(`${editorNote?.content ?? ""}\n${activeNoteRawTranscript}`);
    return currentHash !== activeNote.enhanced_at_content_hash;
  }, [
    activeNote?.enhanced_at_content_hash,
    activeNoteRawTranscript,
    editorEnhancedContent,
    editorNote?.content,
  ]);

  const handleExportNote = useCallback(
    async (format: "md" | "txt") => {
      if (!activeNoteId) return;
      await window.electronAPI.exportNote(activeNoteId, format);
    },
    [activeNoteId]
  );

  const handleExportTranscript = useCallback(
    async (format: "txt" | "srt" | "json" | "md") => {
      if (!activeNoteId) return;
      await window.electronAPI.exportTranscript(activeNoteId, format);
    },
    [activeNoteId]
  );

  useEffect(() => {
    if (!meetingRecordingRequest || activeNoteId !== meetingRecordingRequest.noteId) return;
    const note = activeNote?.id === meetingRecordingRequest.noteId ? activeNote : null;
    const seedSegments = note?.transcript ? parseTranscriptSegments(note.transcript) : [];
    void handleMeetingRecordingRequest({
      args: {
        noteId: meetingRecordingRequest.noteId,
        noteTitle: note?.title ?? null,
        folderId: note?.folder_id ?? meetingRecordingRequest.folderId ?? null,
        seedSegments,
        diarizationEnabled:
          note?.diarization_enabled == null ? null : note.diarization_enabled === 1,
        expectedCount: resolveExpectedSpeakerCount(note),
        expectedCountIsExplicit: isExplicitSpeakerCount(note?.expected_speaker_count),
        // Requests come from meeting detection, so a note that hasn't loaded
        // yet is still a meeting note.
        autoEndEligible: note ? isMeetingAutoEndEligible(note) : true,
      },
      startRecording: storeStartRecording,
      restoreFromMeetingMode: async () => {
        await window.electronAPI?.restoreFromMeetingMode?.();
      },
      onHandled: () => onMeetingRecordingRequestHandled?.(),
    }).catch((error) => {
      logger.warn(
        "Failed to handle automatic meeting recording request",
        { error: (error as Error).message },
        "meeting"
      );
    });
  }, [meetingRecordingRequest, activeNoteId, activeNote, onMeetingRecordingRequestHandled]);

  // Final and periodic transcript persistence live in MeetingRecordingMount /
  // the store — this view can be unmounted when an auto-end stop fires.
  const isActiveNoteRecording = isTranscribing && recordingNoteId === activeNote?.id;

  if (!isOnboardingComplete) {
    return (
      <>
        <NotesOnboarding onComplete={completeOnboarding} />
        <NotesStructureIntroDialog
          open={showStructureIntro}
          onOpenChange={handleStructureIntroOpenChange}
        />
      </>
    );
  }

  return (
    <div className="flex h-full">
      <div
        className="shrink-0 overflow-hidden transition-[width] duration-300 ease-out"
        style={{ width: isSidePanelLayout ? 0 : "13rem" }}
      >
        <div className="w-52 shrink-0 border-r border-border/15 dark:border-white/4 flex flex-col h-full">
          <div className="px-2 pt-2 pb-1 shrink-0 space-y-0.5">
            <button
              onClick={() => setShowActionManager(true)}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs",
                "text-muted-foreground/80 hover:text-foreground hover:bg-foreground/5",
                "transition-colors duration-150",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
              )}
            >
              <Sparkles size={14} className="shrink-0" />
              {t("notes.sidebar.actions")}
            </button>
          </div>

          <SpacesTree
            onDeleteNote={handleDelete}
            onMoveNote={handleMoveNote}
            onCreateFolderAndMove={handleCreateFolderAndMove}
            onNewNote={handleNewNoteIn}
            onShowStructureIntro={() => setShowStructureIntro(true)}
          />
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {editorNote ? (
          <>
            <NoteEditor
              key={editorNote.id}
              note={editorNote}
              onTitleChange={handleTitleChange}
              onContentChange={handleContentChange}
              isSaving={isSaving}
              isRecording={isActiveNoteRecording}
              isProcessing={false}
              recordingAllowed={meetingRecordingAllowed}
              onStartRecording={startRecording}
              onStopRecording={stopRecording}
              onExportNote={handleExportNote}
              onExportTranscript={handleExportTranscript}
              enhancement={
                editorEnhancedContent
                  ? {
                      content: editorEnhancedContent,
                      isStale: isEnhancementStale,
                      onChange: handleEnhancedContentChange,
                    }
                  : undefined
              }
              diarizationSessionId={diarizationSessionId}
              onLiveSpeakerLock={lockSpeaker}
              sessionDiarizationEnabled={sessionDiarizationEnabled}
              sessionExpectedCount={sessionExpectedCount}
              userTouchedStepper={userTouchedStepper}
              onSetSessionDiarizationEnabled={setSessionDiarizationEnabled}
              onSetSessionExpectedCount={setSessionExpectedCount}
              folderName={activeFolderName}
              calendarEventName={calendarEventName}
              folders={editorFolders}
              onMoveToFolder={handleMoveToFolder}
              onCreateFolderAndMove={handleCreateFolderAndMove}
              onCancelPendingSaves={cancelPendingSaves}
              actionProcessingState={actionProcessingState}
              actionName={actionName}
              actionPicker={
                <ActionPicker
                  onRunAction={async (action) => {
                    if (!editorNote) return;
                    const { recordingNoteId: liveNoteId, transcript: liveTranscript } =
                      useMeetingRecordingStore.getState();
                    const rawTranscript =
                      (liveNoteId === activeNote?.id ? liveTranscript : "") ||
                      activeNoteRawTranscript;
                    const noteContent = editorNote.content;
                    const hasNotes = !!noteContent.trim();
                    if (!hasNotes && !rawTranscript) return;

                    let formattedTranscript = "";
                    let meetingContext = "";
                    let isMeetingNote = false;
                    let knownPeople: MentionPerson[] = [];
                    if (rawTranscript) {
                      const segments = parseTranscriptSegments(rawTranscript);
                      if (segments.length > 0) {
                        isMeetingNote = true;
                        const mappingRows =
                          (await window.electronAPI
                            ?.getSpeakerMappings?.(editorNote.id)
                            .catch(() => [])) || [];
                        const speakerMappings: Record<string, string> = {};
                        for (const m of mappingRows) speakerMappings[m.speaker_id] = m.display_name;

                        const identity: MeetingIdentity = {
                          selfName: user?.name?.trim() || null,
                          selfEmail: user?.email?.trim() || null,
                          participants: parseNoteParticipants(editorNote.participants),
                        };
                        const selfLabel = identity.selfName || t("notes.speaker.you");
                        meetingContext = buildMeetingContext(identity, selfLabel);
                        formattedTranscript = buildLlmTranscript(
                          segments,
                          speakerMappings,
                          selfLabel,
                          t
                        );
                        knownPeople = collectKnownPeople(identity, speakerMappings, segments);
                      }
                      if (!formattedTranscript) {
                        formattedTranscript = rawTranscript;
                      }
                    }

                    const parts = [
                      hasNotes ? noteContent : "",
                      meetingContext,
                      formattedTranscript ? `## Meeting Transcript\n${formattedTranscript}` : "",
                    ]
                      .filter(Boolean)
                      .join("\n\n");
                    runAction(action, parts, makeContentHash(`${noteContent}\n${rawTranscript}`), {
                      isCloudMode,
                      modelId: effectiveModelId,
                      isMeetingNote,
                      knownPeople,
                      allowTitleGeneration: isRegenerableNoteTitle(
                        editorNote.title,
                        [
                          t("notes.list.untitledNote"),
                          t("notes.list.newNote"),
                          t("notes.sidebar.newNote"),
                        ],
                        calendarEventName
                      ),
                    });
                  }}
                  onManageActions={() => setShowActionManager(true)}
                  disabled={
                    (!editorNote?.content?.trim() &&
                      !hasLiveTranscript &&
                      !activeNoteRawTranscript) ||
                    actionProcessingState === "processing"
                  }
                />
              }
            />
            <ActionManagerDialog open={showActionManager} onOpenChange={setShowActionManager} />
          </>
        ) : activeContext && overviewSpace ? (
          <ContainerOverview
            key={
              activeContext.folderId != null
                ? `f:${activeContext.folderId}`
                : `s:${activeContext.spaceId}`
            }
            space={overviewSpace}
            folder={overviewFolder}
            onOpenNote={setActiveNoteId}
            onNewNote={handleNewNote}
            onAddExisting={activeFolderId != null ? () => setShowAddNotesDialog(true) : undefined}
          />
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
                  {t(notesEmptyTitleKey(activeFolderId != null))}
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
                  {/* AddNotesToFolderDialog only mounts for folder contexts —
                      space-root empty states offer just "Create note". */}
                  {activeFolderId != null && (
                    <button
                      onClick={() => setShowAddNotesDialog(true)}
                      className="flex items-center gap-1.5 px-4 h-7 rounded-md border border-foreground/8 dark:border-white/8 text-xs text-foreground/40 hover:text-foreground/60 hover:border-foreground/15 hover:bg-foreground/3 dark:hover:bg-white/3 transition-colors"
                    >
                      {t("notes.addToFolder.addExisting")}
                    </button>
                  )}
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

      <NotesStructureIntroDialog
        open={showStructureIntro}
        onOpenChange={handleStructureIntroOpenChange}
      />
    </div>
  );
}
