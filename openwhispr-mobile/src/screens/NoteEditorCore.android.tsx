import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { NoteEditorPlatform, EditorCopy, EditorLifecycle } from './NoteEditorPlatform.android';
import {
  View,
  TextInput,
  ScrollView,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Share } from 'react-native';
import { useNoteSharing } from '@/hooks/useNoteSharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useNotesStore } from '@/store/useNotesStore';
import { useActionsStore } from '@/store/useActionsStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useConfigStore } from '@/store/useConfigStore';
import { extractCorrectionPairs } from '@/android/dictionary/correctionPairs';
import { learnCorrections } from '@/android/dictionary/learned';
import { showLearnedToast } from '@/android/dictionary/learnedToast';
import { applyTranscriptFix, FixWordCard, type FixTarget } from '@/android/dictionary/FixWord';
import { countWord } from '@/android/dictionary/transcriptFix';
import { buildDictationHintTiers, buildEffectiveDictionaryWords } from '@/lib/dictationHints';
import { useActionProcessing } from '@/hooks/useActionProcessing';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { EditableMarkdown } from '@/components/notes/EditableMarkdown.android';
import { resolveNoteBodyView, type NoteBodyView } from '@/lib/notes/noteBodyTabs';
import { NoteShareSheet } from '@/components/notes/NoteShareSheet';
import { ConflictBanner } from '@/components/notes/ConflictBanner';
import { VoiceSetupBanner } from '@/components/notes/VoiceSetupBanner';
import { ThatsMeSheet } from '@/components/notes/ThatsMeSheet';
import { shouldOfferVoiceSetup, voiceSetupCandidates } from '@/lib/notes/voiceSetupPrompt';
import { SpeakerProfileOwnerAlreadyExistsError } from '@/data/local/notesRepository';
import { VOICE_ALREADY_TAUGHT_ALERT } from '@/lib/voiceEnrollmentMessages';
import { AttendeesSheet } from '@/components/notes/AttendeesSheet';
import { MoveToFolderSheet } from '@/components/notes/MoveToFolderSheet';
import { useMoveNote } from '@/hooks/useMoveNote';
import { formatNoteMetaDate, markViewer, noteTakenAt } from '@/lib/notes/noteMeta';
import { SpeakerRenameSheet } from '@/components/notes/SpeakerRenameSheet';
import { SpeakerMergeSheet } from '@/components/notes/SpeakerMergeSheet';
import { VoiceprintSuggestionSheet } from '@/components/notes/VoiceprintSuggestionSheet';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GlassBackButton } from '@/components/ui/GlassBackButton';
import { TabScreenHeader } from '@/components/ui/TabScreenHeader';
import { buildNoteShareContent, exportNote } from '@/lib/noteExport';
import { AppFont } from '@/lib/fonts';
import { makeContentHash, safeHaptics } from '@/lib/utils';
import { isManagedMeetingAudioUri } from '@/lib/transcriptAudio';
import { BRAND } from '@/config/colors';
import {
  handleAccountRequiredError,
  requiresRealAccount,
  showAccountRequiredAlert,
} from '@/lib/accountAccess';
import {
  getLocalReasoningReadiness,
  getLocalReasoningUnavailableMessage,
  isLocalReasoningRequired,
  shouldUseLocalReasoning,
} from '@/lib/localReasoning';
import { providerDisplayName } from '@/lib/mobileProviders';
import { promptLocalReasoningFallback } from '@/lib/localReasoningFallback';
import { confirmCloudOnce, confirmDestructive } from '@/lib/alerts';
import { buildMeetingNotesInput } from '@/lib/notes/meetingNotesInput';
import { isDefaultGenerateNotesAction } from '@/lib/notes/generateNotesPrompt';
import { isRegenerableNoteTitle } from '@/lib/notes/regenerableNoteTitle';
import {
  getCalendarSpeakerLabelSuggestions,
  parseCalendarParticipants,
} from '@/lib/calendar/meetingContext';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import type { Note } from '@/data/types';
import type { ReasoningRoutingOptions } from '@/types';
import {
  formatTranscriptForExport,
  getSpeakerDisplayName,
  groupTranscriptSegments,
  type TranscriptBlock,
} from '@/lib/diarization/transcriptDisplay';

import {
  AttendeeCircles,
  FormatBar,
  MetaChip,
  NoSummaryCard,
  NoteTabs,
  NoteTopBar,
  Shimmer,
  SoftChip,
  TranscriptCard,
  applyFormat,
  type NoteTab,
} from '@/android/notes/noteParts';
import {
  CloudOnceSheet,
  NoteMenuSheet,
  ShareExportSheet,
  TemplateSheet,
  type ExportPart,
} from '@/android/notes/noteSheets';
import {
  BUILT_IN_TEMPLATES,
  rewriteAction,
  templateAction,
  templateName as nameOfTemplate,
  templateOfNote,
} from '@/android/notes/templates';
import { deleteNotesWithUndo } from '@/android/notes/pendingDeletes';
import { notesT } from '@/android/notes/strings';
import { notesLook } from '@/android/notes/look';
import { edgeCard } from '@/android/settings/look';
import { showToast } from '@/android/settings/kit';
import { home as homeTokens } from '@/android/home/kit';
import { useNavigationBarCanvas } from '@/android/navigationBar';

/**
 * Which tab a note opens on (Figma E1): the one a search result asked for, else Summary when
 * there is one or the note is a recording, else what you typed.
 */
function openingView(note: Note | null | undefined, requested?: string): NoteBodyView {
  if (requested === 'summary') return 'enhanced';
  if (requested === 'notes' || requested === 'transcript') return requested;
  if (note?.enhancedContent || isAudioTranscriptNote(note)) return 'enhanced';
  return 'notes';
}

export const isAudioTranscriptNote = (note: Note | null | undefined): boolean =>
  note?.diarizationEnabled === 1 || note?.noteType === 'meeting' || note?.noteType === 'upload';

const transcriptStatusText = (status: string): string => {
  switch (status) {
    case 'recording':
      return 'Recording audio...';
    case 'transcribing':
      return 'Transcribing audio...';
    case 'diarizing':
      return 'Separating speakers...';
    default:
      return 'Preparing transcript...';
  }
};

/** Keep navigation within the tab that opened the note. */
export interface NoteEditorStack {
  root: Href;
  routePrefix: string;
}

const NOTES_EDITOR_STACK: NoteEditorStack = {
  root: '/(tabs)/(notes)',
  routePrefix: '/(tabs)/(notes)',
};

const defaultCopy: EditorCopy = (_key, fallback) => fallback;
const defaultPresentation = {
  copy: defaultCopy,
  copyRef: { current: defaultCopy },
  language: 'en',
  stackBodyTabs: false,
  incompleteTranscript: () => 'Transcript incomplete',
};
const alwaysCurrent = () => true;
const defaultLifecycle: EditorLifecycle = {
  aiContext: undefined,
  editorActive: { current: true },
  editorGeneration: { current: 0 },
  chatConsentGeneration: { current: 0 },
  captureAIContext: () => alwaysCurrent,
};

