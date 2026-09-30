import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { isMicPermissionError, showMicPermissionAlert } from '@/lib/permissions';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useNotesStore } from '@/store/useNotesStore';
import { useActionsStore } from '@/store/useActionsStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useUsageStore } from '@/store/useUsageStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useDictionaryStore } from '@/store/useDictionaryStore';
import { extractCorrections } from '@/lib/correctionLearner';
import { useActionProcessing } from '@/hooks/useActionProcessing';
import { useAudioRecording } from '@/hooks/useAudioRecording';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { useUsageLimitRecovery } from '@/hooks/useUsageLimitRecovery';
import { EditableMarkdown } from '@/components/notes/EditableMarkdown';
import {
  defaultNoteBodyView,
  getNoteBodyTabLabel,
  getNoteBodyTabs,
  resolveNoteBodyView,
  type NoteBodyView,
} from '@/lib/notes/noteBodyTabs';
import { NoteShareSheet } from '@/components/notes/NoteShareSheet';
import { NoteActionsMenu } from '@/components/notes/NoteActionsMenu';
import { ConflictBanner } from '@/components/notes/ConflictBanner';
import { VoiceSetupBanner } from '@/components/notes/VoiceSetupBanner';
import { ThatsMeSheet } from '@/components/notes/ThatsMeSheet';
import { shouldOfferVoiceSetup, voiceSetupCandidates } from '@/lib/notes/voiceSetupPrompt';
import { SpeakerProfileOwnerAlreadyExistsError } from '@/data/local/notesRepository';
import { VOICE_ALREADY_TAUGHT_ALERT } from '@/lib/voiceEnrollmentMessages';
import { NoteChatSheet } from '@/components/notes/NoteChatSheet';
import { isDictationAgentEnabled } from '@/lib/dictationAgent';
import { SpeakerTranscript } from '@/components/notes/SpeakerTranscript';
import { TranscriptSheet } from '@/components/notes/TranscriptSheet';
import { NoteMetaRow } from '@/components/notes/NoteMetaRow';
import { AttendeesSheet } from '@/components/notes/AttendeesSheet';
import { MoveToFolderSheet } from '@/components/notes/MoveToFolderSheet';
import { useMoveNote } from '@/hooks/useMoveNote';
import {
  formatAttendeeChipLabel,
  formatNoteMetaDate,
  markViewer,
  noteTakenAt,
} from '@/lib/notes/noteMeta';
import { SpeakerRenameSheet } from '@/components/notes/SpeakerRenameSheet';
import { SpeakerMergeSheet } from '@/components/notes/SpeakerMergeSheet';
import { VoiceprintSuggestionSheet } from '@/components/notes/VoiceprintSuggestionSheet';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GradientGlassSurface } from '@/components/ui/GradientGlassSurface';
import { Glass } from '@/components/ui/Glass';
import { GlassBackButton } from '@/components/ui/GlassBackButton';
import { TabScreenHeader } from '@/components/ui/TabScreenHeader';
import { buildNoteShareContent, exportNote } from '@/lib/noteExport';
import { AppFont } from '@/lib/fonts';
import { makeContentHash, safeHaptics } from '@/lib/utils';
import { isManagedMeetingAudioUri } from '@/lib/transcriptAudio';
import { BRAND } from '@/config/colors';
import {
  cloudModeRequiresAccount,
  handleAccountRequiredError,
  requiresRealAccount,
  showAccountRequiredAlert,
} from '@/lib/accountAccess';
import { promptLocalModelFallback } from '@/lib/privateMode';
import {
  getLocalReasoningReadiness,
  getLocalReasoningUnavailableMessage,
  isLocalContextLimitError,
  isLocalReasoningRequired,
  shouldUseLocalReasoning,
} from '@/lib/localReasoning';
import { providerDisplayName } from '@/lib/mobileProviders';
import { promptLocalReasoningFallback } from '@/lib/localReasoningFallback';
import { confirmCloudOnce, confirmDestructive } from '@/lib/alerts';
import { randomUUID } from '@/lib/uuid';
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
import { buildNoteChatContext, type ChatOverNoteMessage } from '@/lib/notes/chatOverNote';
import { getNoteChatSuggestions } from '@/lib/notes/noteChatSuggestions';
import {
  formatTranscriptForExport,
  getSpeakerDisplayName,
  groupTranscriptSegments,
  type TranscriptBlock,
} from '@/lib/diarization/transcriptDisplay';

const NOTE_EDITOR_BOTTOM_PADDING = 180;
const NOTE_EDITOR_KEYBOARD_BOTTOM_PADDING = 8;

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

