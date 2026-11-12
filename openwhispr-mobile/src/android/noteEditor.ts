import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Alert, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { supportsVoiceEnrollment } from '@/lib/voiceEnrollmentCapability';
import { ProviderExecutionError } from '@/services/providers/ProviderExecutionError';
import { getProviderErrorCopyKey } from '@/lib/providerErrorCopy';
import { NoteRecordingControls } from './NoteRecordingControls';
import type {
  EditorContext,
  EditorCopy,
  EditorLifecycle,
  NoteEditorPlatform,
} from '@/screens/NoteEditorPlatform.android';

function usePresentation() {
  const { t } = useTranslation('android');
  const { copy, language } = useAndroidCopy();
  const copyRef = useRef(copy);
  copyRef.current = copy;
  const { width, fontScale } = useWindowDimensions();
  return {
    copy,
    copyRef,
    language,
    stackBodyTabs: width / fontScale < 240,
    incompleteTranscript: () =>
      t('meetingTranscriptIncomplete', { defaultValue: 'Transcript incomplete' }),
  };
}

function useSessionCookie() {
  return useAuthStore((s) => s.sessionCookie);
}

function useLifecycle({
  noteId,
  note,
  user,
  sessionCookie,
  activeMode,
  getNoteById,
}: EditorContext): EditorLifecycle {
  // Consent belongs to this editor, account, note and processing selection. Native alerts,
  // model readiness and the paywall may finish after any of those have changed.
  const aiRoutingKey = useConfigStore((s) => JSON.stringify(s.config?.inference));
  const aiContext = useMemo(
    () => ({
      noteId,
      clientNoteId: note?.clientNoteId,
      remoteId: note?.remoteId,
      isPrivate: note?.isPrivate,
      accountId: user?.id,
      sessionCookie,
      activeMode,
      aiRoutingKey,
    }),
    [
      noteId,
      note?.clientNoteId,
      note?.remoteId,
      note?.isPrivate,
      user?.id,
      sessionCookie,
      activeMode,
      aiRoutingKey,
    ],
  );
  const aiContextRef = useRef(aiContext);
  aiContextRef.current = aiContext;
  const editorActive = useRef(true);
  const editorGeneration = useRef(0);
  const captureAIContext = useCallback(() => {
    const context = aiContextRef.current;
    const generation = editorGeneration.current;
    const auth = useAuthStore.getState();
    const accountId = auth.user?.id;
    const cookie = auth.sessionCookie;
    const mode = useProcessingModeStore.getState().activeMode;
    const routingKey = JSON.stringify(useConfigStore.getState().config?.inference);
    return (): boolean => {
      const currentAuth = useAuthStore.getState();
      const currentNote = getNoteById(context.noteId);
      return (
        editorActive.current &&
        generation === editorGeneration.current &&
        context === aiContextRef.current &&
        !!currentNote &&
        !currentNote.deletedAt &&
        currentNote.clientNoteId === context.clientNoteId &&
        currentNote.remoteId === context.remoteId &&
        currentNote.isPrivate === context.isPrivate &&
        currentAuth.user?.id === accountId &&
        currentAuth.sessionCookie === cookie &&
        useProcessingModeStore.getState().activeMode === mode &&
        JSON.stringify(useConfigStore.getState().config?.inference) === routingKey
      );
    };
  }, [getNoteById]);
  useEffect(() => {
    editorActive.current = true;
    return () => {
      editorActive.current = false;
      editorGeneration.current += 1;
    };
  }, []);
  const chatConsentGeneration = useRef(0);
  return { aiContext, editorActive, editorGeneration, chatConsentGeneration, captureAIContext };
}

function useActionCleanup(aiContext: unknown, cancelAction?: () => void) {
  useEffect(() => cancelAction, [aiContext, cancelAction]);
}

function useEditorFocus({ editorActive, editorGeneration }: EditorLifecycle) {
  useFocusEffect(
    useCallback(() => {
      editorActive.current = true;
      return () => {
        editorActive.current = false;
        editorGeneration.current += 1;
      };
    }, [editorActive, editorGeneration]),
  );
}

function showActionError(message: string, error: unknown, copy: EditorCopy) {
  const title = copy('editorFeedback.actionFailed', 'Action failed');
  const body =
    error instanceof Error
      ? message
      : copy('editorFeedback.enhancementFailed', 'Enhancement failed');
  Alert.alert(
    title,
    error instanceof ProviderExecutionError
      ? copy(
          getProviderErrorCopyKey(error) ?? 'editorFeedback.enhancementFailed',
          'Enhancement failed',
          { status: error.status },
        )
      : body,
    [{ text: copy('close', 'Close') }],
  );
}

export const androidNoteEditor: NoteEditorPlatform = {
  usePresentation,
  useSessionCookie,
  useLifecycle,
  useActionCleanup,
  useEditorFocus,
  supportsVoiceEnrollment,
  showActionError,
  RecordingControls: NoteRecordingControls,
};
