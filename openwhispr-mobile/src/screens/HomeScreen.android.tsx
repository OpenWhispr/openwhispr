import { toFriendlyTranscriptionErrorMessage } from '@/lib/transcriptionErrors';
import { StorageService } from '@/services/storage/StorageService.android';
import type { Transcript } from '@/types';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Alert,
  Easing,
  Platform,
  ScrollView,
  View,
} from 'react-native';
import { useBubbleResult } from '@/android/bubbleResult';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useScrollToTop } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { useTranscriptStore } from '@/store/useTranscriptStore.android';
import { useAppInit } from '@/hooks/useAppInit';
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
  IconTile,
  PillButton,
  SectionHeader,
  type,
} from '@/android/home/kit';
import { edgeCard, look } from '@/android/settings/look';
import { BubbleCard } from '@/android/home/BubbleCard';
import { Notch, NOTCH_REACH } from '@/android/home/Notch';
import { notchAnnouncement, notchStateFor, type NotchModel } from '@/android/home/notchModel';
import { OlderRecordingsRow, OlderRecordingsSheet } from '@/android/home/OlderRecordings';
import { HistoryCard, Stats, Tips } from '@/android/home/Sections';
import { TryItRecorder } from '@/android/home/TryItRecorder';
import { homeStats, localDate } from '@/android/home/model';

const GUTTER = 16;
/** Home stacks its sections this far apart. */
const SECTION_GAP = 20;
/** Room below the card while the notch is out: its reach plus 12 px before the next section. */
const NOTCH_SPACE = NOTCH_REACH + 12 - SECTION_GAP;
const SCROLL_TO_HISTORY_MS = 950;
/** Home shows the newest History rows; "See all history" opens the rest. */
const HOME_HISTORY_ROWS = 5;
const CARD_TITLE = { fontSize: 16, lineHeight: 22, fontWeight: '500' as const, color: home.text };