export function createNoteEditorScreen(platform?: NoteEditorPlatform) {
  const usePresentation = platform?.usePresentation ?? (() => defaultPresentation);
  const useSessionCookie = platform?.useSessionCookie ?? (() => undefined);
  const useLifecycle = platform?.useLifecycle ?? (() => defaultLifecycle);
  const useActionCleanup = platform?.useActionCleanup ?? (() => {});
  const useEditorFocus = platform?.useEditorFocus ?? (() => {});
  const Root = platform ? KeyboardAvoidingView : View;

  return function NoteEditorScreen({
    stack = NOTES_EDITOR_STACK,
  }: {
    stack?: NoteEditorStack;
  }): React.JSX.Element {
    const { copy, copyRef, language, incompleteTranscript } = usePresentation();
    const {
      id,
      tab: requestedTab,
      fresh,
    } = useLocalSearchParams<{ id: string; tab?: string; fresh?: string }>();
    const noteId = parseInt(id ?? '', 10);
    useNavigationBarCanvas(notesLook.canvas);
    const router = useRouter();

    const { notes, updateNote, deleteNote, getNoteById } = useNotesStore();
    const transcriptRevision = useNotesStore((s) => s.transcriptRevision);
    const getNoteSegments = useNotesStore((s) => s.getNoteSegments);
    const getNoteSpeakers = useNotesStore((s) => s.getNoteSpeakers);
    const retryMeetingTranscription = useNotesStore((s) => s.retryMeetingTranscription);
    const renameSpeaker = useNotesStore((s) => s.renameSpeaker);
    const mergeSpeakers = useNotesStore((s) => s.mergeSpeakers);
    const confirmSpeakerSuggestion = useNotesStore((s) => s.confirmSpeakerSuggestion);
    const rejectSpeakerSuggestion = useNotesStore((s) => s.rejectSpeakerSuggestion);
    const getConflictedNote = useNotesStore((s) => s.getConflictedNote);
    const resolveConflictKeepMine = useNotesStore((s) => s.resolveConflictKeepMine);
    const resolveConflictUseServer = useNotesStore((s) => s.resolveConflictUseServer);
    const privateFolders = useNotesStore((s) => s.folders);
    const spaceFolders = useNotesStore((s) => s.spaceFolders);
    const spaces = useNotesStore((s) => s.spaces);
    const getSpaceFolders = useNotesStore((s) => s.getSpaceFolders);
    const voiceProfiles = useNotesStore((s) => s.voiceProfiles);
    const meetingSpeakerEmbeddings = useNotesStore((s) => s.meetingSpeakerEmbeddingsByNoteId);
    const claimSpeakerAsMe = useNotesStore((s) => s.claimSpeakerAsMe);
    const loadVoiceProfiles = useNotesStore((s) => s.loadVoiceProfiles);
    // Until the config loads, treat the banner as dismissed so it can't flash.
    const voiceSetupDismissed = useConfigStore(
      (s) => !s.config || !!s.config.voiceSetupBannerDismissedAt,
    );
    const updateConfig = useConfigStore((s) => s.updateConfig);
    const note = useMemo<Note | null>(() => {
      if (Number.isNaN(noteId)) return null;
      return notes.find((n) => n.id === noteId) ?? getNoteById(noteId);
    }, [getNoteById, noteId, notes]);
    // note.conflictServerNote as a dep (rather than just noteId) re-derives this the moment a
    // conflict is parked or cleared, without waiting for anything else to change.
    const conflict = useMemo(
      () => getConflictedNote(noteId),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [getConflictedNote, noteId, note?.conflictServerNote],
    );
    const user = useAuthStore((s) => s.user);
    const sessionCookie = useSessionCookie();
    const activeMode = useProcessingModeStore((s) => s.activeMode);
    const { register: registerSuperwallGate } = useSuperwallGate();
    const autoLearnEnabled = useConfigStore((s) => s.config?.autoLearnCorrections ?? true);
    const notesMode = useConfigStore((s) => s.config?.inference?.notes?.mode);
    const notesProviderId = useConfigStore((s) => s.config?.inference?.notes?.providerId);
    const lifecycle = useLifecycle({ noteId, note, user, sessionCookie, activeMode, getNoteById });
    const { aiContext, captureAIContext } = lifecycle;
    const providerNotes = notesMode === 'providers';

    const actions = useActionsStore((s) => s.actions);
    const initializeActions = useActionsStore((s) => s.initialize);

    const [title, setTitle] = useState(note?.title ?? '');
    const [content, setContent] = useState(note?.content ?? '');
    // The user's last tab pick; resolveNoteBodyView maps it onto the tabs this note has now.
    const [viewMode, setViewMode] = useState<NoteBodyView>(() => openingView(note, requestedTab));
    const [selection, setSelection] = useState<{ start: number; end: number }>({
      start: (note?.content ?? '').length,
      end: (note?.content ?? '').length,
    });
    const [activeSpeakerId, setActiveSpeakerId] = useState<number | null>(null);
    const [renameSheetVisible, setRenameSheetVisible] = useState(false);
    const [mergeSheetVisible, setMergeSheetVisible] = useState(false);
    const [suggestionSheetVisible, setSuggestionSheetVisible] = useState(false);
    const [attendeesVisible, setAttendeesVisible] = useState(false);
    const [enhancedEditing, setEnhancedEditing] = useState(false);
    // Bumped to remount the generated-notes editor when its draft must be thrown away.
    const [enhancedEditorRevision, setEnhancedEditorRevision] = useState(0);
    const [shareVisible, setShareVisible] = useState(false);
    const [isRetryingTranscript, setIsRetryingTranscript] = useState(false);
    // Dictionary's C9: the misheard word long-pressed in the transcript, while its card is open.
    const [fixTarget, setFixTarget] = useState<FixTarget | null>(null);
    const keyboardHeight = useKeyboardHeight();
    const insets = useSafeAreaInsets();
    const [menuVisible, setMenuVisible] = useState(false);
    const [exportVisible, setExportVisible] = useState(false);
    const [templateVisible, setTemplateVisible] = useState(false);
    const [notesFocused, setNotesFocused] = useState(false);
    const [cloudSheet, setCloudSheet] = useState<{
      body: string;
      onUse: () => void;
      onDownload?: () => void;
    } | null>(null);
    // What the running summary request is, and the summary it replaces, for the Undo toast (E5).
    const rewriteRef = useRef<{
      kind: 'template' | 'shorter' | 'longer';
      name: string;
      previous: {
        enhancedContent: string | null;
        enhancementPrompt: string | null;
        hash: string | null;
      };
    } | null>(null);
    const contentInputRef = useRef<TextInput>(null);
    const summaryInputRef = useRef<string | null>(null);
    const titleInputRef = useRef<TextInput>(null);

    const contentRef = useRef(content);
    contentRef.current = content;
    const selectionRef = useRef(selection);
    selectionRef.current = selection;
    const titleRef = useRef(title);
    titleRef.current = title;
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Snapshot of what was loaded from disk; cleanup compares against this so we
    // don't bump updatedAt (and trigger sync + reorder) when nothing changed.
    const originalTitleRef = useRef(note?.title ?? '');
    const originalContentRef = useRef(note?.content ?? '');
    // Baseline for the correction learner — re-rooted after each dictation and
    // after each successful learn pass so we only diff truly new edits.
    const learnedBaselineRef = useRef(note?.content ?? '');
    const autoLearnEnabledRef = useRef(autoLearnEnabled);
    autoLearnEnabledRef.current = autoLearnEnabled;

    useEffect(() => {
      initializeActions();
    }, [initializeActions]);

    useEffect(() => {
      if (note) {
        setTitle(note.title);
        setContent(note.content);
        const end = note.content.length;
        setSelection({ start: end, end });
        originalTitleRef.current = note.title;
        originalContentRef.current = note.content;
        learnedBaselineRef.current = note.content;
        setViewMode(openingView(note, requestedTab));
      }
      setRenameSheetVisible(false);
      setMergeSheetVisible(false);
      setSuggestionSheetVisible(false);
      setActiveSpeakerId(null);
      setAttendeesVisible(false);
      setEnhancedEditing(false);
      setShareVisible(false);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noteId]);

    // Until you type, the title and My notes follow the saved note, so a change pulled while the note
    // is open (an edit on desktop) isn't saved over by the text it replaced.
    useEffect(() => {
      if (!note) return;
      // The refs are set here too: a save that runs before the next render reads them.
      if (titleRef.current === originalTitleRef.current && note.title !== titleRef.current) {
        setTitle(note.title);
        titleRef.current = note.title;
        originalTitleRef.current = note.title;
      }
      if (
        contentRef.current === originalContentRef.current &&
        note.content !== contentRef.current
      ) {
        setContent(note.content);
        const end = note.content.length;
        setSelection({ start: end, end });
        contentRef.current = note.content;
        originalContentRef.current = note.content;
        learnedBaselineRef.current = note.content;
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [note?.title, note?.content]);

    const isAudioTranscript = isAudioTranscriptNote(note);
    const transcriptStatus = note?.transcriptionStatus ?? 'idle';
    // transcriptRevision is an intentional cache-bust dep: it bumps on local speaker/segment writes
    // (which don't change note identity) to force these reads to re-run.
    const transcriptSegments = useMemo(
      () => (isAudioTranscript && note ? getNoteSegments(note.id) : []),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [getNoteSegments, isAudioTranscript, note, transcriptRevision],
    );
    const speakers = useMemo(
      () => (isAudioTranscript && note ? getNoteSpeakers(note.id) : []),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [getNoteSpeakers, isAudioTranscript, note, transcriptRevision],
    );
    const transcriptBlocks = useMemo(
      () => groupTranscriptSegments(transcriptSegments, speakers),
      [speakers, transcriptSegments],
    );
    const [voiceSetupVisible, setVoiceSetupVisible] = useState(false);
    const readScriptAfterSheetRef = useRef(false);
    const voiceCandidates = useMemo(
      () =>
        voiceSetupCandidates({
          segments: transcriptSegments,
          speakers,
          embeddingsByLabel: note ? meetingSpeakerEmbeddings[note.id] : undefined,
          profileIds: new Set(voiceProfiles.map((profile) => profile.id)),
        }),
      [meetingSpeakerEmbeddings, note, speakers, transcriptSegments, voiceProfiles],
    );
    const showVoiceSetupBanner =
      (!platform || platform.supportsVoiceEnrollment()) &&
      shouldOfferVoiceSetup({
        isOnDeviceMeeting:
          note?.noteType === 'meeting' && isManagedMeetingAudioUri(note.id, note.sourceFile),
        transcriptStatus,
        hasOwnerProfile: voiceProfiles.some((profile) => profile.isOwner === 1),
        dismissed: voiceSetupDismissed,
        candidateCount: voiceCandidates.length,
      });
    // The banner and That's me need your profiles, and a meeting opened straight from
    // recording never passes a screen that loads them.
    useEffect(() => {
      loadVoiceProfiles();
    }, [loadVoiceProfiles]);
    useEffect(() => {
      setVoiceSetupVisible(false);
      readScriptAfterSheetRef.current = false;
    }, [noteId]);
    const hasTranscriptSegments = transcriptSegments.length > 0;
    const usesSegmentTranscript = isAudioTranscript && hasTranscriptSegments;
    const transcriptText = useMemo(
      () =>
        usesSegmentTranscript ? formatTranscriptForExport({ title, blocks: transcriptBlocks }) : '',
      [title, transcriptBlocks, usesSegmentTranscript],
    );
    const calendarParticipants = useMemo(
      () => parseCalendarParticipants(note?.participants ?? null) ?? [],
      [note?.participants],
    );
    const noteSpace = spaces.find((space) => space.id === note?.spaceId);
    // A Space missing from the list (access just revoked, or not synced yet) has no folders to offer,
    // and its notes must never be moved into private folders.
    const isSpaceUnknown = note?.spaceId != null && !noteSpace;
    const scopeSpaceId = noteSpace?.kind === 'team' ? noteSpace.id : null;
    const targetFolders = useMemo(
      () =>
        isSpaceUnknown ? [] : scopeSpaceId != null ? getSpaceFolders(scopeSpaceId) : privateFolders,
      // getSpaceFolders reads the repository, so the store's folder lists stand in as the signal to
      // re-read: every folder reload (create, rename, move, sync) replaces them.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [getSpaceFolders, isSpaceUnknown, privateFolders, scopeSpaceId, spaceFolders],
    );
    const folderName = targetFolders.find((folder) => folder.id === note?.folderId)?.name ?? null;
    const move = useMoveNote({
      scopeSpaceId,
      targetFolders,
      excludeFolderId: note?.folderId ?? null,
    });
    const closeMove = move.close;
    // A picker left open would move a note it no longer shows, or a team note as a personal one.
    useEffect(() => {
      closeMove();
    }, [closeMove, noteId, isSpaceUnknown]);
    // The participants' `self` comes from the calendar of whoever created the note. Only the team
    // sync records an owner, so a note without one is yours, even when its Space is unknown here.
    const attendees = useMemo(
      () =>
        markViewer(calendarParticipants, {
          creatorIsViewer: !note?.ownerUserId || note.ownerUserId === user?.id,
          viewerEmail: user?.email ?? null,
        }),
      [calendarParticipants, note?.ownerUserId, user?.email, user?.id],
    );
    const meetingNotesContext = useMemo(
      () =>
        note?.calendarEventId
          ? {
              eventTitle: title,
              participants: calendarParticipants,
            }
          : undefined,
      [calendarParticipants, note?.calendarEventId, title],
    );
    const actionInputText = usesSegmentTranscript
      ? buildMeetingNotesInput({ rawNotes: content, transcript: transcriptText })
      : content;
    const generatedMeetingInputText = usesSegmentTranscript
      ? buildMeetingNotesInput({
          rawNotes: content,
          transcript: formatTranscriptForExport({
            title: meetingNotesContext ? undefined : title,
            blocks: transcriptBlocks,
            suppressUnlabeledSpeakerNames: true,
          }),
          meetingContext: meetingNotesContext,
        })
      : content;
    const actionInputRef = useRef(actionInputText);
    actionInputRef.current = actionInputText;
    const generatedMeetingInputRef = useRef(generatedMeetingInputText);
    generatedMeetingInputRef.current = generatedMeetingInputText;
    const lastEnhancementInputHashRef = useRef('');
    const usesSegmentTranscriptRef = useRef(usesSegmentTranscript);
    usesSegmentTranscriptRef.current = usesSegmentTranscript;
    // Desktop used to store an uploaded file's flat transcript as the note body. It now
    // stores it as the transcript, leaving the body for the user's own notes.
    const contentIsTranscript = note?.noteType === 'upload' && !hasTranscriptSegments;
    const activeSpeaker =
      activeSpeakerId == null
        ? null
        : (speakers.find((speaker) => speaker.id === activeSpeakerId) ?? null);
    const activeSpeakerName = activeSpeaker
      ? getSpeakerDisplayName(activeSpeaker, activeSpeaker.sortOrder)
      : '';
    const attendeeSpeakerSuggestions = useMemo(() => {
      const currentName = activeSpeakerName.replace(/\?$/, '').trim().toLowerCase();
      return getCalendarSpeakerLabelSuggestions(calendarParticipants).filter(
        (suggestion) => suggestion.label.trim().toLowerCase() !== currentName,
      );
    }, [activeSpeakerName, calendarParticipants]);
    const isTranscriptInProgress = ['recording', 'transcribing', 'diarizing'].includes(
      transcriptStatus,
    );
    const shouldShowTranscriptStatus =
      isAudioTranscript && !hasTranscriptSegments && isTranscriptInProgress;
    const shouldShowTranscriptFailed =
      isAudioTranscript && (platform || !hasTranscriptSegments) && transcriptStatus === 'failed';
    const shouldRenderPlainEditor =
      !isAudioTranscript ||
      (!hasTranscriptSegments && (transcriptStatus === 'idle' || transcriptStatus === 'done'));
    const shouldRenderPlainEditorRef = useRef(shouldRenderPlainEditor);
    shouldRenderPlainEditorRef.current = shouldRenderPlainEditor;
    const transcriptPending = shouldShowTranscriptStatus || shouldShowTranscriptFailed;
    const hasEnhanced = !!note?.enhancedContent;
    // An open editor keeps its tab, so clearing the notes to rewrite them doesn't close it.
    const hasEnhancedTab = hasEnhanced || enhancedEditing;
    const bodyTabInput = useMemo(
      () => ({
        isUpload: note?.noteType === 'upload',
        usesSegmentTranscript,
        transcriptPending,
        contentIsTranscript,
        hasEnhanced: hasEnhancedTab,
      }),
      [
        contentIsTranscript,
        hasEnhancedTab,
        note?.noteType,
        transcriptPending,
        usesSegmentTranscript,
      ],
    );
    // A private note asks before any AI leaves this phone; so does Local Mode, whose note
    // formatting follows its own selection.
    const formattingRequiresCloudConfirmation =
      note?.isPrivate === 1 || (!!platform && activeMode === 'private');

    const handleKeepMine = useCallback(() => {
      safeHaptics('selection');
      resolveConflictKeepMine(noteId);
    }, [noteId, resolveConflictKeepMine]);

    const handleClaimVoice = useCallback(
      (speakerId: number): boolean => {
        try {
          claimSpeakerAsMe(noteId, speakerId);
          safeHaptics('success');
          return true;
        } catch (error) {
          if (error instanceof SpeakerProfileOwnerAlreadyExistsError) {
            // A profile this screen didn't know about: reloading hides the banner.
            loadVoiceProfiles();
            Alert.alert(
              copyRef.current('editorFeedback.voiceAlreadyTitle', VOICE_ALREADY_TAUGHT_ALERT[0]),
              copyRef.current('editorFeedback.voiceAlreadyBody', VOICE_ALREADY_TAUGHT_ALERT[1]),
            );
          } else {
            Alert.alert(
              copyRef.current('editorFeedback.voiceSaveTitle', "Couldn't save your voice"),
              copyRef.current(
                'editorFeedback.voiceSaveBody',
                'Read a short script instead to teach OpenWhispr your voice.',
              ),
            );
          }
          return false;
        }
      },
      [claimSpeakerAsMe, loadVoiceProfiles, noteId, copyRef],
    );

    const openVoiceScript = useCallback(() => {
      router.push(`${stack.routePrefix}/voice-enrollment?owner=1&noteId=${noteId}`);
    }, [noteId, router, stack.routePrefix]);

    // iOS drops a push made while a page sheet is still sliding away, so it waits for the
    // sheet's onDismiss; Android's Modal has no onDismiss.
    const handleReadVoiceScript = useCallback(() => {
      setVoiceSetupVisible(false);
      if (Platform.OS === 'ios') readScriptAfterSheetRef.current = true;
      else openVoiceScript();
    }, [openVoiceScript]);

    const handleVoiceSetupDismissed = useCallback(() => {
      if (!readScriptAfterSheetRef.current) return;
      readScriptAfterSheetRef.current = false;
      openVoiceScript();
    }, [openVoiceScript]);

    const dismissVoiceSetup = useCallback(() => {
      safeHaptics('light');
      updateConfig({ voiceSetupBannerDismissedAt: new Date().toISOString() });
    }, [updateConfig]);

    const maybeLearnCorrections = useCallback(
      (newContent: string) => {
        if (!autoLearnEnabledRef.current) return;
        const baseline = learnedBaselineRef.current;
        if (baseline === newContent) return;
        // Shared words count as known, so a team word is never learned into Personal.
        const corrections = extractCorrectionPairs(
          baseline,
          newContent,
          buildEffectiveDictionaryWords(),
        );
        if (corrections.length > 0) {
          // Learned silently, then told after with Undo (Dictionary's C7). A word the person
          // already said no to stays unlearned.
          const learned = learnCorrections(corrections, {
            kind: 'note',
            noteId,
            title: titleRef.current,
          });
          showLearnedToast(learned);
        }
        learnedBaselineRef.current = newContent;
      },
      [noteId],
    );

    const flushDraft = useCallback((): void => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
      const titleChanged = titleRef.current !== originalTitleRef.current;
      const contentChanged = contentRef.current !== originalContentRef.current;
      if (!titleChanged && !contentChanged) return;
      updateNote(noteId, {
        ...(titleChanged ? { title: titleRef.current } : {}),
        ...(contentChanged ? { content: contentRef.current } : {}),
      });
      originalTitleRef.current = titleRef.current;
      if (contentChanged) {
        originalContentRef.current = contentRef.current;
        // Only notes that can be dictated into teach the dictionary; edits to notes typed beside a
        // transcript aren't transcription corrections.
        if (shouldRenderPlainEditorRef.current) maybeLearnCorrections(contentRef.current);
      }
    }, [noteId, updateNote, maybeLearnCorrections]);

    const debouncedSave = useCallback((): void => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(flushDraft, 800);
    }, [flushDraft]);

    useEffect(() => flushDraft, [flushDraft]);

    // Android hands focus back to the first text field when a sheet's window closes, which
    // raised the keyboard over the title; nothing here asked for it, so it goes away again.
    const anySheetOpen =
      menuVisible || exportVisible || templateVisible || cloudSheet != null || attendeesVisible;
    const sheetWasOpen = useRef(false);
    useEffect(() => {
      if (anySheetOpen) {
        sheetWasOpen.current = true;
        return;
      }
      if (!sheetWasOpen.current) return;
      sheetWasOpen.current = false;
      const timer = setTimeout(() => {
        titleInputRef.current?.blur();
        contentInputRef.current?.blur();
      }, 350);
      return () => clearTimeout(timer);
    }, [anySheetOpen]);

    // Flow B: Write a note opens with the title empty and the keyboard up, and a note left
    // without a word in it is thrown away on the way out.
    useEffect(() => {
      if (fresh !== '1') return;
      const timer = setTimeout(() => titleInputRef.current?.focus(), 350);
      return () => {
        clearTimeout(timer);
        const saved = getNoteById(noteId);
        if (
          saved &&
          !isAudioTranscriptNote(saved) &&
          isRegenerableNoteTitle(titleRef.current) &&
          !contentRef.current.trim() &&
          !saved.enhancedContent?.trim()
        )
          deleteNote(noteId);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noteId, fresh]);

    // Edits to the generated notes save on their own debounce. The pending edit carries its note
    // id, so a flush that runs after switching notes still writes to the note that was edited.
    const pendingEnhancedRef = useRef<{ noteId: number; text: string } | null>(null);
    const enhancedSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const flushEnhancedSave = useCallback(() => {
      if (enhancedSaveTimeoutRef.current) clearTimeout(enhancedSaveTimeoutRef.current);
      enhancedSaveTimeoutRef.current = null;
      const pending = pendingEnhancedRef.current;
      if (!pending) return;
      pendingEnhancedRef.current = null;
      updateNote(pending.noteId, { enhancedContent: pending.text });
    }, [updateNote]);
    const flushEnhancedSaveRef = useRef(flushEnhancedSave);
    flushEnhancedSaveRef.current = flushEnhancedSave;

    const discardEnhancedSave = useCallback(() => {
      if (enhancedSaveTimeoutRef.current) clearTimeout(enhancedSaveTimeoutRef.current);
      enhancedSaveTimeoutRef.current = null;
      pendingEnhancedRef.current = null;
    }, []);

    const handleEnhancedChange = useCallback(
      (text: string) => {
        pendingEnhancedRef.current = { noteId, text };
        if (enhancedSaveTimeoutRef.current) clearTimeout(enhancedSaveTimeoutRef.current);
        enhancedSaveTimeoutRef.current = setTimeout(flushEnhancedSave, 800);
      },
      [flushEnhancedSave, noteId],
    );

    const handleEnhancedEditingChange = useCallback(
      (editing: boolean) => {
        setEnhancedEditing(editing);
        if (!editing) flushEnhancedSave();
      },
      [flushEnhancedSave],
    );

    const handleUseServerCopy = useCallback(() => {
      safeHaptics('selection');
      // Unsaved local edits would land on top of the server copy the user just chose.
      discardEnhancedSave();
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
      setEnhancedEditorRevision((revision) => revision + 1);
      resolveConflictUseServer(noteId);
      // The editor's title/content state is a local draft, not derived straight from `note` on
      // every render — refresh it explicitly now that the repository holds the server's copy.
      const refreshed = getNoteById(noteId);
      if (refreshed) {
        setTitle(refreshed.title);
        setContent(refreshed.content);
        const end = refreshed.content.length;
        setSelection({ start: end, end });
        originalTitleRef.current = refreshed.title;
        originalContentRef.current = refreshed.content;
        learnedBaselineRef.current = refreshed.content;
        setViewMode(openingView(refreshed));
      }
    }, [discardEnhancedSave, noteId, resolveConflictUseServer, getNoteById]);

    // Leaving the note flushes an unfinished edit to the generated notes; it carries its own id.
    useEffect(() => () => flushEnhancedSaveRef.current(), [noteId]);

    const handleTitleChange = useCallback(
      (text: string) => {
        setTitle(text);
        titleRef.current = text;
        debouncedSave();
      },
      [debouncedSave],
    );

    const handleContentChange = useCallback(
      (text: string) => {
        setContent(text);
        contentRef.current = text;
        debouncedSave();
      },
      [debouncedSave],
    );

    const handleEnhanceSuccess = useCallback(
      (enhancedContent: string, prompt: string, generatedTitle?: string) => {
        const updates: Parameters<typeof updateNote>[1] = {
          enhancedContent,
          enhancementPrompt: prompt,
          enhancedAtContentHash: lastEnhancementInputHashRef.current,
        };
        // Only overwrite the title while the note is still unnamed or carries a
        // placeholder default, so we don't clobber manual edits.
        if (generatedTitle && isRegenerableNoteTitle(titleRef.current)) {
          updates.title = generatedTitle;
          setTitle(generatedTitle);
          originalTitleRef.current = generatedTitle;
        }
        const rewrite = rewriteRef.current;
        rewriteRef.current = null;
        // Shorter and longer keep the template that wrote the summary (E1's chip still names it).
        if (rewrite && rewrite.kind !== 'template') {
          if (rewrite.previous.enhancementPrompt)
            updates.enhancementPrompt = rewrite.previous.enhancementPrompt;
          // It still summarises the same notes, so it isn't marked out of date.
          updates.enhancedAtContentHash = rewrite.previous.hash;
        }
        updateNote(noteId, updates);
        setViewMode('enhanced');
        // E5: a summary that replaced another one offers Undo for 6 s, never an "are you sure?".
        if (rewrite?.previous.enhancedContent) {
          const previous = rewrite.previous;
          const message =
            rewrite.kind === 'shorter'
              ? notesT('shortened')
              : rewrite.kind === 'longer'
                ? notesT('lengthened')
                : notesT('rewrittenAs', { name: rewrite.name });
          let undone = false;
          showToast(
            message,
            'neutral',
            {
              label: notesT('undo'),
              onPress: () => {
                if (undone) return;
                undone = true;
                updateNote(noteId, {
                  enhancedContent: previous.enhancedContent,
                  enhancementPrompt: previous.enhancementPrompt,
                  enhancedAtContentHash: previous.hash,
                });
                setEnhancedEditorRevision((revision) => revision + 1);
              },
              onClose: () => undefined,
            },
            { durationMs: 6000 },
          );
        }
      },
      [noteId, updateNote],
    );

    const handleEnhanceError = useCallback(
      (message: string, error: unknown) => {
        if (handleAccountRequiredError(error, 'AI actions', { cloudOnly: true })) return;
        if (platform) platform.showActionError(message, error, copyRef.current);
        else Alert.alert('Action failed', message);
      },
      [copyRef],
    );

    const {
      state: processingState,
      runAction,
      cancel: cancelAction,
    } = useActionProcessing({
      onSuccess: handleEnhanceSuccess,
      onError: handleEnhanceError,
    });

    useActionCleanup(aiContext, cancelAction);

    useEditorFocus(lifecycle);

    const handleExport = useCallback(
      (format: 'md' | 'txt'): void => {
        safeHaptics('light');
        // Export the generated notes as edited, not as last saved.
        flushEnhancedSave();
        exportNote(
          {
            title: titleRef.current || 'Untitled',
            content: buildNoteShareContent({
              viewMode: resolveNoteBodyView(viewMode, bodyTabInput),
              enhancedContent: getNoteById(noteId)?.enhancedContent ?? null,
              transcript: formatTranscriptForExport({ blocks: transcriptBlocks }),
              content: contentRef.current,
            }),
          },
          format,
        ).catch(() =>
          Alert.alert(
            copyRef.current('editorFeedback.exportFailed', 'Export failed'),
            copyRef.current(
              'editorFeedback.exportNoteFailed',
              'Could not export this note. Please try again.',
            ),
          ),
        );
      },
      [bodyTabInput, flushEnhancedSave, getNoteById, noteId, transcriptBlocks, viewMode, copyRef],
    );

    const handleCopyGeneratedNote = useCallback(() => {
      // Copy the generated notes as edited, not as last saved.
      flushEnhancedSave();
      const generatedContent = getNoteById(noteId)?.enhancedContent;
      if (!generatedContent?.trim()) return;
      safeHaptics('light');
      Clipboard.setStringAsync(generatedContent).catch(() => {
        Alert.alert(
          copyRef.current('editorFeedback.copyFailed', 'Copy failed'),
          copyRef.current('editorFeedback.copyNotesFailed', 'Could not copy the generated notes.'),
        );
      });
    }, [flushEnhancedSave, getNoteById, noteId, copyRef]);

    const runSelectedAction = useCallback(
      (
        action: Parameters<typeof runAction>[0],
        routing: ReasoningRoutingOptions | undefined,
        isCurrent: () => boolean,
      ) => {
        if (!isCurrent()) return;
        if (processingState === 'processing') return;
        // Save a queued edit now: it must not land on top of the new notes later, and it must
        // survive an action that fails.
        flushEnhancedSave();
        // Make shorter / longer rewrite the summary itself, not the material behind it.
        const override = summaryInputRef.current;
        summaryInputRef.current = null;
        const inputText =
          override ??
          (usesSegmentTranscriptRef.current && isDefaultGenerateNotesAction(action)
            ? generatedMeetingInputRef.current
            : actionInputRef.current);
        lastEnhancementInputHashRef.current = makeContentHash(inputText);
        const options = {
          inputKind:
            usesSegmentTranscriptRef.current && override == null
              ? ('meeting-transcript' as const)
              : ('plain-note' as const),
          dictionaryTiers: buildDictationHintTiers(false),
          ...(platform
            ? {
                isCurrent,
                shouldGenerateTitle: () => isRegenerableNoteTitle(titleRef.current),
              }
            : {}),
          routing: {
            isPrivateNote: note?.isPrivate === 1,
            ...routing,
          },
        };
        runAction(action, inputText, options);
      },
      [flushEnhancedSave, note?.isPrivate, processingState, runAction],
    );

    const runActionWithRouting = useCallback(
      async (action: Parameters<typeof runAction>[0], isCurrent: () => boolean) => {
        if (!isCurrent()) return;
        const run = (routing: ReasoningRoutingOptions): void => {
          if (isCurrent()) runSelectedAction(action, routing, isCurrent);
        };
        const routing = { isPrivateNote: note?.isPrivate === 1 };
        // On-Device never leaves this phone: no account, paywall, or fallback to another service.
        if (notesMode === 'local') {
          const readiness = await getLocalReasoningReadiness();
          if (!isCurrent()) return;
          if (readiness.status === 'ready') {
            run(routing);
            return;
          }
          Alert.alert(
            copyRef.current('editorFeedback.localUnavailable', 'Local AI unavailable'),
            `${platform ? copyRef.current('editorFeedback.downloadLocal', 'Download a local text model in Account → Models to use on-device AI.') : getLocalReasoningUnavailableMessage(readiness)} ${platform ? copyRef.current('editorFeedback.localNoteStays', 'Note Formatting is set to On-Device, so this note stays on your phone.') : 'Note Formatting is set to On-Device, so this note stays on your iPhone.'}`,
          );
          return;
        }

        const localRequired = providerNotes
          ? formattingRequiresCloudConfirmation
          : isLocalReasoningRequired(routing);

        if (localRequired) {
          if (await shouldUseLocalReasoning(routing)) {
            run(routing);
            return;
          }

          const readiness = await getLocalReasoningReadiness();
          if (!isCurrent()) return;
          const runElsewhereOnce = (): void => run({ ...routing, allowCloudFallback: true });
          // A1: on Cloud, the question is a sheet with the other way out beside it.
          if (user && !providerNotes && readiness.status !== 'ready') {
            setCloudSheet({
              // Local Mode says so; a private note on Cloud says why it asks instead.
              body: notesT(activeMode === 'private' ? 'cloudBodyLocal' : 'cloudBodyPrivate'),
              onUse: runElsewhereOnce,
              onDownload: () => router.push('/(account)/ai-models'),
            });
            return;
          }
          promptLocalReasoningFallback({
            ...(platform ? { copy: copyRef.current } : {}),
            readiness,
            signedIn: !!user,
            onEnableLocal: () => run(routing),
            onUseCloudOnce: user || providerNotes ? runElsewhereOnce : undefined,
            destinationName: providerNotes ? providerDisplayName(notesProviderId ?? '') : undefined,
          });
          return;
        }

        if (providerNotes) {
          run(routing);
          return;
        }

        if (requiresRealAccount(user)) {
          showAccountRequiredAlert('AI actions', { cloudOnly: true });
          return;
        }

        const gateAndRun = (actionRouting: ReasoningRoutingOptions) => {
          if (!isCurrent()) return;
          registerSuperwallGate({
            placement: SUPERWALL_PLACEMENTS.aiActionRun,
            params: { actionName: action.name },
            requiresAccount: false,
            feature: () => run(actionRouting),
          }).catch(() => {});
        };

        if (formattingRequiresCloudConfirmation && platform) {
          setCloudSheet({
            body: notesT(note?.isPrivate === 1 ? 'cloudBodyPrivate' : 'cloudBodyLocal'),
            onUse: () => gateAndRun({ ...routing, allowCloudFallback: true }),
            onDownload:
              note?.isPrivate === 1 ? undefined : () => router.push('/(account)/ai-models'),
          });
          return;
        }
        if (formattingRequiresCloudConfirmation) {
          confirmCloudOnce(
            copyRef.current(
              'editorFeedback.cloudActionBody',
              `${action.name} sends this note to cloud AI for this request. Your note privacy and sync settings will not change.`,
              { action: action.name },
            ),
            () => gateAndRun({ ...routing, allowCloudFallback: true }),
            ...(platform
              ? ([
                  {
                    title: copyRef.current('editorFeedback.cloudTitle', 'Use cloud AI?'),
                    cancel: copyRef.current('cancel', 'Cancel'),
                    confirm: copyRef.current('editorFeedback.cloudOnce', 'Use Cloud Once'),
                  },
                ] as const)
              : ([] as const)),
          );
          return;
        }

        gateAndRun(routing);
      },
      [
        note?.isPrivate,
        notesMode,
        notesProviderId,
        providerNotes,
        registerSuperwallGate,
        formattingRequiresCloudConfirmation,
        runSelectedAction,
        user,
        copyRef,
        router,
        activeMode,
      ],
    );

    const handleRunAction = useCallback(
      (action: Parameters<typeof runAction>[0]) => {
        const isCurrent = captureAIContext();
        // Decide from the notes on screen: an edit typed since the last save counts too.
        flushEnhancedSave();
        // Android replaces the summary straight away and offers Undo afterwards (Figma E5).
        if (platform || !getNoteById(noteId)?.enhancedContent?.trim()) {
          runActionWithRouting(action, isCurrent).catch(() => {});
          return;
        }
        confirmDestructive(
          copyRef.current('editorFeedback.replaceTitle', 'Replace enhanced notes?'),
          copyRef.current(
            'editorFeedback.replaceBody',
            'Running this action replaces the current enhanced notes, including any edits.',
          ),
          () => runActionWithRouting(action, isCurrent),
          {
            destructiveLabel: copyRef.current('editorFeedback.replaceAction', 'Replace'),
            ...(platform ? { cancelLabel: copyRef.current('cancel', 'Cancel') } : {}),
          },
        );
      },
      [captureAIContext, flushEnhancedSave, getNoteById, noteId, runActionWithRouting, copyRef],
    );

    const handleDelete = useCallback(() => {
      if (platform) {
        // D1: no dialog. Back to the list, where a toast offers Undo for 6 s.
        flushDraft();
        setMenuVisible(false);
        if (router.canGoBack()) router.back();
        else router.replace(stack.root);
        deleteNotesWithUndo([noteId], titleRef.current);
        return;
      }
      confirmDestructive(
        copy('library.deleteNote', 'Delete Note'),
        copy('library.deleteNoteBody', 'This note will be deleted permanently.'),
        () => {
          safeHaptics('warning');
          deleteNote(noteId);
          if (router.canGoBack()) router.back();
        },
        ...(platform
          ? ([
              {
                cancelLabel: copy('cancel', 'Cancel'),
                destructiveLabel: copy('deleteAction', 'Delete'),
              },
            ] as const)
          : ([] as const)),
      );
    }, [copy, deleteNote, noteId, router, flushDraft, stack.root]);

    const handleRetryTranscript = useCallback(async () => {
      if (!note || isRetryingTranscript) return;
      safeHaptics('medium');
      setIsRetryingTranscript(true);
      try {
        await retryMeetingTranscription(note.id);
      } catch (error) {
        Alert.alert(
          copy('editor.retryFailed', 'Retry failed'),
          error instanceof Error
            ? error.message
            : copy('editor.retryBody', 'Could not retry this transcription.'),
        );
      } finally {
        setIsRetryingTranscript(false);
      }
    }, [copy, isRetryingTranscript, note, retryMeetingTranscription]);

    const handleSpeakerPress = useCallback(
      (block: TranscriptBlock) => {
        if (block.speakerId == null) return;
        setActiveSpeakerId(block.speakerId);
        safeHaptics('selection');
        if (block.speakerStatus === 'suggested') {
          setSuggestionSheetVisible(true);
          return;
        }
        Alert.alert(block.speakerName, undefined, [
          {
            text: copy('speakerControls.renameAction', 'Rename'),
            onPress: () => setRenameSheetVisible(true),
          },
          {
            text: copy('speakerControls.mergeAction', 'Merge'),
            onPress: () => setMergeSheetVisible(true),
          },
          { text: copy('cancel', 'Cancel'), style: 'cancel' },
        ]);
      },
      [copy],
    );

    const handleConfirmSuggestion = useCallback(() => {
      if (activeSpeakerId == null) return;
      confirmSpeakerSuggestion(noteId, activeSpeakerId);
      setSuggestionSheetVisible(false);
      setActiveSpeakerId(null);
      safeHaptics('success');
    }, [activeSpeakerId, confirmSpeakerSuggestion, noteId]);

    const handleRejectSuggestion = useCallback(() => {
      if (activeSpeakerId == null) return;
      rejectSpeakerSuggestion(noteId, activeSpeakerId);
      setSuggestionSheetVisible(false);
      setActiveSpeakerId(null);
      safeHaptics('warning');
    }, [activeSpeakerId, noteId, rejectSpeakerSuggestion]);

    const handleRenameSpeaker = useCallback(
      (displayName: string) => {
        if (activeSpeakerId == null) return;
        renameSpeaker(noteId, activeSpeakerId, displayName);
        setRenameSheetVisible(false);
        setSuggestionSheetVisible(false);
      },
      [activeSpeakerId, noteId, renameSpeaker],
    );

    const handleMergeSpeaker = useCallback(
      (sourceSpeakerId: number, targetSpeakerId: number) => {
        mergeSpeakers(noteId, sourceSpeakerId, targetSpeakerId);
        setMergeSheetVisible(false);
        setSuggestionSheetVisible(false);
        setActiveSpeakerId(null);
      },
      [mergeSpeakers, noteId],
    );

    const contentEmpty = !actionInputText.trim();

    // A deleted note can still be opened from a chat's source link. Both stacks hide the native
    // header and the tab bar here, so the back button is the only way out.
    if (!note && !isNaN(noteId)) {
      return (
        <View className="flex-1 bg-systemBackground">
          <TabScreenHeader title="" left={<GlassBackButton fallbackRoute={stack.root} />} />
          <View className="flex-1 items-center justify-center">
            <Text className="text-tertiaryLabel">
              {copy('editorFeedback.noteNotFound', 'Note not found')}
            </Text>
          </View>
        </View>
      );
    }

    const actionInputHash = makeContentHash(actionInputText);
    const generatedMeetingInputHash =
      usesSegmentTranscript && note?.calendarEventId
        ? makeContentHash(generatedMeetingInputText)
        : actionInputHash;
    // The note row stores the input hash, not the action id. Accept either hash so
    // custom actions (plain input) and default generated meeting notes (calendar context input)
    // both avoid false stale markers without depending on the async action store.
    const isStale =
      hasEnhanced &&
      note?.enhancedAtContentHash !== actionInputHash &&
      note?.enhancedAtContentHash !== generatedMeetingInputHash;
    const isEnhancing = processingState === 'processing';

    const speakerSheets = (
      <>
        <SpeakerRenameSheet
          visible={renameSheetVisible}
          initialName={activeSpeakerName}
          suggestions={attendeeSpeakerSuggestions}
          onCancel={() => setRenameSheetVisible(false)}
          onSave={handleRenameSpeaker}
        />
        <SpeakerMergeSheet
          visible={mergeSheetVisible}
          sourceSpeaker={activeSpeaker}
          speakers={speakers}
          onCancel={() => setMergeSheetVisible(false)}
          onMerge={handleMergeSpeaker}
        />
        <VoiceprintSuggestionSheet
          visible={suggestionSheetVisible}
          speakerName={activeSpeakerName}
          onConfirm={handleConfirmSuggestion}
          onReject={handleRejectSuggestion}
          onRename={() => {
            setSuggestionSheetVisible(false);
            setRenameSheetVisible(true);
          }}
          onMerge={() => {
            setSuggestionSheetVisible(false);
            setMergeSheetVisible(true);
          }}
          onCancel={() => setSuggestionSheetVisible(false)}
        />
      </>
    );

    // ——— Figma E1–E7: the open note in OpenWhispr's design language ———
    const defaultAction = actions.find((action) => action.isDefault === 1) ?? actions[0] ?? null;
    const templateKey = templateOfNote(note?.enhancementPrompt, actions);
    const templateLabel = nameOfTemplate(templateKey, actions);
    const previousSummary = () => {
      const saved = getNoteById(noteId);
      return {
        enhancedContent: saved?.enhancedContent ?? null,
        enhancementPrompt: saved?.enhancementPrompt ?? null,
        hash: saved?.enhancedAtContentHash ?? null,
      };
    };
    const runTemplate = (key: string) => {
      setTemplateVisible(false);
      // A summary edit still waiting to save is what Undo must bring back.
      flushEnhancedSave();
      const own = key.startsWith('action:')
        ? (actions.find((action) => `action:${action.id}` === key) ?? null)
        : null;
      const builtIn = BUILT_IN_TEMPLATES.find((template) => template.key === key);
      const action = own ?? (builtIn ? templateAction(builtIn, defaultAction) : defaultAction);
      if (!action) return;
      rewriteRef.current = {
        kind: 'template',
        name: nameOfTemplate(key, actions),
        previous: previousSummary(),
      };
      setViewMode('enhanced');
      handleRunAction(action);
    };
    const runRewrite = (kind: 'shorter' | 'longer') => {
      flushEnhancedSave();
      const summary = getNoteById(noteId)?.enhancedContent?.trim();
      if (!summary) return;
      rewriteRef.current = { kind, name: '', previous: previousSummary() };
      summaryInputRef.current = summary;
      handleRunAction(rewriteAction(kind));
    };
    const copySummary = () => {
      handleCopyGeneratedNote();
      showToast(notesT('copied'));
    };
    const exportText = (parts: ExportPart[]): string => {
      flushEnhancedSave();
      const saved = getNoteById(noteId);
      const sections: string[] = [];
      if (parts.includes('summary') && saved?.enhancedContent?.trim())
        sections.push(saved.enhancedContent.trim());
      if (parts.includes('notes') && contentRef.current.trim())
        sections.push(contentRef.current.trim());
      if (parts.includes('transcript') && transcriptBlocks.length > 0)
        sections.push(formatTranscriptForExport({ blocks: transcriptBlocks }));
      return sections.join('\n\n');
    };
    const exportParts: ExportPart[] = [
      ...(hasEnhanced ? (['summary'] as const) : []),
      ...(content.trim() && !contentIsTranscript ? (['notes'] as const) : []),
      ...(usesSegmentTranscript || contentIsTranscript ? (['transcript'] as const) : []),
    ];
    const people = attendees
      .filter((person) => !person.self && !person.resource)
      .map((person) => ({ name: person.displayName, email: person.email }));
    const dateLabel = formatNoteMetaDate(
      noteTakenAt(note?.createdAt, note?.cloudUpdatedAt ?? note?.updatedAt),
      new Date(),
      {
        language,
        today: copy('library.today', 'Today'),
        yesterday: copy('library.yesterday', 'Yesterday'),
      },
    );
    const durationMinutes =
      note?.audioDurationSeconds && note.audioDurationSeconds > 0
        ? Math.max(1, Math.round(note.audioDurationSeconds / 60))
        : null;
    const isTeamNote = noteSpace?.kind === 'team';
    const tabs: { key: NoteTab; label: string; dot?: boolean }[] = [
      { key: 'enhanced', label: notesT('summary'), dot: isStale },
      {
        key: 'notes',
        label: contentIsTranscript ? notesT('transcript') : notesT('myNotes'),
      },
      ...(isAudioTranscript && !contentIsTranscript
        ? [{ key: 'transcript' as const, label: notesT('transcript') }]
        : []),
    ];
    const shownTab: NoteTab = tabs.some((tab) => tab.key === viewMode)
      ? (viewMode as NoteTab)
      : 'enhanced';
    const nothingToSummarize = contentEmpty && !usesSegmentTranscript;
    const formatNotes = (kind: 'bold' | 'italic' | 'bullet' | 'check' | 'heading') => {
      const result = applyFormat(contentRef.current, selectionRef.current, kind);
      handleContentChange(result.text);
      setSelection({ start: result.caret, end: result.caret });
    };

    return (
      <Root
        style={{ flex: 1, backgroundColor: notesLook.canvas }}
        behavior="padding"
        // Android's hidden keyboard height includes system bars.
        enabled={keyboardHeight > 0}
      >
        <View
          style={{
            flex: 1,
            paddingTop: insets.top,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          }}
        >
          {shareVisible ? (
            <NoteShareSheet
              noteId={noteId}
              onClose={() => setShareVisible(false)}
              onFlushDraft={() => {
                flushDraft();
                flushEnhancedSave();
              }}
              onExport={handleExport}
            />
          ) : null}
          <NoteTopBar
            onShare={() => {
              flushDraft();
              setExportVisible(true);
            }}
            onMore={() => {
              flushDraft();
              setMenuVisible(true);
            }}
          />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 8,
              paddingBottom: keyboardHeight > 0 ? 16 : insets.bottom + 48,
              gap: 12,
            }}
          >
            <TextInput
              ref={titleInputRef}
              // A placeholder title ("Untitled") shows as the empty field it stands for.
              value={title.trim().toLowerCase() === 'untitled' ? '' : title}
              onChangeText={handleTitleChange}
              placeholder={notesT('titlePlaceholder')}
              placeholderTextColor={homeTokens.tertiary}
              multiline
              style={{
                fontFamily: AppFont.medium,
                fontSize: 28,
                lineHeight: 36,
                color: homeTokens.text,
                padding: 0,
              }}
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <MetaChip
                icon="Calendar"
                label={durationMinutes ? `${dateLabel} · ${durationMinutes} min` : dateLabel}
              />
              {folderName ? (
                <MetaChip
                  testID="note-folder-chip"
                  icon="Folder"
                  label={folderName}
                  onPress={note && !isSpaceUnknown ? () => move.open(note.id) : undefined}
                />
              ) : null}
              <AttendeeCircles people={people} onPress={() => setAttendeesVisible(true)} />
              {note?.calendarEventId ? (
                <MetaChip
                  icon="CalendarDays"
                  label={notesT('inCalendar', {
                    title: (title || notesT('untitled')).split(/\s+/).slice(0, 2).join(' '),
                  })}
                />
              ) : null}
            </View>

            {conflict ? (
              <ConflictBanner
                canUseServerCopy={conflict.conflictServerNote != null}
                onKeepMine={handleKeepMine}
                onUseServer={handleUseServerCopy}
              />
            ) : null}

            {showVoiceSetupBanner ? (
              <VoiceSetupBanner
                onSetUp={() => setVoiceSetupVisible(true)}
                onDismiss={dismissVoiceSetup}
              />
            ) : null}

            <NoteTabs
              tabs={tabs}
              value={shownTab}
              onChange={(tab) => {
                safeHaptics('selection');
                setViewMode(tab);
              }}
            />

            {shownTab === 'enhanced' ? (
              isEnhancing ? (
                <View style={[edgeCard, { padding: 16, gap: 12 }]}>
                  <View style={{ flexDirection: 'row' }}>
                    <SoftChip label={notesT('writing')} icon="Sparkles" />
                  </View>
                  <Shimmer />
                </View>
              ) : hasEnhanced || enhancedEditing ? (
                <View style={[edgeCard, { padding: 16, gap: 12, overflow: 'visible' }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <SoftChip
                      testID="template-chip"
                      label={templateLabel}
                      icon="Sparkles"
                      trailing="ChevronDown"
                      onPress={() => setTemplateVisible(true)}
                    />
                    <View style={{ flex: 1 }} />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={notesT('copySummary')}
                      hitSlop={10}
                      onPress={copySummary}
                      style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.5 : 1 })}
                    >
                      <SystemIcon
                        name="doc.on.doc"
                        mdName="Copy"
                        size={18}
                        color={homeTokens.secondary}
                      />
                    </Pressable>
                  </View>
                  <EditableMarkdown
                    key={`${noteId}-${enhancedEditorRevision}`}
                    content={note?.enhancedContent ?? ''}
                    editable={!isEnhancing}
                    onChange={handleEnhancedChange}
                    onEditingChange={handleEnhancedEditingChange}
                    showEditButton={false}
                  />
                  <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                    <SoftChip
                      testID="make-shorter"
                      label={notesT('makeShorter')}
                      onPress={() => runRewrite('shorter')}
                    />
                    <SoftChip
                      testID="make-longer"
                      label={notesT('makeLonger')}
                      onPress={() => runRewrite('longer')}
                    />
                  </View>
                </View>
              ) : (
                <NoSummaryCard
                  body={notesT(isAudioTranscript ? 'noSummaryBody' : 'noSummaryBodyNote')}
                  templateName={templateLabel}
                  disabled={nothingToSummarize || transcriptPending}
                  onWrite={() => runTemplate(templateKey)}
                  onTemplate={() => setTemplateVisible(true)}
                />
              )
            ) : shownTab === 'notes' ? (
              <View style={[edgeCard, { paddingHorizontal: 16, paddingVertical: 12 }]}>
                {transcriptStatus === 'recording' ? (
                  <Text style={{ fontSize: 13, lineHeight: 18, color: homeTokens.secondary }}>
                    {copy(
                      'editor.recordingNotes',
                      'You can edit these notes once the recording stops.',
                    )}
                  </Text>
                ) : null}
                <TextInput
                  ref={contentInputRef}
                  testID="note-content-input"
                  value={content}
                  onChangeText={handleContentChange}
                  selection={selection}
                  onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
                  onFocus={() => setNotesFocused(true)}
                  onBlur={() => setNotesFocused(false)}
                  placeholder={notesT('notesPlaceholder')}
                  placeholderTextColor={homeTokens.tertiary}
                  multiline
                  // The recording screen still writes these notes until the recording stops.
                  editable={!isEnhancing && transcriptStatus !== 'recording'}
                  textAlignVertical="top"
                  style={{
                    minHeight: 160,
                    fontFamily: AppFont.regular,
                    fontSize: 16,
                    lineHeight: 26,
                    color: homeTokens.text,
                    padding: 0,
                  }}
                />
              </View>
            ) : shouldShowTranscriptStatus ? (
              <View
                style={[
                  edgeCard,
                  { padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
                ]}
              >
                <ActivityIndicator size="small" color={BRAND} />
                <Text style={{ fontSize: 15, color: homeTokens.secondary }}>
                  {copy(
                    `editor.${transcriptStatus === 'recording' ? 'recording' : transcriptStatus === 'transcribing' ? 'transcribing' : transcriptStatus === 'diarizing' ? 'diarizing' : 'preparing'}`,
                    transcriptStatusText(transcriptStatus),
                  )}
                </Text>
              </View>
            ) : shouldShowTranscriptFailed ? (
              <View style={{ gap: 12 }}>
                <View style={[edgeCard, { padding: 16, gap: 8 }]}>
                  <Text style={[notesLook.rowTitle]}>
                    {hasTranscriptSegments
                      ? incompleteTranscript()
                      : copy('editor.transcriptFailed', 'Transcript failed')}
                  </Text>
                  <Text style={{ fontSize: 14, lineHeight: 20, color: homeTokens.secondary }}>
                    {copy(
                      'editor.processingUnfinished',
                      'Audio processing did not finish for this note.',
                    )}
                  </Text>
                  {note && isManagedMeetingAudioUri(note.id, note.sourceFile) ? (
                    <Pressable
                      onPress={handleRetryTranscript}
                      disabled={isRetryingTranscript}
                      accessibilityRole="button"
                      style={({ pressed }) => ({
                        marginTop: 4,
                        minHeight: 44,
                        justifyContent: 'center',
                        opacity: pressed || isRetryingTranscript ? 0.6 : 1,
                      })}
                    >
                      {isRetryingTranscript ? (
                        <ActivityIndicator size="small" color={BRAND} />
                      ) : (
                        <Text style={{ color: homeTokens.accent, fontSize: 16, fontWeight: '600' }}>
                          {copy('editor.retryTranscript', 'Retry transcription')}
                        </Text>
                      )}
                    </Pressable>
                  ) : (
                    <Text style={{ fontSize: 13, lineHeight: 18, color: homeTokens.tertiary }}>
                      {copy(
                        'editor.audioUnavailable',
                        'The original audio is no longer available, so this transcript cannot be retried.',
                      )}
                    </Text>
                  )}
                </View>
                {hasTranscriptSegments ? (
                  <TranscriptCard blocks={transcriptBlocks} onSpeakerPress={handleSpeakerPress} />
                ) : null}
              </View>
            ) : (
              <TranscriptCard
                blocks={transcriptBlocks}
                onSpeakerPress={handleSpeakerPress}
                onWordLongPress={(word, x, y) =>
                  setFixTarget({
                    word,
                    x,
                    y,
                    count: transcriptBlocks.reduce(
                      (sum, block) => sum + countWord(block.text, word),
                      0,
                    ),
                  })
                }
                highlight={fixTarget?.word}
                onCopy={() => {
                  Clipboard.setStringAsync(transcriptText)
                    .then(() => showToast(notesT('copied')))
                    .catch(() => undefined);
                }}
              />
            )}
          </ScrollView>
          {notesFocused && keyboardHeight > 0 && shownTab === 'notes' ? (
            <FormatBar onFormat={formatNotes} onDone={() => contentInputRef.current?.blur()} />
          ) : null}
        </View>
        <FixWordCard
          target={fixTarget}
          onClose={() => setFixTarget(null)}
          onSave={(from, to) => applyTranscriptFix({ id: noteId, title }, from, to)}
        />
        <NoteMenuSheet
          visible={menuVisible}
          onClose={() => setMenuVisible(false)}
          title={title || notesT('untitled')}
          folderName={folderName}
          backedUp={isTeamNote || note?.isPrivate !== 1}
          canBackUp={!!user && !isTeamNote}
          hasSummary={hasEnhanced}
          onShare={() => {
            setMenuVisible(false);
            setExportVisible(true);
          }}
          onExport={() => {
            setMenuVisible(false);
            setExportVisible(true);
          }}
          onCopySummary={() => {
            setMenuVisible(false);
            copySummary();
          }}
          onMove={
            note && !isSpaceUnknown
              ? () => {
                  setMenuVisible(false);
                  move.open(note.id);
                }
              : undefined
          }
          onBackUp={(value) => {
            useNotesStore
              .getState()
              .setNotePrivacy(noteId, !value)
              .catch(() => undefined);
          }}
          onDelete={handleDelete}
        />
        {exportVisible ? (
          <ShareAndExport
            noteId={noteId}
            signedIn={!!user}
            parts={exportParts.length > 0 ? exportParts : ['notes']}
            onClose={() => setExportVisible(false)}
            onFlushDraft={() => {
              flushDraft();
              flushEnhancedSave();
            }}
            onOpenSharing={() => {
              setExportVisible(false);
              if (user) setShareVisible(true);
              else router.push('/auth?reason=share');
            }}
            onSend={(parts) => {
              setExportVisible(false);
              Share.share({ title: title || notesT('untitled'), message: exportText(parts) }).catch(
                () => undefined,
              );
            }}
            onSaveMarkdown={(parts) => {
              setExportVisible(false);
              exportNote(
                { title: title || notesT('untitled'), content: exportText(parts) },
                'md',
              ).catch(() => undefined);
            }}
          />
        ) : null}
        <TemplateSheet
          visible={templateVisible}
          onClose={() => setTemplateVisible(false)}
          current={templateKey}
          actions={actions}
          hasSummary={hasEnhanced}
          onPick={runTemplate}
        />
        <CloudOnceSheet
          visible={cloudSheet != null}
          onClose={() => setCloudSheet(null)}
          body={cloudSheet?.body ?? ''}
          onUseCloud={() => {
            const use = cloudSheet?.onUse;
            setCloudSheet(null);
            use?.();
          }}
          onDownload={
            cloudSheet?.onDownload
              ? () => {
                  const download = cloudSheet.onDownload;
                  setCloudSheet(null);
                  download?.();
                }
              : undefined
          }
        />
        <AttendeesSheet
          visible={attendeesVisible}
          participants={attendees}
          onClose={() => setAttendeesVisible(false)}
        />
        {/* Hidden in the render where the Space disappears, before the picker is closed. */}
        {isSpaceUnknown ? null : <MoveToFolderSheet {...move.sheetProps} />}
        {speakerSheets}
        <ThatsMeSheet
          visible={voiceSetupVisible}
          candidates={voiceCandidates}
          onClaim={handleClaimVoice}
          onReadScript={handleReadVoiceScript}
          onClose={() => setVoiceSetupVisible(false)}
          onDismissed={handleVoiceSetupDismissed}
        />
      </Root>
    );
  };
}