export default function NoteEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const noteId = parseInt(id ?? '', 10);
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
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const { register: registerSuperwallGate } = useSuperwallGate();
  const { handleUsageLimitReached, isRecoveringUsageLimit } = useUsageLimitRecovery();
  const autoLearnEnabled = useConfigStore((s) => s.config?.autoLearnCorrections ?? true);
  const notesMode = useConfigStore((s) => s.config?.inference?.notes?.mode);
  const notesProviderId = useConfigStore((s) => s.config?.inference?.notes?.providerId);
  const chatMode = useConfigStore((s) => s.config?.inference?.agent?.mode);
  // Note chat shares the Chat & Voice Assistant switch with the voice assistant.
  const chatEnabled = useConfigStore((s) => (s.config ? isDictationAgentEnabled(s.config) : true));
  const providerNotes = notesMode === 'providers';
  // Only an unset or OpenWhispr chat route reaches Cloud, so only it needs an account and the paywall.
  const cloudChat = chatMode !== 'providers' && chatMode !== 'local';
  const dictionaryEntries = useDictionaryStore((s) => s.entries);
  const dictionaryWords = useMemo(() => dictionaryEntries.map((e) => e.word), [dictionaryEntries]);
  const addLearnedWords = useDictionaryStore((s) => s.addLearnedWords);

  const actions = useActionsStore((s) => s.actions);
  const initializeActions = useActionsStore((s) => s.initialize);

  const [title, setTitle] = useState(note?.title ?? '');
  const [content, setContent] = useState(note?.content ?? '');
  // The user's last tab pick; resolveNoteBodyView maps it onto the tabs this note has now.
  const [viewMode, setViewMode] = useState<NoteBodyView>(() =>
    defaultNoteBodyView({
      isAudioTranscript: isAudioTranscriptNote(note),
      hasEnhanced: !!note?.enhancedContent,
    }),
  );
  const [selection, setSelection] = useState<{ start: number; end: number }>({
    start: (note?.content ?? '').length,
    end: (note?.content ?? '').length,
  });
  const [activeSpeakerId, setActiveSpeakerId] = useState<number | null>(null);
  const [renameSheetVisible, setRenameSheetVisible] = useState(false);
  const [mergeSheetVisible, setMergeSheetVisible] = useState(false);
  const [suggestionSheetVisible, setSuggestionSheetVisible] = useState(false);
  const [chatVisible, setChatVisible] = useState(false);
  const [transcriptSheetVisible, setTranscriptSheetVisible] = useState(false);
  const [attendeesVisible, setAttendeesVisible] = useState(false);
  const [enhancedEditing, setEnhancedEditing] = useState(false);
  // Bumped to remount the generated-notes editor when its draft must be thrown away.
  const [enhancedEditorRevision, setEnhancedEditorRevision] = useState(0);
  const [shareVisible, setShareVisible] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatOverNoteMessage[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatLastQuestion, setChatLastQuestion] = useState('');
  const [isChatProcessing, setIsChatProcessing] = useState(false);
  const [isRetryingTranscript, setIsRetryingTranscript] = useState(false);
  const keyboardHeight = useKeyboardHeight();
  const insets = useSafeAreaInsets();

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
  const dictionaryWordsRef = useRef(dictionaryWords);
  dictionaryWordsRef.current = dictionaryWords;
  const chatAbortRef = useRef<AbortController | null>(null);

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
      setViewMode(
        defaultNoteBodyView({
          isAudioTranscript: isAudioTranscriptNote(note),
          hasEnhanced: !!note.enhancedContent,
        }),
      );
    }
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    setChatVisible(false);
    setTranscriptSheetVisible(false);
    setRenameSheetVisible(false);
    setMergeSheetVisible(false);
    setSuggestionSheetVisible(false);
    setActiveSpeakerId(null);
    setAttendeesVisible(false);
    setEnhancedEditing(false);
    setShareVisible(false);
    setChatMessages([]);
    setChatDraft('');
    setChatError(null);
    setChatLastQuestion('');
    setIsChatProcessing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  useEffect(
    () => () => {
      chatAbortRef.current?.abort();
      chatAbortRef.current = null;
    },
    [],
  );

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
    if (contentRef.current === originalContentRef.current && note.content !== contentRef.current) {
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
  const showVoiceSetupBanner = shouldOfferVoiceSetup({
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
  const attendeeLabel = formatAttendeeChipLabel(attendees);
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
  const chatContextText = buildNoteChatContext({
    generatedNotes: note?.enhancedContent,
    sourceText: actionInputText,
  });
  const chatContextRef = useRef(chatContextText);
  chatContextRef.current = chatContextText;
  const generatedMeetingInputRef = useRef(generatedMeetingInputText);
  generatedMeetingInputRef.current = generatedMeetingInputText;
  const lastEnhancementInputHashRef = useRef('');
  const usesSegmentTranscriptRef = useRef(usesSegmentTranscript);
  usesSegmentTranscriptRef.current = usesSegmentTranscript;
  // Desktop stores an uploaded file's flat transcript as the note body.
  const contentIsTranscript = note?.noteType === 'upload';
  // Notes typed beside a recording, never the transcript itself.
  const hasTypedMeetingNotes = isAudioTranscript && !contentIsTranscript;
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
    isAudioTranscript && !hasTranscriptSegments && transcriptStatus === 'failed';
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
      usesSegmentTranscript,
      transcriptPending,
      contentIsTranscript,
      hasEnhanced: hasEnhancedTab,
    }),
    [contentIsTranscript, hasEnhancedTab, transcriptPending, usesSegmentTranscript],
  );
  const requiresCloudConfirmation = note?.isPrivate === 1 || activeMode === 'private';

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
          Alert.alert(...VOICE_ALREADY_TAUGHT_ALERT);
        } else {
          Alert.alert(
            "Couldn't save your voice",
            'Read a short script instead to teach OpenWhispr your voice.',
          );
        }
        return false;
      }
    },
    [claimSpeakerAsMe, loadVoiceProfiles, noteId],
  );

  const openVoiceScript = useCallback(() => {
    router.push(`/(tabs)/(notes)/voice-enrollment?owner=1&noteId=${noteId}`);
  }, [noteId, router]);

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
      const corrections = extractCorrections(baseline, newContent, dictionaryWordsRef.current);
      if (corrections.length > 0) {
        addLearnedWords(corrections);
      }
      learnedBaselineRef.current = newContent;
    },
    [addLearnedWords],
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
      setViewMode(
        defaultNoteBodyView({
          isAudioTranscript: isAudioTranscriptNote(refreshed),
          hasEnhanced: !!refreshed.enhancedContent,
        }),
      );
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
      updateNote(noteId, updates);
      setViewMode('enhanced');
    },
    [noteId, updateNote],
  );

  const handleEnhanceError = useCallback((message: string, error: unknown) => {
    if (handleAccountRequiredError(error, 'AI actions', { cloudOnly: true })) return;
    Alert.alert('Action failed', message);
  }, []);

  const { state: processingState, runAction } = useActionProcessing({
    onSuccess: handleEnhanceSuccess,
    onError: handleEnhanceError,
  });

  const handleDictationComplete = useCallback(
    (text: string) => {
      if (usesSegmentTranscriptRef.current) return;
      const current = contentRef.current;
      const { start, end } = selectionRef.current;
      const safeStart = Math.min(Math.max(start, 0), current.length);
      const safeEnd = Math.min(Math.max(end, safeStart), current.length);
      const newContent = current.slice(0, safeStart) + text + current.slice(safeEnd);
      const newCursor = safeStart + text.length;
      setContent(newContent);
      setSelection({ start: newCursor, end: newCursor });
      // Re-root the learner baseline to the freshly-dictated text so we only
      // learn from user edits performed after this dictation.
      learnedBaselineRef.current = newContent;
      // The save reads the ref, and an unmounted editor never re-renders to update it.
      contentRef.current = newContent;
      debouncedSave();
      safeHaptics('success');
      if (useProcessingModeStore.getState().activeMode === 'cloud') {
        useUsageStore.getState().load(true);
      }
    },
    [debouncedSave],
  );

  const handleDictationError = useCallback((error: Error) => {
    if (isMicPermissionError(error)) {
      // Only redirect to Settings when iOS couldn't show its own prompt —
      // see the matching comment in HomeScreen's onError.
      if (!error.nativePromptShown) {
        showMicPermissionAlert();
      }
      return;
    }
    Alert.alert('Dictation failed', error.message);
  }, []);

  const { isRecording, isProcessing, currentText, startRecording, stopRecording } =
    useAudioRecording({
      onComplete: handleDictationComplete,
      onError: handleDictationError,
      onLocalModelMissing: promptLocalModelFallback,
      onUsageLimitReached: handleUsageLimitReached,
    });

  const handleDictate = useCallback(async () => {
    safeHaptics('medium');
    if (isRecording) {
      await stopRecording();
      return;
    }
    if (cloudModeRequiresAccount(activeMode, user)) {
      showAccountRequiredAlert('dictation');
      return;
    }
    try {
      if (activeMode === 'cloud' && user) {
        await registerSuperwallGate({
          placement: SUPERWALL_PLACEMENTS.noteDictationStart,
          params: { source: 'note_editor' },
          requiresAccount: false,
          feature: () => {
            startRecording().catch(() => {});
          },
        });
        return;
      }
      await startRecording();
    } catch {
      // Hook's onError → handleDictationError already surfaced this to the user.
    }
  }, [activeMode, isRecording, registerSuperwallGate, startRecording, stopRecording, user]);

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
      ).catch(() => Alert.alert('Export failed', 'Could not export this note. Please try again.'));
    },
    [bodyTabInput, flushEnhancedSave, getNoteById, noteId, transcriptBlocks, viewMode],
  );

  const handleViewTranscript = useCallback(() => {
    safeHaptics('light');
    setTranscriptSheetVisible(true);
  }, []);

  const handleCopyGeneratedNote = useCallback(() => {
    // Copy the generated notes as edited, not as last saved.
    flushEnhancedSave();
    const generatedContent = getNoteById(noteId)?.enhancedContent;
    if (!generatedContent?.trim()) return;
    safeHaptics('light');
    Clipboard.setStringAsync(generatedContent).catch(() => {
      Alert.alert('Copy failed', 'Could not copy the generated notes.');
    });
  }, [flushEnhancedSave, getNoteById, noteId]);

  const handleExportTranscript = useCallback(
    (format: 'md' | 'txt'): void => {
      safeHaptics('light');
      exportNote(
        {
          title: `${titleRef.current || 'Untitled'} Transcript`,
          content: formatTranscriptForExport({ blocks: transcriptBlocks }),
        },
        format,
      ).catch(() =>
        Alert.alert('Export failed', 'Could not export this transcript. Please try again.'),
      );
    },
    [transcriptBlocks],
  );

  const runSelectedAction = useCallback(
    (action: Parameters<typeof runAction>[0], routing?: ReasoningRoutingOptions) => {
      if (processingState === 'processing') return;
      // Save a queued edit now: it must not land on top of the new notes later, and it must
      // survive an action that fails.
      flushEnhancedSave();
      const inputText =
        usesSegmentTranscriptRef.current && isDefaultGenerateNotesAction(action)
          ? generatedMeetingInputRef.current
          : actionInputRef.current;
      lastEnhancementInputHashRef.current = makeContentHash(inputText);
      runAction(action, inputText, {
        inputKind: usesSegmentTranscriptRef.current ? 'meeting-transcript' : 'plain-note',
        customDictionary: dictionaryWordsRef.current,
        routing: {
          isPrivateNote: note?.isPrivate === 1,
          ...routing,
        },
      });
    },
    [flushEnhancedSave, note?.isPrivate, processingState, runAction],
  );

  const runActionWithRouting = useCallback(
    async (action: Parameters<typeof runAction>[0]) => {
      const routing = { isPrivateNote: note?.isPrivate === 1 };
      // On-Device never leaves this phone: no account, paywall, or fallback to another service.
      if (notesMode === 'local') {
        const readiness = await getLocalReasoningReadiness();
        if (readiness.status === 'ready') {
          runSelectedAction(action, routing);
          return;
        }
        Alert.alert(
          'Local AI unavailable',
          `${getLocalReasoningUnavailableMessage(readiness)} Note Formatting is set to On-Device, so this note stays on your iPhone.`,
        );
        return;
      }

      const localRequired = providerNotes
        ? requiresCloudConfirmation
        : isLocalReasoningRequired(routing);

      if (localRequired) {
        if (await shouldUseLocalReasoning(routing)) {
          runSelectedAction(action, routing);
          return;
        }

        const readiness = await getLocalReasoningReadiness();
        const runElsewhereOnce = (): void =>
          runSelectedAction(action, { ...routing, allowCloudFallback: true });
        promptLocalReasoningFallback({
          readiness,
          signedIn: !!user,
          onEnableLocal: () => runSelectedAction(action, routing),
          onUseCloudOnce: user || providerNotes ? runElsewhereOnce : undefined,
          destinationName: providerNotes ? providerDisplayName(notesProviderId ?? '') : undefined,
        });
        return;
      }

      if (providerNotes) {
        runSelectedAction(action, routing);
        return;
      }

      if (requiresRealAccount(user)) {
        showAccountRequiredAlert('AI actions', { cloudOnly: true });
        return;
      }

      const gateAndRun = (actionRouting: ReasoningRoutingOptions) => {
        registerSuperwallGate({
          placement: SUPERWALL_PLACEMENTS.aiActionRun,
          params: { actionName: action.name },
          requiresAccount: false,
          feature: () => runSelectedAction(action, actionRouting),
        }).catch(() => {});
      };

      if (requiresCloudConfirmation) {
        confirmCloudOnce(
          `${action.name} sends this note to cloud AI for this request. Your note privacy and sync settings will not change.`,
          () => gateAndRun({ ...routing, allowCloudFallback: true }),
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
      requiresCloudConfirmation,
      runSelectedAction,
      user,
    ],
  );

  const handleRunAction = useCallback(
    (action: Parameters<typeof runAction>[0]) => {
      // Decide from the notes on screen: an edit typed since the last save counts too.
      flushEnhancedSave();
      if (!getNoteById(noteId)?.enhancedContent?.trim()) {
        runActionWithRouting(action).catch(() => {});
        return;
      }
      confirmDestructive(
        'Replace enhanced notes?',
        'Running this action replaces the current enhanced notes, including any edits.',
        () => runActionWithRouting(action),
        { destructiveLabel: 'Replace' },
      );
    },
    [flushEnhancedSave, getNoteById, noteId, runActionWithRouting],
  );

  const startChatRequest = useCallback(
    async (question: string, appendUserMessage: boolean, allowRemoteContent = false) => {
      const trimmedQuestion = question.trim();
      const context = chatContextRef.current.trim();
      if (!trimmedQuestion || chatAbortRef.current) return;
      if (!context) {
        Alert.alert('Nothing to ask about', 'Add note content or finish the transcript first.');
        return;
      }

      const controller = new AbortController();
      const userMessage: ChatOverNoteMessage = {
        id: randomUUID(),
        role: 'user',
        text: trimmedQuestion,
        createdAt: Date.now(),
      };
      const history =
        !appendUserMessage &&
        chatMessages[chatMessages.length - 1]?.role === 'user' &&
        chatMessages[chatMessages.length - 1]?.text.trim() === trimmedQuestion
          ? chatMessages.slice(0, -1)
          : chatMessages;

      chatAbortRef.current = controller;
      setChatError(null);
      setChatLastQuestion(trimmedQuestion);
      setIsChatProcessing(true);
      if (appendUserMessage) {
        setChatDraft('');
        setChatMessages((current) => [...current, userMessage]);
      }

      const askAbout = (chatContext: string) =>
        ReasoningService.chatOverNote({
          context: chatContext,
          question: trimmedQuestion,
          history,
          signal: controller.signal,
          routing: { isPrivateNote: note?.isPrivate === 1, allowCloudFallback: allowRemoteContent },
        });
      const sourceContext = actionInputRef.current.trim();
      try {
        let response;
        try {
          response = await askAbout(context);
        } catch (error) {
          // The generated notes can push an on-device request past its limit; the note alone
          // still fits wherever it did before they were added.
          if (
            controller.signal.aborted ||
            !isLocalContextLimitError(error) ||
            !sourceContext ||
            sourceContext === context
          ) {
            throw error;
          }
          response = await askAbout(sourceContext);
        }
        if (controller.signal.aborted) return;
        setChatMessages((current) => [
          ...current,
          {
            id: randomUUID(),
            role: 'assistant',
            text: response.text,
            createdAt: Date.now(),
          },
        ]);
      } catch (error) {
        if (controller.signal.aborted) return;
        setChatError(error instanceof Error ? error.message : 'Chat failed');
      } finally {
        if (chatAbortRef.current === controller) {
          chatAbortRef.current = null;
          setIsChatProcessing(false);
        }
      }
    },
    [chatMessages, note?.isPrivate],
  );

  const runChatWithCloudConfirmation = useCallback(
    (question: string, appendUserMessage: boolean) => {
      if (cloudChat && requiresRealAccount(user)) {
        showAccountRequiredAlert('AI chat', { cloudOnly: true });
        return;
      }

      const gateAndRun = (allowRemoteContent = false) => {
        if (!cloudChat) {
          startChatRequest(question, appendUserMessage, allowRemoteContent).catch(() => {});
          return;
        }
        registerSuperwallGate({
          placement: SUPERWALL_PLACEMENTS.noteChatStart,
          params: { source: 'note_chat' },
          requiresAccount: false,
          feature: () => {
            startChatRequest(question, appendUserMessage, allowRemoteContent).catch(() => {});
          },
        }).catch(() => {});
      };

      if (requiresCloudConfirmation && chatMode !== 'local') {
        confirmCloudOnce(
          'Chat sends this note context to your selected AI service for this request. Your note privacy and sync settings will not change.',
          () => gateAndRun(true),
        );
        return;
      }

      gateAndRun();
    },
    [chatMode, cloudChat, registerSuperwallGate, requiresCloudConfirmation, startChatRequest, user],
  );

  const handleAskNote = useCallback(() => {
    if (!chatContextRef.current.trim()) {
      Alert.alert('Nothing to ask about', 'Add note content or finish the transcript first.');
      return;
    }
    setChatVisible(true);
  }, []);

  const handleSendChat = useCallback(() => {
    runChatWithCloudConfirmation(chatDraft, true);
  }, [chatDraft, runChatWithCloudConfirmation]);

  const handleChatSuggestion = useCallback(
    (prompt: string) => {
      safeHaptics('light');
      runChatWithCloudConfirmation(prompt, true);
    },
    [runChatWithCloudConfirmation],
  );

  const handleRetryChat = useCallback(() => {
    if (!chatLastQuestion.trim()) return;
    runChatWithCloudConfirmation(chatLastQuestion, false);
  }, [chatLastQuestion, runChatWithCloudConfirmation]);

  const handleClearChat = useCallback(() => {
    if (isChatProcessing) return;
    setChatMessages([]);
    setChatDraft('');
    setChatError(null);
    setChatLastQuestion('');
  }, [isChatProcessing]);

  const handleCloseChat = useCallback(() => {
    if (chatAbortRef.current) {
      chatAbortRef.current.abort();
      chatAbortRef.current = null;
      setIsChatProcessing(false);
    }
    setChatVisible(false);
  }, []);

  const handleManageActions = useCallback(() => {
    router.push('/(tabs)/(notes)/actions');
  }, [router]);

  const handleDelete = useCallback(() => {
    confirmDestructive('Delete Note', 'This note will be deleted permanently.', () => {
      safeHaptics('warning');
      deleteNote(noteId);
      if (router.canGoBack()) router.back();
    });
  }, [deleteNote, noteId, router]);

  const handleRetryTranscript = useCallback(async () => {
    if (!note || isRetryingTranscript) return;
    safeHaptics('medium');
    setIsRetryingTranscript(true);
    try {
      await retryMeetingTranscription(note.id);
    } catch (error) {
      Alert.alert(
        'Retry failed',
        error instanceof Error ? error.message : 'Could not retry this transcription.',
      );
    } finally {
      setIsRetryingTranscript(false);
    }
  }, [isRetryingTranscript, note, retryMeetingTranscription]);

  const handleSpeakerPress = useCallback((block: TranscriptBlock) => {
    if (block.speakerId == null) return;
    setActiveSpeakerId(block.speakerId);
    safeHaptics('selection');
    if (block.speakerStatus === 'suggested') {
      setSuggestionSheetVisible(true);
      return;
    }
    Alert.alert(block.speakerName, undefined, [
      {
        text: 'Rename',
        onPress: () => setRenameSheetVisible(true),
      },
      {
        text: 'Merge',
        onPress: () => setMergeSheetVisible(true),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, []);

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
  const isEnhancingHeader = processingState === 'processing';
  // A finished meeting gets a persistent Ask pill instead of a menu entry. Status alone
  // can't mean "finished": synced notes keep the local default 'idle' even with a full
  // transcript. Segment transcripts never show the dictate FAB, so the two can't overlap.
  const showAskPill =
    chatEnabled && usesSegmentTranscript && !isTranscriptInProgress && !contentEmpty;
  // The tab bar is hidden on the note editor, so the pill sits on the home-indicator inset.
  const askPillBottom = insets.bottom + ASK_PILL_GAP;
  // Uploads can be lectures or voice memos, so only meetings get meeting-worded shortcuts.
  const chatSuggestions = getNoteChatSuggestions(
    usesSegmentTranscript && note?.noteType !== 'upload',
  );

  if (!note && !isNaN(noteId)) {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="text-tertiaryLabel">Note not found</Text>
      </View>
    );
  }

  const bodyTabs = getNoteBodyTabs(bodyTabInput);
  const bodyView = resolveNoteBodyView(viewMode, bodyTabInput);
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

  // iOS only presents a modal above another when it is rendered inside it, so these follow the
  // transcript sheet while it is open.
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

  return (
    <View className="flex-1 bg-systemBackground">
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
      <TabScreenHeader
        title={title || 'Untitled'}
        left={<GlassBackButton fallbackRoute="/(tabs)/(notes)" />}
        right={
          <NoteActionsMenu
            noteId={noteId}
            actions={actions}
            hasContent={!contentEmpty}
            isRecording={isRecording}
            processing={isEnhancingHeader}
            onRunAction={handleRunAction}
            onManageActions={handleManageActions}
            onAskNote={chatEnabled && !showAskPill ? handleAskNote : undefined}
            askNoteDisabled={isChatProcessing || !chatContextText.trim()}
            onCopyGeneratedNote={note?.enhancedContent ? handleCopyGeneratedNote : undefined}
            onViewTranscript={usesSegmentTranscript ? handleViewTranscript : undefined}
            onShare={() => setShareVisible(true)}
            onDelete={handleDelete}
          />
        }
      />
      <KeyboardAvoidingView
        className="flex-1 bg-systemBackground"
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom:
              keyboardHeight > 0
                ? NOTE_EDITOR_KEYBOARD_BOTTOM_PADDING
                : showAskPill
                  ? askPillBottom + ASK_PILL_HEIGHT + ASK_PILL_GAP * 2
                  : NOTE_EDITOR_BOTTOM_PADDING,
          }}
        >
          <TextInput
            value={title}
            onChangeText={handleTitleChange}
            placeholder="Title"
            placeholderTextColor="rgba(0,0,0,0.2)"
            multiline
            className="mb-3 text-3xl font-bold leading-9 text-label"
            style={{ fontFamily: AppFont.bold }}
          />

          <NoteMetaRow
            dateLabel={formatNoteMetaDate(
              noteTakenAt(note?.createdAt, note?.cloudUpdatedAt ?? note?.updatedAt),
              new Date(),
            )}
            attendeeLabel={attendeeLabel}
            folderLabel={folderName}
            onPressAttendees={() => setAttendeesVisible(true)}
            onPressFolder={note && !isSpaceUnknown ? () => move.open(note.id) : undefined}
          />

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

          {bodyTabs.length > 1 ? (
            <View
              className="mb-4 flex-row bg-tertiarySystemFill p-0.5"
              style={{ borderRadius: 12, borderCurve: 'continuous' }}
            >
              {bodyTabs.map((tab) => {
                const active = bodyView === tab;
                return (
                  <Pressable
                    key={tab}
                    testID={`note-tab-${tab}`}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      safeHaptics('selection');
                      setViewMode(tab);
                    }}
                    className={
                      'flex-1 flex-row items-center justify-center gap-1 py-1.5 ' +
                      (active ? 'bg-brand' : 'bg-transparent')
                    }
                    style={{ borderRadius: 10, borderCurve: 'continuous' }}
                  >
                    <Text
                      className={
                        'text-[13px] font-medium ' + (active ? 'text-white' : 'text-secondaryLabel')
                      }
                    >
                      {getNoteBodyTabLabel(tab, bodyTabInput)}
                    </Text>
                    {tab === 'enhanced' && isStale ? (
                      <View
                        testID="enhanced-stale-indicator"
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: '#FF9500' }}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {isRecording && currentText ? (
            <Text className="mb-2 text-[15px] italic text-link/60">{currentText}</Text>
          ) : null}

          <View className="relative">
            {bodyView === 'enhanced' ? (
              <EditableMarkdown
                key={`${noteId}-${enhancedEditorRevision}`}
                content={note?.enhancedContent ?? ''}
                editable={!isEnhancing}
                onChange={handleEnhancedChange}
                onEditingChange={handleEnhancedEditingChange}
              />
            ) : bodyView === 'notes' ? (
              <>
                {transcriptStatus === 'recording' ? (
                  <Text className="mb-2 text-[13px] text-secondaryLabel">
                    You can edit these notes once the recording stops.
                  </Text>
                ) : null}
                <TextInput
                  testID="note-content-input"
                  value={content}
                  onChangeText={handleContentChange}
                  selection={selection}
                  onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
                  placeholder={hasTypedMeetingNotes ? 'Add your own notes…' : 'Type or dictate…'}
                  placeholderTextColor="rgba(0,0,0,0.2)"
                  multiline
                  // The recording screen still writes these notes until the recording stops.
                  editable={!isEnhancing && transcriptStatus !== 'recording'}
                  textAlignVertical="top"
                  className="min-h-[300px] text-base leading-6 text-label"
                  style={{ fontFamily: AppFont.regular, opacity: isEnhancing ? 0.4 : 1 }}
                />
              </>
            ) : shouldShowTranscriptStatus ? (
              <View className="min-h-[180px] flex-row items-center gap-3">
                <ActivityIndicator size="small" color={BRAND} />
                <Text className="text-[15px] text-secondaryLabel">
                  {transcriptStatusText(transcriptStatus)}
                </Text>
              </View>
            ) : shouldShowTranscriptFailed ? (
              <View className="min-h-[180px] justify-center">
                <Text className="text-[15px] font-medium text-label">Transcript failed</Text>
                <Text className="mt-1 text-[14px] leading-5 text-secondaryLabel">
                  Audio processing did not finish for this note.
                </Text>
                {note && isManagedMeetingAudioUri(note.id, note.sourceFile) ? (
                  <Pressable
                    onPress={handleRetryTranscript}
                    disabled={isRetryingTranscript}
                    className="mt-4 h-11 flex-row items-center justify-center rounded-full bg-brand px-5 active:opacity-85 disabled:opacity-50"
                  >
                    {isRetryingTranscript ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <>
                        <SystemIcon
                          name="arrow.clockwise"
                          mdName="RotateCcw"
                          size={15}
                          color="#FFFFFF"
                        />
                        <Text className="ml-2 text-[14px] font-semibold text-white">
                          Retry transcription
                        </Text>
                      </>
                    )}
                  </Pressable>
                ) : (
                  <Text className="mt-3 text-[13px] leading-5 text-tertiaryLabel">
                    The original audio is no longer available, so this transcript cannot be retried.
                  </Text>
                )}
              </View>
            ) : (
              <SpeakerTranscript
                blocks={transcriptBlocks}
                selectedSpeakerId={activeSpeakerId}
                selectable
                onSpeakerPress={handleSpeakerPress}
              />
            )}

            {isEnhancing ? (
              <View
                className="absolute inset-0 items-center justify-center bg-systemBackground/60"
                style={{ borderRadius: 12 }}
              >
                <ActivityIndicator size="large" color={BRAND} />
                <Text className="mt-2 text-sm text-secondaryLabel">Enhancing...</Text>
              </View>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      {shouldRenderPlainEditor ? (
        <Pressable
          onPress={handleDictate}
          disabled={isProcessing || isEnhancing || isRecoveringUsageLimit}
          accessibilityRole="button"
          accessibilityLabel={
            isRecording
              ? 'Stop dictation'
              : isProcessing
                ? 'Processing dictation'
                : 'Start dictation'
          }
          style={{
            position: 'absolute',
            right: 20,
            bottom: FAB_BOTTOM,
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: isRecording ? SYSTEM_RED : BRAND,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: isProcessing || isRecoveringUsageLimit ? 0.5 : 1,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.18,
            shadowRadius: 8,
            elevation: 6,
          }}
        >
          {!isRecording ? <GradientGlassSurface shape="circle" /> : null}
          <SystemIcon
            name={isRecording ? 'stop.fill' : isProcessing ? 'waveform' : 'mic.fill'}
            mdName={isRecording ? 'Square' : isProcessing ? 'AudioWaveform' : 'Mic'}
            size={24}
            color="#FFF"
          />
        </Pressable>
      ) : null}
      {showAskPill ? (
        <Pressable
          onPress={() => {
            safeHaptics('light');
            handleAskNote();
          }}
          testID="note-ask-pill"
          accessibilityRole="button"
          accessibilityLabel="Ask anything"
          accessibilityHint="Opens a chat about this note"
          style={{
            position: 'absolute',
            left: 20,
            right: 20,
            bottom: askPillBottom,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.12,
            shadowRadius: 10,
          }}
        >
          <Glass.Interactive style={{ height: ASK_PILL_HEIGHT, borderRadius: ASK_PILL_HEIGHT / 2 }}>
            <View className="flex-1 flex-row items-center justify-center gap-2">
              <SystemIcon
                name="bubble.left.fill"
                mdName="MessageCircle"
                size={17}
                color="secondaryLabel"
              />
              <Text className="text-[17px] font-medium text-label">Ask anything</Text>
            </View>
          </Glass.Interactive>
        </Pressable>
      ) : null}
      <NoteChatSheet
        visible={chatVisible}
        messages={chatMessages}
        draft={chatDraft}
        isProcessing={isChatProcessing}
        error={chatError}
        canSend={!!chatContextText.trim()}
        suggestions={chatSuggestions}
        onDraftChange={setChatDraft}
        onSend={handleSendChat}
        onSuggestion={handleChatSuggestion}
        onRetry={handleRetryChat}
        onClear={handleClearChat}
        onClose={handleCloseChat}
      />
      <AttendeesSheet
        visible={attendeesVisible}
        participants={attendees}
        onClose={() => setAttendeesVisible(false)}
      />
      {/* Hidden in the render where the Space disappears, before the picker is closed. */}
      {isSpaceUnknown ? null : <MoveToFolderSheet {...move.sheetProps} />}
      <TranscriptSheet
        visible={transcriptSheetVisible}
        blocks={transcriptBlocks}
        selectedSpeakerId={activeSpeakerId}
        shareText={transcriptText}
        onSpeakerPress={handleSpeakerPress}
        onExport={handleExportTranscript}
        onClose={() => setTranscriptSheetVisible(false)}
      >
        {transcriptSheetVisible ? speakerSheets : null}
      </TranscriptSheet>
      {transcriptSheetVisible ? null : speakerSheets}
      <ThatsMeSheet
        visible={voiceSetupVisible}
        candidates={voiceCandidates}
        onClaim={handleClaimVoice}
        onReadScript={handleReadVoiceScript}
        onClose={() => setVoiceSetupVisible(false)}
        onDismissed={handleVoiceSetupDismissed}
      />
    </View>
  );
}

// Approximate height of the iOS 18 floating NativeTabs bar (incl. home-indicator
// inset). Used to lift the floating mic FAB clear of the tab bar.
const TAB_BAR_OFFSET = Platform.OS === 'ios' ? 110 : 70;
const FAB_BOTTOM = TAB_BAR_OFFSET + 32;
const ASK_PILL_HEIGHT = 52;
const ASK_PILL_GAP = 12;
const SYSTEM_RED = '#FF3B30';
