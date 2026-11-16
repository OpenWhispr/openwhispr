import { toFriendlyTranscriptionErrorMessage } from '@/lib/transcriptionErrors';
import { StorageService } from '@/services/storage/StorageService.android';
import type { Transcript } from '@/types';
import { AppState, Modal, Alert, Platform, ScrollView, View } from 'react-native';
import { useBubbleResult } from '@/android/bubbleResult';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { useTranscriptStore } from '@/store/useTranscriptStore.android';
import { useAppInit } from '@/hooks/useAppInit';
import { Page, Card, Button, Row, styles } from '@/android/ui';
import { useConfigStore } from '@/store/useConfigStore';
import { useInsights, refreshInsights } from '@/android/insights';
import {
  AndroidCleanupError,
  applyHistoryRetention,
  createAndroidJob,
  ensureAndroidModels,
  processAndroidAudio,
  type AndroidJob,
} from '@/android/pipeline';
import { useFileUpload } from '@/hooks/useFileUpload.android';
import { getTranscriptionProvider } from '@/lib/inferenceRouting';
import { accountRequiredForCloud, showAccountRequiredAlert } from '@/lib/accountAccess';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { buildUsageGateParams, SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import type { Recording } from '../../modules/android-dictation/src';
import { useHomeT } from '@/android/home/strings';
import {
  AccountAvatar,
  HomeToast,
  home,
  PillButton,
  SectionHeader,
  type,
} from '@/android/home/kit';
import { BubbleCard, UploadProgress } from '@/android/home/BubbleCard';
import { HistoryCard, Stats, Tips } from '@/android/home/Sections';
import { TryItRecorder } from '@/android/home/TryItRecorder';
import { homeStats, localDate } from '@/android/home/model';

const GUTTER = 16;
// Android 13 and later confirm every copy with their own pill at the bottom of the screen;
// a second one from the app would sit on top of it.
const SYSTEM_CONFIRMS_COPY = Platform.OS === 'android' && Number(Platform.Version) >= 33;

export default function AndroidHome() {
  useAppInit();
  const { t } = useTranslation();
  const h = useHomeT();
  const [archive, setArchive] = useState<Transcript[] | null>(null);
  const pending = useBubbleResult();
  const insights = useInsights();
  const syncInsights = useConfigStore((s) => s.config?.insightsSyncEnabled === true);
  const historyEnabled = useConfigStore((s) => s.config?.androidHistoryDays !== 0);
  const history = useTranscriptStore((s) => s.transcripts);
  const historyError = useTranscriptStore((s) => s.error);
  const user = useAuthStore((s) => s.user);
  const usage = useUsageStore((s) => s.usage);
  const { register } = useSuperwallGate();
  const action = useRef(false);
  const navigationRevision = useRef(0);
  const retryController = useRef<AbortController | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [working, setWorking] = useState(false);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [toast, setToast] = useState({ message: '', id: 0 });
  const showToast = useCallback(
    (message: string) => setToast((previous) => ({ message, id: previous.id + 1 })),
    [],
  );
  const { isProcessing, stage, cancel, pickAndTranscribeFile } = useFileUpload({
    onError: (error) => Alert.alert(t('errorTitle'), error.message),
    onPicked: (name) => setUploadName(name),
    onComplete: () => showToast(h('addedToHistory')),
  });

  // Try it: record over Home, then transcribe exactly as the bubble does.
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [trying, setTrying] = useState(false);
  const tryJob = useRef<AndroidJob | null>(null);
  const tryController = useRef<AbortController | null>(null);
  const openTryIt = async () => {
    if (trying || recorderOpen) return;
    try {
      const job = createAndroidJob('dictate');
      if (job.route.provider === 'cloud' && accountRequiredForCloud(user)) {
        showAccountRequiredAlert(h('tryIt'));
        return;
      }
      await ensureAndroidModels(job);
      tryJob.current = job;
      setRecorderOpen(true);
    } catch (error) {
      Alert.alert(t('errorTitle'), (error as Error).message);
    }
  };
  const finishTryIt = async (recording: Recording) => {
    setRecorderOpen(false);
    const job = tryJob.current;
    tryJob.current = null;
    if (!job) return;
    setTrying(true);
    const controller = new AbortController();
    tryController.current = controller;
    try {
      const text = await processAndroidAudio(recording, job, controller.signal, () => undefined);
      if (controller.signal.aborted) return;
      await Clipboard.setStringAsync(text);
      if (!SYSTEM_CONFIRMS_COPY) showToast(h('copied'));
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof AndroidCleanupError)
        useBubbleResult.getState().setResult(error.transcript, t('cleanupRecovery'));
      else Alert.alert(t('errorTitle'), (error as Error).message);
    } finally {
      void FileSystem.deleteAsync(recording.uri, { idempotent: true }).catch(() => undefined);
      if (tryController.current === controller) tryController.current = null;
      setTrying(false);
    }
  };
  useEffect(() => () => tryController.current?.abort(), []);

  const upload = async () => {
    if (action.current) return;
    const startedOnVisit = navigationRevision.current;
    const provider = getTranscriptionProvider('upload');
    if (provider === 'cloud' && accountRequiredForCloud(user)) {
      showAccountRequiredAlert(t('upload'));
      return;
    }
    const begin = async () => {
      if (action.current || startedOnVisit !== navigationRevision.current) return;
      action.current = true;
      setWorking(true);
      setUploadName(null);
      try {
        await pickAndTranscribeFile();
      } catch {
        // The upload hook displayed the error and retained retryable audio.
      } finally {
        await applyHistoryRetention().catch(() => undefined);
        action.current = false;
        setWorking(false);
        setUploadName(null);
      }
    };
    if (provider === 'cloud' && user) {
      try {
        await register({
          placement: SUPERWALL_PLACEMENTS.audioUploadStart,
          params: usage ? buildUsageGateParams(usage) : undefined,
          requiresAccount: false,
          feature: () => {
            void begin();
          },
        });
      } catch (error) {
        Alert.alert(t('errorTitle'), (error as Error).message);
      }
    } else await begin();
  };
  const retry = async (id: string) => {
    if (action.current) return;
    action.current = true;
    setWorking(true);
    setRetrying(true);
    const controller = new AbortController();
    retryController.current = controller;
    try {
      await useTranscriptStore.getState().retryTranscript(id, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && (error as Error)?.name !== 'AbortError') {
        Alert.alert(t('errorTitle'), toFriendlyTranscriptionErrorMessage(error));
      }
    } finally {
      if (!controller.signal.aborted) await applyHistoryRetention().catch(() => undefined);
      retryController.current = null;
      action.current = false;
      setRetrying(false);
      setWorking(false);
    }
  };
  const copy = (text: string) => {
    Clipboard.setStringAsync(text)
      .then(() => {
        if (!SYSTEM_CONFIRMS_COPY) showToast(h('copied'));
      })
      .catch((error: Error) => Alert.alert(t('errorTitle'), error.message));
  };
  useEffect(() => {
    setArchive(null);
    return () => retryController.current?.abort();
  }, [user?.id]);
  useEffect(() => {
    applyHistoryRetention().catch(() => undefined);
  }, []);
  useFocusEffect(
    useCallback(() => {
      void refreshInsights();
      return () => {
        navigationRevision.current += 1;
        cancel();
        retryController.current?.abort();
      };
    }, [cancel, user?.id, syncInsights, historyEnabled]),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshInsights();
    });
    return () => subscription.remove();
  }, []);

  const expectedScope = user && !user.isAnonymous ? `account:${user.id}` : 'device';
  const ledger =
    insights.scope === expectedScope ? insights.ledger : { events: [], summary: undefined };
  const accountRequested = syncInsights && historyEnabled && expectedScope.startsWith('account:');
  const accountStats = accountRequested && !insights.consentPaused;
  const accountSummary = accountStats ? ledger.summary : undefined;
  const stats = homeStats(ledger.events, accountSummary, accountStats, localDate());
  const status = insights.scope === expectedScope ? insights.status : 'loading';
  const acknowledged = new Set('acknowledged' in ledger ? ledger.acknowledged : []);
  const hasPending = ledger.events.some((event) => !acknowledged.has(event.event_id));
  const statsFeedback =
    accountRequested && insights.consentPaused
      ? 'statsPaused'
      : !accountStats
        ? undefined
        : status === 'blocked'
          ? 'syncPolicy'
          : status === 'offline'
            ? accountSummary
              ? 'statsOffline'
              : 'statsUnavailable'
            : status === 'loading' || !accountSummary
              ? 'statsLoading'
              : hasPending
                ? 'statsPending'
                : undefined;
  const statsRetry = accountStats && (status === 'offline' || status === 'blocked');
  const uploading = isProcessing && uploadName !== null;
  const recent = [...history].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: home.canvas }}
      edges={['top', 'left', 'right']}
    >
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'flex-end',
          paddingHorizontal: GUTTER - 8,
          minHeight: 52,
          alignItems: 'center',
        }}
      >
        <AccountAvatar />
      </View>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: GUTTER,
          paddingTop: 8,
          paddingBottom: 96,
          gap: 20,
          width: '100%',
          maxWidth: 680,
          alignSelf: 'center',
        }}
      >
        <BubbleCard
          tryItLabel={trying ? h('processing') : h('tryIt')}
          tryItDisabled={trying || recorderOpen}
          onTryIt={() => {
            void openTryIt();
          }}
          uploadLabel={uploading ? h('writingItUp') : h('uploadAudio')}
          uploadDisabled={working}
          onUpload={() => {
            void upload();
          }}
        />
        {uploading || retrying ? (
          <UploadProgress
            fileName={retrying ? '' : (uploadName ?? '')}
            cleaning={!retrying && stage === 'cleaning'}
            onCancel={() => {
              if (retryController.current) retryController.current.abort();
              else cancel();
            }}
          />
        ) : null}
        {pending.text || pending.error ? (
          <View
            style={{
              backgroundColor: home.surface,
              borderRadius: 20,
              padding: 16,
              gap: 12,
              boxShadow: home.cardShadow,
            }}
          >
            {pending.error ? (
              <Text accessibilityRole="alert" style={type.footnote}>
                {pending.error}
              </Text>
            ) : null}
            {pending.text ? (
              <Text selectable style={[type.subhead, { fontSize: 17, lineHeight: 24 }]}>
                {pending.text}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {pending.text ? (
                <PillButton primary label={h('copy')} onPress={() => copy(pending.text)} />
              ) : null}
              <PillButton label={t('close')} onPress={pending.dismiss} />
            </View>
          </View>
        ) : null}
        <Tips gutter={GUTTER} />
        <Stats
          stats={stats}
          feedback={
            statsFeedback || statsRetry ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {statsFeedback ? (
                  <Text accessibilityLiveRegion="polite" style={[type.footnote, { flex: 1 }]}>
                    {t(statsFeedback)}
                  </Text>
                ) : (
                  <View style={{ flex: 1 }} />
                )}
                {statsRetry ? (
                  <Text
                    accessibilityRole="button"
                    suppressHighlighting
                    onPress={() => {
                      void refreshInsights();
                    }}
                    style={[type.footnote, { color: home.accent, paddingVertical: 8 }]}
                  >
                    {h('retry')}
                  </Text>
                ) : null}
              </View>
            ) : undefined
          }
        />
        <View style={{ gap: 12 }}>
          <SectionHeader title={h('history')} />
          {historyError ? (
            <Card>
              <Text accessibilityRole="alert">{historyError}</Text>
              <Button
                secondary
                label={t('retry')}
                onPress={() => {
                  useTranscriptStore
                    .getState()
                    .loadTranscripts()
                    .catch(() => undefined);
                }}
              />
            </Card>
          ) : null}
          {!history.length && !historyError ? (
            <View
              style={{
                backgroundColor: home.surface,
                borderRadius: 14,
                padding: 16,
                gap: 4,
                boxShadow: home.cardShadow,
              }}
            >
              <Text style={type.headline}>{t('emptyHistory')}</Text>
              <Text style={type.footnote}>{t('emptyHistoryBody')}</Text>
            </View>
          ) : null}
          {recent.length ? (
            <HistoryCard
              items={recent}
              busy={working}
              onCopy={copy}
              onRetry={(id) => {
                void retry(id);
              }}
            />
          ) : null}
          {!user && (
            <Row
              title={t('olderDeviceHistory')}
              onPress={() => {
                StorageService.getUnassignedTranscripts()
                  .then(setArchive)
                  .catch((error: Error) => Alert.alert(t('errorTitle'), error.message));
              }}
            />
          )}
        </View>
      </ScrollView>
      <HomeToast message={toast.message} showId={toast.id} />
      {recorderOpen ? (
        <TryItRecorder
          onCancel={() => {
            tryJob.current = null;
            setRecorderOpen(false);
          }}
          onDone={(recording) => {
            void finishTryIt(recording);
          }}
        />
      ) : null}
      <Modal
        visible={!user && archive !== null}
        animationType="slide"
        onRequestClose={() => setArchive(null)}
      >
        <SafeAreaView style={styles.page}>
          <Page
            title={t('olderDeviceHistory')}
            showAccount={false}
            footer={<Button secondary label={t('close')} onPress={() => setArchive(null)} />}
          >
            <Text style={styles.body}>{t('olderDeviceHistoryBody')}</Text>
            {!archive?.length && <Text>{t('emptyHistory')}</Text>}
            {!user &&
              archive?.map((item) => (
                <Card key={item.id}>
                  <Text style={styles.caption}>
                    {new Date(item.createdAt).toLocaleDateString()}
                  </Text>
                  <Text selectable>
                    {item.text || item.errorMessage || t('olderDeviceHistoryAudio')}
                  </Text>
                  {item.audioUrl && (
                    <Text style={styles.caption}>{t('olderDeviceHistoryAudio')}</Text>
                  )}
                </Card>
              ))}
          </Page>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}
