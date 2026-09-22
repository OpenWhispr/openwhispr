import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  View,
  TextInput,
  ScrollView,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
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
import { MarkdownRenderer } from '@/components/notes/MarkdownRenderer';
import { NoteActionsMenu } from '@/components/notes/NoteActionsMenu';
import { ConflictBanner } from '@/components/notes/ConflictBanner';
import { NoteChatSheet } from '@/components/notes/NoteChatSheet';
import { SpeakerTranscript } from '@/components/notes/SpeakerTranscript';
import { SpeakerRenameSheet } from '@/components/notes/SpeakerRenameSheet';
import { SpeakerMergeSheet } from '@/components/notes/SpeakerMergeSheet';
import { VoiceprintSuggestionSheet } from '@/components/notes/VoiceprintSuggestionSheet';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GradientGlassSurface } from '@/components/ui/GradientGlassSurface';
import { GlassBackButton } from '@/components/ui/GlassBackButton';
import { TabScreenHeader } from '@/components/ui/TabScreenHeader';
import { buildNoteShareContent, exportNote } from '@/lib/noteExport';
import { SpaceGrotesk } from '@/lib/fonts';
import { makeContentHash, safeHaptics } from '@/lib/utils';
import { parseNoteTimestamp } from '@/lib/parseNoteTimestamp';
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
  isLocalReasoningRequired,
  shouldUseLocalReasoning,
} from '@/lib/localReasoning';
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
import type { ChatOverNoteMessage } from '@/lib/notes/chatOverNote';
import {
  formatTranscriptForExport,
  getSpeakerDisplayName,
  groupTranscriptSegments,
  type TranscriptBlock,
} from '@/lib/diarization/transcriptDisplay';
type ViewMode = 'original' | 'enhanced';

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
  const dictionaryEntries = useDictionaryStore((s) => s.entries);
  const dictionaryWords = useMemo(() => dictionaryEntries.map((e) => e.word), [dictionaryEntries]);
  const addLearnedWords = useDictionaryStore((s) => s.addLearnedWords);

  const actions = useActionsStore((s) => s.actions);
  const initializeActions = useActionsStore((s) => s.initialize);

  const [title, setTitle] = useState(note?.title ?? '');
  const [content, setContent] = useState(note?.content ?? '');
  const [viewMode, setViewMode] = useState<ViewMode>('original');
  const [selection, setSelection] = useState<{ start: number; end: number }>({
    start: (note?.content ?? '').length,
    end: (note?.content ?? '').length,
  });
  const [activeSpeakerId, setActiveSpeakerId] = useState<number | null>(null);
  const [renameSheetVisible, setRenameSheetVisible] = useState(false);
  const [mergeSheetVisible, setMergeSheetVisible] = useState(false);
  const [suggestionSheetVisible, setSuggestionSheetVisible] = useState(false);
  const [chatVisible, setChatVisible] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatOverNoteMessage[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatLastQuestion, setChatLastQuestion] = useState('');
  const [isChatProcessing, setIsChatProcessing] = useState(false);
  const [isRetryingTranscript, setIsRetryingTranscript] = useState(false);
  const keyboardHeight = useKeyboardHeight();

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
      setViewMode(note.enhancedContent ? 'enhanced' : 'original');
    }
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    setChatVisible(false);
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
  const shouldShowTranscriptStatus =
    isAudioTranscript &&
    !hasTranscriptSegments &&
    ['recording', 'transcribing', 'diarizing'].includes(transcriptStatus);
  const shouldShowTranscriptFailed =
    isAudioTranscript && !hasTranscriptSegments && transcriptStatus === 'failed';
  const shouldRenderPlainEditor =
    !isAudioTranscript ||
    (!hasTranscriptSegments && (transcriptStatus === 'idle' || transcriptStatus === 'done'));
  const requiresCloudConfirmation = note?.isPrivate === 1 || activeMode === 'private';

  const handleKeepMine = useCallback(() => {
    safeHaptics('selection');
    resolveConflictKeepMine(noteId);
  }, [noteId, resolveConflictKeepMine]);

  const handleUseServerCopy = useCallback(() => {
    safeHaptics('selection');
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
      setViewMode(refreshed.enhancedContent ? 'enhanced' : 'original');
    }
  }, [noteId, resolveConflictUseServer, getNoteById]);

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

  const debouncedSave = useCallback(
    (updates: { title?: string; content?: string }) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        updateNote(noteId, updates);
        if (typeof updates.content === 'string') {
          maybeLearnCorrections(updates.content);
        }
      }, 800);
    },
    [noteId, updateNote, maybeLearnCorrections],
  );

  useEffect(
    () => () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      const titleChanged = titleRef.current !== originalTitleRef.current;
      const contentChanged =
        !usesSegmentTranscriptRef.current && contentRef.current !== originalContentRef.current;
      if (!titleChanged && !contentChanged) return;
      updateNote(noteId, {
        ...(titleChanged ? { title: titleRef.current } : {}),
        ...(contentChanged ? { content: contentRef.current } : {}),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [noteId],
  );

  const handleTitleChange = useCallback(
    (text: string) => {
      setTitle(text);
      debouncedSave(
        usesSegmentTranscript ? { title: text } : { title: text, content: contentRef.current },
      );
    },
    [debouncedSave, usesSegmentTranscript],
  );

  const handleContentChange = useCallback(
    (text: string) => {
      if (usesSegmentTranscript) return;
      setContent(text);
      debouncedSave({ title: titleRef.current, content: text });
    },
    [debouncedSave, usesSegmentTranscript],
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
      debouncedSave({ title: titleRef.current, content: newContent });
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

  const handleExport = useCallback(() => {
    safeHaptics('light');
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ['Export as Markdown', 'Export as Plain Text', 'Cancel'],
        cancelButtonIndex: 2,
      },
      (buttonIndex) => {
        const payload = {
          title: titleRef.current,
          content: buildNoteShareContent({
            viewMode,
            enhancedContent: note?.enhancedContent ?? null,
            usesSegmentTranscript,
            // Title-free: exportNote already leads the file with the title.
            transcript: formatTranscriptForExport({ blocks: transcriptBlocks }),
            content: contentRef.current,
          }),
        };
        if (buttonIndex === 0) exportNote(payload, 'md');
        if (buttonIndex === 1) exportNote(payload, 'txt');
      },
    );
  }, [note?.enhancedContent, transcriptBlocks, usesSegmentTranscript, viewMode]);

  const handleCopyTranscript = useCallback(() => {
    if (!transcriptText.trim()) return;
    safeHaptics('light');
    Clipboard.setStringAsync(transcriptText).catch(() => {
      Alert.alert('Copy failed', 'Could not copy the transcript.');
    });
  }, [transcriptText]);

  const handleCopyGeneratedNote = useCallback(() => {
    const generatedContent = note?.enhancedContent;
    if (!generatedContent?.trim()) return;
    safeHaptics('light');
    Clipboard.setStringAsync(generatedContent).catch(() => {
      Alert.alert('Copy failed', 'Could not copy the generated notes.');
    });
  }, [note?.enhancedContent]);

  const runSelectedAction = useCallback(
    (action: Parameters<typeof runAction>[0], routing?: ReasoningRoutingOptions) => {
      if (processingState === 'processing') return;
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
    [note?.isPrivate, processingState, runAction],
  );

  const handleRunAction = useCallback(
    async (action: Parameters<typeof runAction>[0]) => {
      const routing = { isPrivateNote: note?.isPrivate === 1 };
      const localRequired = isLocalReasoningRequired(routing);

      if (localRequired) {
        if (await shouldUseLocalReasoning(routing)) {
          runSelectedAction(action, routing);
          return;
        }

        const readiness = await getLocalReasoningReadiness();
        promptLocalReasoningFallback({
          readiness,
          signedIn: !!user,
          onEnableLocal: () => runSelectedAction(action, routing),
          onUseCloudOnce: user
            ? () =>
                runSelectedAction(action, {
                  ...routing,
                  allowCloudFallback: true,
                })
            : undefined,
        });
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
    [note?.isPrivate, registerSuperwallGate, requiresCloudConfirmation, runSelectedAction, user],
  );

  const startChatRequest = useCallback(
    async (question: string, appendUserMessage: boolean) => {
      const trimmedQuestion = question.trim();
      const context = actionInputRef.current.trim();
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

      try {
        const response = await ReasoningService.chatOverNote({
          context,
          question: trimmedQuestion,
          history,
          signal: controller.signal,
        });
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
    [chatMessages],
  );

  const runChatWithCloudConfirmation = useCallback(
    (question: string, appendUserMessage: boolean) => {
      if (requiresRealAccount(user)) {
        showAccountRequiredAlert('AI chat', { cloudOnly: true });
        return;
      }

      const gateAndRun = () => {
        registerSuperwallGate({
          placement: SUPERWALL_PLACEMENTS.noteChatStart,
          params: { source: 'note_chat' },
          requiresAccount: false,
          feature: () => {
            startChatRequest(question, appendUserMessage).catch(() => {});
          },
        }).catch(() => {});
      };

      if (requiresCloudConfirmation) {
        confirmCloudOnce(
          'Chat sends this note context to cloud AI for this request. Your note privacy and sync settings will not change.',
          gateAndRun,
        );
        return;
      }

      gateAndRun();
    },
    [registerSuperwallGate, requiresCloudConfirmation, startChatRequest, user],
  );

  const handleAskNote = useCallback(() => {
    if (!actionInputRef.current.trim()) {
      Alert.alert('Nothing to ask about', 'Add note content or finish the transcript first.');
      return;
    }
    setChatVisible(true);
  }, []);

  const handleSendChat = useCallback(() => {
    runChatWithCloudConfirmation(chatDraft, true);
  }, [chatDraft, runChatWithCloudConfirmation]);

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

  if (!note && !isNaN(noteId)) {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="text-tertiaryLabel">Note not found</Text>
      </View>
    );
  }

  const updatedAtDisplay = note?.updatedAt
    ? parseNoteTimestamp(note.updatedAt).toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : '';

  const hasEnhanced = !!note?.enhancedContent;
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

  return (
    <View className="flex-1 bg-systemBackground">
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
            onAskNote={handleAskNote}
            askNoteDisabled={isChatProcessing}
            onCopyGeneratedNote={note?.enhancedContent ? handleCopyGeneratedNote : undefined}
            onCopyTranscript={usesSegmentTranscript ? handleCopyTranscript : undefined}
            onShare={handleExport}
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
              keyboardHeight > 0 ? NOTE_EDITOR_KEYBOARD_BOTTOM_PADDING : NOTE_EDITOR_BOTTOM_PADDING,
          }}
        >
          <TextInput
            value={title}
            onChangeText={handleTitleChange}
            placeholder="Title"
            placeholderTextColor="rgba(0,0,0,0.2)"
            multiline
            className="mb-3 text-3xl font-bold leading-9 text-label"
            style={{ fontFamily: SpaceGrotesk.bold }}
          />

          {updatedAtDisplay ? (
            <Text className="mb-3 text-[13px] text-tertiaryLabel">{updatedAtDisplay}</Text>
          ) : null}

          {conflict ? (
            <ConflictBanner
              canUseServerCopy={conflict.conflictServerNote != null}
              onKeepMine={handleKeepMine}
              onUseServer={handleUseServerCopy}
            />
          ) : null}

          {hasEnhanced ? (
            <View
              className="mb-4 flex-row bg-tertiarySystemFill p-0.5"
              style={{ borderRadius: 12, borderCurve: 'continuous' }}
            >
              <Pressable
                onPress={() => {
                  safeHaptics('selection');
                  setViewMode('original');
                }}
                className={
                  'flex-1 items-center py-1.5 ' +
                  (viewMode === 'original' ? 'bg-brand' : 'bg-transparent')
                }
                style={{ borderRadius: 10, borderCurve: 'continuous' }}
              >
                <Text
                  className={
                    'text-[13px] font-medium ' +
                    (viewMode === 'original' ? 'text-white' : 'text-secondaryLabel')
                  }
                >
                  {isAudioTranscript ? 'Transcript' : 'Original'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  safeHaptics('selection');
                  setViewMode('enhanced');
                }}
                className={
                  'flex-1 flex-row items-center justify-center gap-1 py-1.5 ' +
                  (viewMode === 'enhanced' ? 'bg-brand' : 'bg-transparent')
                }
                style={{ borderRadius: 10, borderCurve: 'continuous' }}
              >
                <Text
                  className={
                    'text-[13px] font-medium ' +
                    (viewMode === 'enhanced' ? 'text-white' : 'text-secondaryLabel')
                  }
                >
                  Enhanced
                </Text>
                {isStale ? (
                  <View
                    testID="enhanced-stale-indicator"
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: '#FF9500' }}
                  />
                ) : null}
              </Pressable>
            </View>
          ) : null}

          {isRecording && currentText ? (
            <Text className="mb-2 text-[15px] italic text-link/60">{currentText}</Text>
          ) : null}

          <View className="relative">
            {viewMode === 'enhanced' && hasEnhanced ? (
              <MarkdownRenderer content={note!.enhancedContent!} selectable />
            ) : usesSegmentTranscript ? (
              <SpeakerTranscript
                blocks={transcriptBlocks}
                selectedSpeakerId={activeSpeakerId}
                selectable
                onSpeakerPress={handleSpeakerPress}
              />
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
            ) : shouldRenderPlainEditor ? (
              <TextInput
                value={content}
                onChangeText={handleContentChange}
                selection={selection}
                onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
                placeholder="Type or dictate…"
                placeholderTextColor="rgba(0,0,0,0.2)"
                multiline
                editable={!isEnhancing}
                textAlignVertical="top"
                className="min-h-[300px] text-base leading-6 text-label"
                style={{ fontFamily: SpaceGrotesk.regular, opacity: isEnhancing ? 0.4 : 1 }}
              />
            ) : (
              <View className="min-h-[180px]" />
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
      <NoteChatSheet
        visible={chatVisible}
        messages={chatMessages}
        draft={chatDraft}
        isProcessing={isChatProcessing}
        error={chatError}
        canSend={!contentEmpty}
        onDraftChange={setChatDraft}
        onSend={handleSendChat}
        onRetry={handleRetryChat}
        onClear={handleClearChat}
        onClose={handleCloseChat}
      />
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
    </View>
  );
}

// Approximate height of the iOS 18 floating NativeTabs bar (incl. home-indicator
// inset). Used to lift the floating mic FAB clear of the tab bar.
const TAB_BAR_OFFSET = Platform.OS === 'ios' ? 110 : 70;
const FAB_BOTTOM = TAB_BAR_OFFSET + 32;
const SYSTEM_RED = '#FF3B30';
