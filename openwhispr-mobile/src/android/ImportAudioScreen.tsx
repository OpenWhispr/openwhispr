import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation, usePreventRemove, type NavigationAction } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { Text } from '@/components/ui/Text';
import { Button, Card, Page, styles } from './ui';
import { useFileUpload } from '@/hooks/useFileUpload';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { useAuthStore } from '@/store/useAuthStore';
import { useNotesStore } from '@/store/useNotesStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useUsageStore } from '@/store/useUsageStore';
import { snapshotTranscriptionJob } from '@/lib/inferenceRouting';
import { accountRequiredForCloud, showAccountRequiredAlert } from '@/lib/accountAccess';
import { buildUsageGateParams, SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import {
  ImportDestinationError,
  resolveImportDestination,
  saveImportedNote,
  type ImportDestination,
} from '@/lib/notes/importDestination';

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
  const mode = useProcessingModeStore((state) => state.activeMode);
  // Refresh the preview when workflow configuration changes; the job takes its
  // own snapshot before the paywall or picker opens.
  useConfigStore((state) => state.config?.inference);
  const { register } = useSuperwallGate();
  const focused = useRef(true);
  const accountChanged = useRef(false);
  const requestBusy = useRef(false);
  const requestGeneration = useRef(0);
  const processingChoice = useRef<{
    isPrivate: boolean;
    provider: string;
    remoteCleanup: boolean;
  } | null>(null);
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
      return { target, route, error: '' };
    } catch (cause) {
      return { target: null, route: null, error: errorMessage(cause) };
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
      !preview.route
    )
      return;
    const route = preview.route;
    const user = useAuthStore.getState().user;
    if (route.provider === 'cloud' && accountRequiredForCloud(user)) {
      showAccountRequiredAlert('audio import');
      return;
    }
    destination.current = preview.target;
    processingChoice.current = {
      isPrivate: preview.target.isPrivate,
      provider: route.provider,
      remoteCleanup: route.cleanupRoute?.mode === 'providers',
    };
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
  const choice =
    isProcessing || gating
      ? processingChoice.current
      : {
          isPrivate: mode === 'private',
          provider: preview.route?.provider,
          remoteCleanup: preview.route?.cleanupRoute?.mode === 'providers',
        };
  return (
    <Page title={t('importAudio')} back showAccount={false}>
      <Card>
        <Text style={styles.heading}>{t('importTitle')}</Text>
        <Text style={styles.body}>{t('importFormats')}</Text>
        <Text style={styles.body}>
          {t('importSaveTo', {
            destination:
              (isProcessing ? destination.current : preview.target)?.label ??
              t('importUnavailable'),
          })}
        </Text>
        <Text style={styles.body}>
          {choice?.isPrivate
            ? choice.remoteCleanup
              ? t('importPrivateRemoteCleanup')
              : t('importPrivateLocal')
            : choice?.provider === 'local'
              ? t('importLocal')
              : choice?.provider === 'byok'
                ? t('importByok')
                : t('importCloud')}
        </Text>
        {isProcessing ? (
          <>
            <Text style={styles.body} accessibilityLiveRegion="polite">
              {stage === 'cleaning' ? t('importFormatting') : t('importProcessing')}
            </Text>
            <Button label={t('importCancel')} secondary onPress={cancel} />
          </>
        ) : (
          <Button
            label={t('importChoose')}
            disabled={gating || accountChanged.current || !!preview.error}
            onPress={() => {
              void start();
            }}
          />
        )}
      </Card>
      {error || preview.error ? (
        <Card>
          <Text style={styles.heading} accessibilityRole="alert">
            {t('importFailure')}
          </Text>
          <Text style={styles.body}>{error || preview.error}</Text>
          <Button
            label={t('models')}
            secondary
            onPress={() => router.push('/(account)/ai-models')}
          />
        </Card>
      ) : null}
      {currentText ? (
        <Card>
          <Text style={styles.heading}>{t('importTranscript')}</Text>
          <Text style={styles.body} selectable>
            {currentText}
          </Text>
          {!isProcessing && error ? (
            <Button
              label={t('importCopyTranscript')}
              secondary
              onPress={() => {
                void Clipboard.setStringAsync(currentText)
                  .then(() => Alert.alert(t('copied'), t('importCopied')))
                  .catch(() => Alert.alert(t('importCopyFailed'), t('retry')));
              }}
            />
          ) : null}
        </Card>
      ) : null}
    </Page>
  );
}