/** E7 with the note's link state: Copy when a link already exists, else one tap to share. */
function ShareAndExport({
  noteId,
  signedIn,
  parts,
  onClose,
  onFlushDraft,
  onOpenSharing,
  onSend,
  onSaveMarkdown,
}: {
  noteId: number;
  signedIn: boolean;
  parts: ExportPart[];
  onClose: () => void;
  onFlushDraft: () => void;
  onOpenSharing: () => void;
  onSend: (parts: ExportPart[]) => void;
  onSaveMarkdown: (parts: ExportPart[]) => void;
}) {
  const sharing = useNoteSharing(noteId, onFlushDraft);
  const linkRow = !signedIn
    ? { title: notesT('signInToShare'), subtitle: notesT('shareALinkBody'), onPress: onOpenSharing }
    : sharing.hasLink
      ? {
          title: notesT('anyoneWithLink'),
          subtitle: notesT('canView'),
          onPress: onOpenSharing,
          action: {
            label: notesT('copy'),
            onPress: () => {
              sharing
                .copyLink()
                .then(() => showToast(notesT('copied')))
                .catch(() => undefined);
            },
          },
        }
      : { title: notesT('shareALink'), subtitle: notesT('shareALinkBody'), onPress: onOpenSharing };
  return (
    <ShareExportSheet
      visible
      onClose={onClose}
      parts={parts}
      linkRow={linkRow}
      onPeople={signedIn ? onOpenSharing : undefined}
      onSend={onSend}
      onSaveMarkdown={onSaveMarkdown}
    />
  );
}
