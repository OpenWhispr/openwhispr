import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation, usePreventRemove, type NavigationAction } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { Text } from '@/components/ui/Text';
import { useHome } from './home/kit';
import { GlassButton } from './processingFable/look';
import { ProgressBar } from './controls';
import { BackButton, LinkButton } from './notes/look';
import { notesT } from './notes/strings';
import { modelName } from './settings/modelCatalog';
import { selectedSpeechModel } from './speechSelection';
import { speechModelCoversRecording, unsupportedSpeechLanguages } from './speechCapabilities';
import { SystemIcon } from '@/components/ui/SystemIcon';
import registry from '@/config/languageRegistry.json';
import { getPreferredTranscriptionLanguages } from '@/android/shared/lib/transcriptionLanguage';
import { useFileUpload } from '@/android/hooks/useFileUpload';
import { useSuperwallGate } from '@/android/shared/hooks/useSuperwallGate';
import { useAuthStore } from '@/android/store/useAuthStore';
import { useNotesStore } from '@/android/store/useNotesStore';
import { useProcessingModeStore } from '@/android/shared/store/useProcessingModeStore';
import { useConfigStore } from '@/android/store/useConfigStore';
import { useUsageStore } from '@/android/store/useUsageStore';
import { snapshotTranscriptionJob } from '@/lib/inferenceRouting';
import { accountRequiredForCloud, showAccountRequiredAlert } from '@/android/lib/accountAccess';
import { buildUsageGateParams, SUPERWALL_PLACEMENTS } from '@/android/shared/lib/superwall';
import {
  ImportDestinationError,
  resolveImportDestination,
  saveImportedNote,
  type ImportDestination,
} from '@/android/shared/lib/notes/importDestination';

function parseId(value?: string): number | undefined {
  if (!value) return undefined;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new ImportDestinationError(
      'importInvalidDestination',
      'This destination is invalid. Return to Notes.',
    );
  return id;
}

const languageName = (code: string) =>
  (
    registry.languages.find((item) => item.code === code) ??
    registry.languages.find((item) => item.code.split('-')[0] === code)
  )?.label ?? code;

const languageList = (names: string[]) =>
  names.length < 2
    ? names.join('')
    : notesT('languageListAnd', { first: names.slice(0, -1).join(', '), last: names.at(-1) });

/** On device, the listed languages the speech model can't transcribe; null when it knows them all. */
function uploadLanguageNote() {
  const speech = selectedSpeechModel();
  const languages = getPreferredTranscriptionLanguages();
  const unsupported = unsupportedSpeechLanguages(speech, languages);
  if (!unsupported.length) return null;
  const blocked = !speechModelCoversRecording(speech, languages);
  return {
    blocked,
    message: notesT(blocked ? 'uploadLanguageNone' : 'uploadLanguagePartly', {
      model: modelName(speech),
      languages: languageList(unsupported.map(languageName)),
    }),
  };
}