/** ScrollView's own animated scroll is quick and fixed; this one eases in and out slowly. */
function smoothScroll(
  view: ScrollView | null,
  from: number,
  to: number,
  done: () => void,
): () => void {
  if (!view || Math.abs(to - from) < 2) {
    done();
    return () => undefined;
  }
  const start = Date.now();
  let frame = 0;
  const step = () => {
    const t = Math.min(1, (Date.now() - start) / SCROLL_TO_HISTORY_MS);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    view.scrollTo({ y: from + (to - from) * eased, animated: false });
    if (t < 1) frame = requestAnimationFrame(step);
    else done();
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}
// Android 13 and later confirm every copy with their own pill at the bottom of the screen;
// a second one from the app would sit on top of it.
const SYSTEM_CONFIRMS_COPY = Platform.OS === 'android' && Number(Platform.Version) >= 33;

export default function AndroidHome() {
  useAppInit();
  const { t } = useTranslation();
  const h = useHomeT();
  // Recordings saved on this phone before accounts; loaded while signed out.
  const [archive, setArchive] = useState<Transcript[] | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
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
  const scroll = useRef<ScrollView>(null);
  useScrollToTop(scroll);
  const navigationRevision = useRef(0);
  const retryController = useRef<AbortController | null>(null);
  const [working, setWorking] = useState(false);
  // What the processing notch under the bubble card shows, from the moment work starts until
  // its done state has slid back into the card.
  const [notch, setNotch] = useState<NotchModel | null>(null);
  const [cardWidth, setCardWidth] = useState(0);
  const [cardHeight, setCardHeight] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // Room below the card for the notch: open only while the notch is out, so the sections
  // below move down with it and back up as it leaves.
  const notchSpace = useRef(new Animated.Value(0)).current;
  // Cancelled or failed work slides its notch back; a finished one does after its done state.
  const closeNotch = () =>
    setNotch((current) => current && (current.doneText ? current : { ...current, closing: true }));
  const uploadDone = useRef(false);
  const uploadStartedAt = useRef(0);
  // Set when an upload or dictation finished: take the person to its new History row once
  // the progress card has gone. Holds the time the work started, so an older row (history
  // off, nothing saved) is never mistaken for the new one.
  const revealNewest = useRef<number | null>(null);
  const historyY = useRef(0);
  const historyRef = useRef<View>(null);
  const [highlight, setHighlight] = useState<{ id: string; arriving: boolean } | null>(null);
  const scrollY = useRef(0);
  const [toast, setToast] = useState({ message: '', id: 0 });
  const showToast = useCallback(
    (message: string) => setToast((previous) => ({ message, id: previous.id + 1 })),
    [],
  );
  const { stage, cancel, pickAndTranscribeFile } = useFileUpload({
    onError: (error) => Alert.alert(t('errorTitle'), error.message),
    onPicked: (name, size) =>
      setNotch({ flow: 'upload', name, size, startedAt: Date.now(), doneText: null }),
    onComplete: () => {
      uploadDone.current = true;
      revealNewest.current = uploadStartedAt.current;
      setNotch((current) => current && { ...current, doneText: h('addedToHistory') });
    },
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
        showAccountRequiredAlert(h('dictate'));
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
    const startedAt = Date.now();
    setNotch({ flow: 'dictate', startedAt, doneText: null });
    let finished = false;
    const controller = new AbortController();
    tryController.current = controller;
    try {
      const text = await processAndroidAudio(recording, job, controller.signal, () => undefined);
      if (controller.signal.aborted) return;
      finished = true;
      revealNewest.current = startedAt;
      setNotch(
        (current) =>
          current && {
            ...current,
            doneText: historyEnabled ? h('copiedAddedToHistory') : h('copied'),
          },
      );
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
      // A finished one slides back once its done state has shown; anything else now.
      if (!finished) closeNotch();
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
      setNotch(null);
      uploadDone.current = false;
      uploadStartedAt.current = Date.now();
      try {
        await pickAndTranscribeFile();
      } catch {
        // The upload hook displayed the error and retained retryable audio.
      } finally {
        await applyHistoryRetention().catch(() => undefined);
        action.current = false;
        setWorking(false);
        // A finished upload slides back once its done state has shown; a cancelled or failed
        // one at once.
        if (!uploadDone.current) closeNotch();
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
    const controller = new AbortController();
    retryController.current = controller;
    setNotch({ flow: 'retry', startedAt: Date.now(), doneText: null });
    let retried = false;
    try {
      await useTranscriptStore.getState().retryTranscript(id, controller.signal);
      retried = !controller.signal.aborted;
      if (retried) setNotch((current) => current && { ...current, doneText: h('addedToHistory') });
    } catch (error) {
      if (!controller.signal.aborted && (error as Error)?.name !== 'AbortError') {
        Alert.alert(t('errorTitle'), toFriendlyTranscriptionErrorMessage(error));
      }
    } finally {
      if (!controller.signal.aborted) await applyHistoryRetention().catch(() => undefined);
      retryController.current = null;
      action.current = false;
      setWorking(false);
      if (!retried) closeNotch();
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
    setArchiveOpen(false);
    return () => retryController.current?.abort();
  }, [user?.id]);
  useFocusEffect(
    useCallback(() => {
      if (user) return;
      let current = true;
      StorageService.getUnassignedTranscripts()
        .then((items) => {
          if (current) setArchive(items);
        })
        .catch(() => undefined);
      return () => {
        current = false;
      };
    }, [user]),
  );
  useEffect(() => {
    applyHistoryRetention().catch(() => undefined);
  }, []);
  // A dictation the bubble couldn't type is shown at the top; bring it into view.
  const rescued = Boolean(pending.text || pending.error);
  useEffect(() => {
    if (rescued) scroll.current?.scrollTo({ y: 0, animated: true });
  }, [rescued, pending.text, pending.error]);
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

  const busy = trying || recorderOpen || working || notch !== null;
  // The upload ring ticks while the file goes up; nothing else needs a clock.
  const uploadingNow = notch?.flow === 'upload' && !notch.doneText && stage !== 'cleaning';
  useEffect(() => {
    if (!uploadingNow) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [uploadingNow]);
  // If a notch goes without sliding back (new work replacing it), close its room anyway.
  useEffect(() => {
    if (notch !== null) return;
    const animation = Animated.timing(notchSpace, {
      toValue: 0,
      duration: 200,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [notch, notchSpace]);
  const cancelWork = () => {
    if (retryController.current) retryController.current.abort();
    else cancel();
  };
  const notchState = notchStateFor(notch, stage, now, h, cancelWork);
  const announcement = notchAnnouncement(notchState, notch, stage, now, h);
  useEffect(() => {
    if (announcement) AccessibilityInfo.announceForAccessibility(announcement);
  }, [announcement]);
  const recent = [...history].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
  const newestId = recent[0]?.id;
  const newestAt = recent[0]?.createdAt ?? 0;
  // Once a finished upload's or dictation's notch has slid back, take the person to the new row.
  useEffect(() => {
    const since = revealNewest.current;
    if (notch !== null || since === null || !newestId) return;
    revealNewest.current = null;
    if (newestAt < since) return;
    // Highlight the new row only once the slow scroll has brought it to the top.
    setHighlight({ id: newestId, arriving: false });
    let arrive: ReturnType<typeof setTimeout> | undefined;
    let stop = () => {};
    // Start once the gap the progress card left has closed, so History's position is current.
    const settle = setTimeout(() => {
      const start = (y: number) => {
        stop = smoothScroll(scroll.current, scrollY.current, Math.max(0, y - 8), () => {
          arrive = setTimeout(() => setHighlight({ id: newestId, arriving: true }), 120);
        });
      };
      // Measured against the scroll view's frame, so add how far it is already scrolled.
      const frame = scroll.current?.getNativeScrollRef();
      if (historyRef.current && frame)
        historyRef.current.measureLayout(
          frame,
          (_x, y) => start(y + scrollY.current),
          () => start(historyY.current),
        );
      else start(historyY.current);
    }, 150);
    return () => {
      clearTimeout(settle);
      stop();
      if (arrive) clearTimeout(arrive);
    };
  }, [notch, newestId, newestAt]);

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: look.canvas }}
      edges={['top', 'left', 'right']}
    >
      <View
        style={{
          flexDirection: 'row',
          paddingLeft: GUTTER,
          paddingRight: GUTTER - 6,
          minHeight: 56,
          alignItems: 'center',
        }}
      >
        <View style={{ flex: 1 }} />
        <AccountAvatar />
      </View>
      <ScrollView
        ref={scroll}
        scrollEventThrottle={16}
        onScroll={({ nativeEvent }) => {
          scrollY.current = nativeEvent.contentOffset.y;
        }}
        contentContainerStyle={{
          paddingHorizontal: GUTTER,
          paddingTop: 8,
          paddingBottom: 96,
          gap: SECTION_GAP,
          width: '100%',
          maxWidth: 680,
          alignSelf: 'center',
        }}
      >
        {/* The notch hangs below the card. While it is out, this wrapper reaches below the
            card far enough to hold it, so its ✕ gets touches and it never covers what comes
            next; the notch opens and closes that room as it moves. */}
        <Animated.View
          onLayout={({ nativeEvent }) => setCardWidth(Math.round(nativeEvent.layout.width))}
          style={{ paddingBottom: notchSpace }}
        >
          {notchState ? (
            <Notch
              key={notch?.startedAt}
              state={notchState}
              cardWidth={cardWidth}
              top={cardHeight}
              space={notchSpace}
              spaceOpen={NOTCH_SPACE}
              onFinished={() => setNotch(null)}
            />
          ) : null}
          <View
            onLayout={({ nativeEvent }) => setCardHeight(Math.round(nativeEvent.layout.height))}
          >
            <BubbleCard
              busy={busy}
              onDictate={() => {
                void openTryIt();
              }}
              onUpload={() => {
                void upload();
              }}
            />
          </View>
        </Animated.View>
        {pending.text || pending.error ? (
          <View style={[edgeCard, { padding: 14, gap: 12 }]}>
            {/* A tile and a title say why the card is here: the bubble couldn't type the text,
                or something failed and this is what was kept. */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <IconTile
                icon={pending.text ? 'Save' : 'TriangleAlert'}
                color={pending.text ? home.text : home.error}
              />
              <View style={{ flex: 1, gap: 2 }}>
                {pending.text ? <Text style={CARD_TITLE}>{h('savedInOpenWhispr')}</Text> : null}
                <Text
                  accessibilityRole={pending.error ? 'alert' : undefined}
                  style={pending.text ? type.footnote : [CARD_TITLE, { fontWeight: '400' }]}
                >
                  {!pending.error || pending.error === t('insertionFailed')
                    ? h('bubbleCouldntType')
                    : pending.error}
                </Text>
              </View>
            </View>
            {pending.text ? (
              <Text selectable style={{ fontSize: 17, lineHeight: 24, color: home.text }}>
                {pending.text}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {pending.text ? (
                <PillButton icon="Copy" label={h('copy')} onPress={() => copy(pending.text)} />
              ) : null}
              <PillButton label={t('close')} onPress={pending.dismiss} />
            </View>
          </View>
        ) : null}
        <Tips />
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
        <View
          ref={historyRef}
          style={{ gap: 8 }}
          onLayout={({ nativeEvent }) => {
            historyY.current = nativeEvent.layout.y;
          }}
        >
          <SectionHeader title={h('history')} />
          {historyError ? (
            <View style={[edgeCard, { padding: 14, gap: 12 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <IconTile icon="TriangleAlert" color="#C27A00" />
                <Text accessibilityRole="alert" style={[CARD_TITLE, { flex: 1 }]}>
                  {historyError}
                </Text>
              </View>
              <PillButton
                icon="RotateCcw"
                label={t('retry')}
                style={{ flex: 0 }}
                onPress={() => {
                  useTranscriptStore
                    .getState()
                    .loadTranscripts()
                    .catch(() => undefined);
                }}
              />
            </View>
          ) : null}
          {!history.length && !historyError ? (
            <View style={[edgeCard, { padding: 14, gap: 4 }]}>
              <Text style={CARD_TITLE}>{t('emptyHistory')}</Text>
              <Text style={type.footnote}>{t('emptyHistoryBody')}</Text>
            </View>
          ) : null}
          {recent.length ? (
            <HistoryCard
              items={recent.slice(0, HOME_HISTORY_ROWS)}
              onSeeAll={() => router.push('/android-home-history')}
              highlightId={highlight?.id ?? null}
              highlightArriving={Boolean(highlight?.arriving)}
              busy={working}
              onCopy={copy}
              onRetry={(id) => {
                void retry(id);
              }}
            />
          ) : null}
          {!user && archive?.length ? (
            <OlderRecordingsRow count={archive.length} onPress={() => setArchiveOpen(true)} />
          ) : null}
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
      <OlderRecordingsSheet
        visible={!user && archiveOpen}
        items={archive ?? []}
        onClose={() => setArchiveOpen(false)}
        onCopy={copy}
      />
    </SafeAreaView>
  );
}