export default function ImportAudioScreen() {
  const { t } = useTranslation('android');
  const errorMessage = (cause: unknown) =>
    cause instanceof ImportDestinationError
      ? t(cause.translationKey)
      : cause instanceof Error
        ? cause.message
        : String(cause);
  const params = useLocalSearchParams<{ folderId?: string; spaceId?: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { c, type, card } = useHome();
  const mode = useProcessingModeStore((state) => state.activeMode);
  // Refresh the preview when workflow configuration changes; the job takes its
  // own snapshot before the paywall or picker opens.
  useConfigStore((state) => state.config?.inference);
  // The language note follows the language list and the speech model.
  useConfigStore((state) => state.config?.languages);
  useConfigStore((state) => state.config?.preferredLanguage);
  useConfigStore((state) => state.config?.androidSpeechModel);
  const { register } = useSuperwallGate();
  const focused = useRef(true);
  const accountChanged = useRef(false);
  const requestBusy = useRef(false);
  const requestGeneration = useRef(0);
  const destination = useRef<ImportDestination | null>(null);
  const [gating, setGating] = useState(false);
  const [error, setError] = useState('');
  const [completedNoteId, setCompletedNoteId] = useState<number | null>(null);
  const pendingNavigation = useRef<NavigationAction | null>(null);
  const preview = (() => {
    try {
      const target = resolveImportDestination({
        folderId: parseId(params.folderId),
        spaceId: parseId(params.spaceId),
        isPrivate: mode === 'private',
      });
      const route = snapshotTranscriptionJob('upload');
      const languageNote = route.provider === 'local' ? uploadLanguageNote() : null;
      return { target, route, languageNote, error: '' };
    } catch (cause) {
      return { target: null, route: null, languageNote: null, error: errorMessage(cause) };
    }
  })();
  const { isProcessing, currentText, stage, cancel, pickAndTranscribeFile } = useFileUpload({
    saveToHistory: false,
    isCurrent: () =>
      focused.current &&
      !accountChanged.current &&
      destination.current?.ownerId === (useAuthStore.getState().user?.id ?? null),
    onComplete: (text, fileName) => {
      if (!destination.current) return;
      const note = saveImportedNote(destination.current, text, fileName, t('importDefaultTitle'));
      setCompletedNoteId(note.id);
      useNotesStore.getState().loadNotes();
      useNotesStore.getState().loadFolders();
    },
    onError: (cause) => setError(errorMessage(cause)),
  });
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        requestGeneration.current += 1;
        cancel();
      };
    }, [cancel]),
  );
  useEffect(
    () =>
      useAuthStore.subscribe((state, previous) => {
        if (state.user?.id !== previous.user?.id) {
          accountChanged.current = true;
          cancel();
          setError(t('importAccountChanged'));
        }
      }),
    [cancel, t],
  );
  usePreventRemove(isProcessing, ({ data }) => {
    Alert.alert(t('importCancelTitle'), t('importCancelBody'), [
      { text: t('importKeep'), style: 'cancel' },
      {
        text: t('importCancel'),
        style: 'destructive',
        onPress: () => {
          pendingNavigation.current = data.action;
          cancel();
        },
      },
    ]);
  });
  useEffect(() => {
    if (isProcessing) return;
    if (pendingNavigation.current) {
      const action = pendingNavigation.current;
      pendingNavigation.current = null;
      navigation.dispatch(action);
    } else if (completedNoteId != null) {
      router.replace(`/(tabs)/(notes)/${completedNoteId}`);
    }
  }, [isProcessing, completedNoteId, navigation, router]);

  const start = async () => {
    if (
      requestBusy.current ||
      isProcessing ||
      accountChanged.current ||
      !preview.target ||
      !preview.route ||
      preview.languageNote?.blocked
    )
      return;
    const route = preview.route;
    const user = useAuthStore.getState().user;
    if (route.provider === 'cloud' && accountRequiredForCloud(user)) {
      showAccountRequiredAlert('audio import');
      return;
    }
    destination.current = preview.target;
    const requestId = ++requestGeneration.current;
    requestBusy.current = true;
    setError('');
    setGating(true);
    let began = false;
    const begin = () => {
      if (
        began ||
        !focused.current ||
        accountChanged.current ||
        requestId !== requestGeneration.current
      )
        return;
      began = true;
      void pickAndTranscribeFile(route).catch(() => undefined);
    };
    try {
      if (route.provider === 'cloud' && user) {
        const usage = useUsageStore.getState().usage;
        await register({
          placement: SUPERWALL_PLACEMENTS.audioUploadStart,
          params: usage ? buildUsageGateParams(usage) : undefined,
          requiresAccount: false,
          feature: begin,
        });
      } else begin();
    } catch (cause) {
      if (focused.current) setError(errorMessage(cause));
    } finally {
      requestBusy.current = false;
      if (focused.current) setGating(false);
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas, paddingTop: insets.top }}>
      <View
        style={{ paddingHorizontal: 16, paddingTop: 8, minHeight: 52, justifyContent: 'center' }}
      >
        <BackButton />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text
          accessibilityRole="header"
          style={{ fontSize: 28, lineHeight: 39, fontWeight: '500', color: c.text }}
        >
          {notesT('uploadAudio')}
        </Text>
        {isProcessing ? (
          <View style={[card, { padding: 16, gap: 12 }]}>
            <Text style={type.rowTitle} accessibilityLiveRegion="polite">
              {stage === 'cleaning' ? notesT('cleaningUp') : notesT('transcribing')}
            </Text>
            {/* The pipeline reports no %, so the bar sweeps. */}
            <ProgressBar />
            <Text style={{ fontSize: 13, lineHeight: 18, color: c.secondary }}>
              {notesT('stayOnScreen')}
            </Text>
            <LinkButton destructive label={notesT('cancelUpload')} onPress={cancel} />
          </View>
        ) : error || preview.error ? (
          <View style={[card, { padding: 16, gap: 8 }]}>
            <Text style={type.rowTitle} accessibilityRole="alert">
              {notesT('uploadFailed')}
            </Text>
            <Text style={{ fontSize: 14, lineHeight: 20, color: c.secondary }}>
              {error || preview.error}
            </Text>
            <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
              {!preview.error ? (
                <LinkButton label={notesT('tryAgain')} onPress={() => void start()} />
              ) : null}
              <LinkButton
                label={notesT('settingsProcessing')}
                onPress={() => router.push('/(account)/ai-models')}
              />
              {currentText ? (
                <LinkButton
                  label={notesT('copyTranscript2')}
                  onPress={() => {
                    void Clipboard.setStringAsync(currentText)
                      .then(() => Alert.alert(t('copied'), t('importCopied')))
                      .catch(() => Alert.alert(t('importCopyFailed'), t('retry')));
                  }}
                />
              ) : null}
            </View>
          </View>
        ) : (
          <View style={[card, { padding: 16, gap: 12 }]}>
            <Text style={{ fontSize: 15, lineHeight: 21, color: c.secondary }}>
              {notesT('uploadFormats')}
            </Text>
            {preview.languageNote ? (
              <View
                style={{
                  flexDirection: 'row',
                  gap: 10,
                  padding: 12,
                  paddingBottom: 0,
                  borderRadius: 12,
                  backgroundColor: c.tile,
                }}
              >
                <View style={{ paddingTop: 2 }}>
                  <SystemIcon name="info.circle" mdName="Info" size={18} color={c.text} />
                </View>
                <View style={{ flex: 1, alignItems: 'flex-start' }}>
                  <Text style={{ fontSize: 15, lineHeight: 21, color: c.text }}>
                    {preview.languageNote.message}
                  </Text>
                  <LinkButton
                    label={notesT('useCloudForUploads')}
                    onPress={() => router.push('/(account)/ai-models')}
                  />
                </View>
              </View>
            ) : null}
            <GlassButton
              label={t('importChoose')}
              disabled={
                gating ||
                accountChanged.current ||
                !!preview.error ||
                !!preview.languageNote?.blocked
              }
              onPress={() => {
                void start();
              }}
            />
          </View>
        )}
        {isProcessing && currentText ? (
          <View style={[card, { padding: 16 }]}>
            <Text selectable style={{ fontSize: 16, lineHeight: 23, color: c.text }}>
              {currentText}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
