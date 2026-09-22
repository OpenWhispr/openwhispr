import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, ScrollView, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/Text';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  FadeInDown,
  FadeOutDown,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useAudioRecording } from '@/hooks/useAudioRecording';
import { useAudioWaveform } from '@/hooks/useAudioWaveform';
import { useFileUpload } from '@/hooks/useFileUpload';
import { useUsageLimitRecovery } from '@/hooks/useUsageLimitRecovery';
import { useTranscriptStore } from '@/store/useTranscriptStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useModelDownloadStore } from '@/store/useModelDownloadStore';
import { useUsageStore } from '@/store/useUsageStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useHandoffStore } from '@/store/useHandoffStore';
import { useAppInit } from '@/hooks/useAppInit';
import { TranscriptionService } from '@/services/transcription/TranscriptionService';
import {
  getPrivateModeReadiness,
  getPrivateModeUnavailableMessage,
  promptLocalModelFallback,
} from '@/lib/privateMode';
import { getPreferredTranscriptionLanguage } from '@/lib/transcriptionLanguage';
import {
  accountRequiredForCloud,
  cloudModeRequiresAccount,
  showAccountRequiredAlert,
} from '@/lib/accountAccess';
import { isMicPermissionError, isNoSpeechError, showMicPermissionAlert } from '@/lib/permissions';
import { formatRelativeTime, safeHaptics } from '@/lib/utils';
import { BRAND, iosColor } from '@/config/colors';
import { ProcessingWaveform } from '@/components/features/WaveformVisualizer';
import { AppGroupStorage, APP_GROUP_KEYS } from '../../modules/app-group-storage/src';
import { TranscriptModal } from '@/components/features/TranscriptModal';
import { RecordingOverlay } from '@/components/features/RecordingOverlay';
import { ParakeetNudgeBanner } from '@/components/features/ParakeetNudgeBanner';
import { KeyboardFullAccessBanner } from '@/components/features/KeyboardFullAccessBanner';
import { SwipeableCard } from '@/components/ui/SwipeableCard';
import { Glass } from '@/components/ui/Glass';
import { CloudIcon } from '@/components/ui/CloudIcon';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { DictationModeControl } from '@/components/ui/DictationModeControl';
import { UsageLimitBanner } from '@/components/ui/UsageMeter';
import { GradientGlassSurface } from '@/components/ui/GradientGlassSurface';
import { Transcript } from '@/types';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { buildUsageGateParams, SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { ProAccessConfirmation } from '@/components/billing/ProAccessConfirmation';

function HandoffPhoneIllustration({ transcribing }: { transcribing: boolean }) {
  const pulse = useSharedValue(0);

  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(withTiming(1, { duration: 1300 }), withTiming(0, { duration: 200 })),
      -1,
      false,
    );
    return () => cancelAnimation(pulse);
  }, [pulse]);

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: 0.18 + pulse.value * 0.42,
    transform: [{ scale: 0.4 + pulse.value * 0.9 }],
  }));

  return (
    <View style={handoffStyles.phoneFrame}>
      <View style={handoffStyles.phoneInner}>
        <View style={handoffStyles.waveformWrapper}>
          <ProcessingWaveform color={iosColor('label')} size={44} />
          <Text style={handoffStyles.illustrationCaption}>
            {transcribing ? 'Transcribing' : 'Listening'}
          </Text>
          <Text style={handoffStyles.illustrationSubcaption}>iPhone Microphone</Text>
        </View>

        <View style={handoffStyles.homeIndicatorRow}>
          <View style={handoffStyles.homeIndicator} />
          <Animated.View style={[handoffStyles.pulseCircle, pulseStyle]} />
        </View>
      </View>
    </View>
  );
}

type ModeToast = {
  text: string;
  name: string;
  mdName: LucideIconName;
  color: string;
};

export default function HomeScreen() {
  useAppInit();
  const params = useLocalSearchParams<{ proCompletion?: string }>();
  const proCompletion =
    params.proCompletion === 'purchased' || params.proCompletion === 'restored'
      ? params.proCompletion
      : null;
  const consumeProCompletion = useCallback((): void => {
    router.setParams({ proCompletion: undefined });
  }, []);
  const insets = useSafeAreaInsets();
  const [selectedTranscript, setSelectedTranscript] = useState<Transcript | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [showCopiedToast, setShowCopiedToast] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [modeToast, setModeToast] = useState<ModeToast | null>(null);
  const modeToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isKeyboardHandoffSession = useHandoffStore((s) => s.isActive);
  const isCheckingInitialUrl = useHandoffStore((s) => s.isCheckingInitialUrl);
  const handoffNoSpeech = useHandoffStore((s) => s.noSpeechDetected);
  const handoffTranscribing = useHandoffStore((s) => s.isTranscribing);
  const [showNoSpeechToast, setShowNoSpeechToast] = useState(false);
  const { register: registerSuperwallGate } = useSuperwallGate();
  const transcripts = useTranscriptStore((state) => state.transcripts);
  const deleteTranscript = useTranscriptStore((state) => state.deleteTranscript);
  const retryTranscript = useTranscriptStore((state) => state.retryTranscript);
  const activeMode = useProcessingModeStore((state) => state.activeMode);
  const setActiveMode = useProcessingModeStore((state) => state.setActiveMode);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const downloadCompletedCount = useModelDownloadStore((state) => state.completedCount);
  const user = useAuthStore((state) => state.user);
  const usage = useUsageStore((state) => state.usage);
  const loadUsage = useUsageStore((state) => state.load);
  const [localModelStatus, setLocalModelStatus] = useState<
    'checking' | 'missing' | 'ready' | 'unavailable'
  >('checking');
  const [retryingTranscriptIds, setRetryingTranscriptIds] = useState<Record<string, boolean>>({});
  const isPrivateMode = activeMode === 'private';
  const { handleUsageLimitReached, isRecoveringUsageLimit } = useUsageLimitRecovery();

  const showCopied = useCallback(() => {
    setShowCopiedToast(true);
    setTimeout(() => setShowCopiedToast(false), 2500);
  }, []);

  const showModeToast = useCallback((toast: ModeToast) => {
    setModeToast(toast);
    if (modeToastTimer.current) clearTimeout(modeToastTimer.current);
    modeToastTimer.current = setTimeout(() => setModeToast(null), 2000);
  }, []);

  useEffect(() => {
    return () => {
      if (modeToastTimer.current) clearTimeout(modeToastTimer.current);
    };
  }, []);

  const {
    isRecording,
    isProcessing,
    isSupported,
    startRecording,
    stopRecording,
    cancelRecording,
    audioRecorder,
  } = useAudioRecording({
    onComplete: (text) => {
      Clipboard.setStringAsync(text);
      showCopied();
      if (useProcessingModeStore.getState().activeMode === 'cloud') {
        useUsageStore.getState().load(true);
      }
    },
    onError: (error) => {
      if (isMicPermissionError(error)) {
        // Only redirect to Settings when iOS couldn't show its own prompt.
        // If the native dialog just appeared, the user's tap on Deny is
        // feedback enough — showing our own alert on top of it reads as
        // steering users to Settings instead of the system permission flow.
        if (!error.nativePromptShown) {
          showMicPermissionAlert();
        }
        return;
      }
      if (isNoSpeechError(error)) {
        setShowNoSpeechToast(true);
        setTimeout(() => setShowNoSpeechToast(false), 2500);
        return;
      }
      Alert.alert('Error', error.message);
    },
    onLocalModelMissing: promptLocalModelFallback,
    onUsageLimitReached: handleUsageLimitReached,
  });

  const { currentAmplitude, waveformData } = useAudioWaveform(audioRecorder, isRecording);

  const { isProcessing: isFileProcessing, pickAndTranscribeFile } = useFileUpload({
    onComplete: (text) => {
      Clipboard.setStringAsync(text);
      showCopied();
      if (useProcessingModeStore.getState().activeMode === 'cloud') {
        useUsageStore.getState().load(true);
      }
    },
    onError: (error) => Alert.alert('Error', error.message),
    onLocalModelMissing: promptLocalModelFallback,
    onUsageLimitReached: handleUsageLimitReached,
  });

  const requireAccountForCloudProcessing = useCallback(
    (feature: string) => {
      if (!cloudModeRequiresAccount(activeMode, user)) return false;
      showAccountRequiredAlert(feature);
      return true;
    },
    [activeMode, user],
  );

  useEffect(() => {
    if (isRecording) {
      setRecordingDuration(0);
      timerRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording]);

  const refreshLocalModelStatus = useCallback(async () => {
    try {
      setLocalModelStatus((current) => (current === 'ready' ? current : 'checking'));
      const readiness = await getPrivateModeReadiness();
      setLocalModelStatus(readiness.status);
    } catch (error) {
      console.error('Failed to check local model status:', error);
      setLocalModelStatus('missing');
    }
  }, []);

  useEffect(() => {
    refreshLocalModelStatus();
  }, [refreshLocalModelStatus]);

  useEffect(() => {
    if (user) loadUsage();
  }, [user, loadUsage]);

  useEffect(() => {
    if (downloadCompletedCount > 0) {
      refreshLocalModelStatus();
    }
  }, [downloadCompletedCount, refreshLocalModelStatus]);

  useEffect(() => {
    if (activeMode !== 'private' || localModelStatus !== 'ready') return;
    TranscriptionService.prepareLocal(getPreferredTranscriptionLanguage()).catch((error) => {
      if (__DEV__) {
        console.warn('[home] local model warm-up failed', error);
      }
    });
  }, [activeMode, localModelStatus]);

  const handleCancelHandoffRecording = () => {
    if (handoffTranscribing) return;
    safeHaptics('light');
    AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_CANCEL_REQUESTED, '1');
    AppGroupStorage.stopNativeRecording();
  };

  const handleRecordPress = async () => {
    if (!isRecording && requireAccountForCloudProcessing('recording')) return;

    if (!isSupported) {
      Alert.alert(
        'Recording Unavailable',
        'Audio recording is not supported in Expo Go. Please build and run a development client to test recording features.',
      );
      return;
    }

    try {
      if (isRecording) {
        await stopRecording();
      } else {
        const beginRecording = async () => {
          safeHaptics('heavy');
          await startRecording();
        };

        if (activeMode === 'cloud' && user) {
          await registerSuperwallGate({
            placement: SUPERWALL_PLACEMENTS.cloudTranscriptionStart,
            params: usage ? buildUsageGateParams(usage) : undefined,
            requiresAccount: false,
            feature: () => {
              beginRecording().catch(() => {});
            },
          });
          return;
        }

        await beginRecording();
      }
    } catch {
      // Hook's onError already surfaced this to the user.
    }
  };

  const handleFileUpload = async () => {
    if (requireAccountForCloudProcessing('audio uploads')) return;
    const beginUpload = async () => {
      await pickAndTranscribeFile();
    };

    try {
      if (activeMode === 'cloud' && user) {
        await registerSuperwallGate({
          placement: SUPERWALL_PLACEMENTS.audioUploadStart,
          params: usage ? buildUsageGateParams(usage) : undefined,
          requiresAccount: false,
          feature: () => {
            beginUpload().catch(() => {});
          },
        });
        return;
      }

      await beginUpload();
    } catch (error) {
      console.error('File upload error:', error);
    }
  };

  const handleTogglePrivateMode = () => {
    safeHaptics('light');

    if (isPrivateMode) {
      if (accountRequiredForCloud(user)) {
        showAccountRequiredAlert('cloud transcription');
        return;
      }
      setActiveMode('cloud', true);
      updateConfig({ defaultMode: 'cloud' });
      showModeToast({
        name: 'cloud.fill',
        mdName: 'Cloud',
        color: 'brand',
        text: 'Cloud on · higher-quality transcription on our servers',
      });
      return;
    }

    if (localModelStatus === 'unavailable') {
      Alert.alert('Private Mode Unavailable', getPrivateModeUnavailableMessage());
      return;
    }

    if (localModelStatus !== 'ready') {
      // Model not downloaded yet — send the user to the download screen.
      // We deliberately do NOT start the download automatically, and we leave
      // the mode on Cloud until they've downloaded and toggle again.
      router.push('/(account)/model-download');
      return;
    }

    setActiveMode('private', true);
    updateConfig({ defaultMode: 'private' });
    showModeToast({
      name: 'cloud.slash.fill',
      mdName: 'CloudOff',
      color: 'tertiaryLabel',
      text: 'Cloud off · transcribing privately on your device',
    });
  };

  const handleDictationModeChange = (enabled: boolean) => {
    showModeToast({
      name: 'power',
      mdName: 'Power',
      color: enabled ? 'brand' : 'tertiaryLabel',
      text: enabled
        ? 'Dictation mode on · mic stays ready for faster keyboard dictation'
        : 'Dictation mode off · mic warm-up is disabled',
    });
  };

  const handleUsageWarningPress = useCallback(() => {
    registerSuperwallGate({
      placement: SUPERWALL_PLACEMENTS.cloudUsageWarningTapped,
      params: usage ? buildUsageGateParams(usage) : undefined,
    }).catch(() => {});
  }, [registerSuperwallGate, usage]);

  const copyToClipboard = async (text: string) => {
    await Clipboard.setStringAsync(text);
    safeHaptics('success');
    showCopied();
  };

  const openTranscriptModal = (transcript: Transcript) => {
    setSelectedTranscript(transcript);
    setModalVisible(true);
  };

  const closeTranscriptModal = () => {
    setModalVisible(false);
    setSelectedTranscript(null);
  };

  const handleDeleteTranscript = async (id: string) => {
    try {
      await deleteTranscript(id);
    } catch {
      Alert.alert('Error', 'Failed to delete transcript');
    }
  };

  const handleRetryTranscript = async (id: string) => {
    if (retryingTranscriptIds[id]) return;
    if (requireAccountForCloudProcessing('retrying transcription')) return;

    setRetryingTranscriptIds((current) => ({ ...current, [id]: true }));
    try {
      await retryTranscript(id);
      safeHaptics('success');
    } catch (error) {
      Alert.alert(
        'Retry failed',
        error instanceof Error ? error.message : 'Could not retry this transcription.',
      );
    } finally {
      setRetryingTranscriptIds((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  const recentTranscripts = [...transcripts].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);

  if (isCheckingInitialUrl) {
    return <View className="flex-1 bg-systemBackground" />;
  }

  if (isKeyboardHandoffSession) {
    if (handoffNoSpeech) {
      return (
        <View className="flex-1 bg-systemBackground items-center justify-center px-10">
          <SystemIcon name="mic.slash.fill" mdName="MicOff" size={48} color="tertiaryLabel" />
          <Text className="mt-5 text-2xl font-semibold text-label text-center">
            We didn&apos;t catch that
          </Text>
          <Text className="mt-2 text-base text-secondaryLabel text-center">
            Try again and speak a little louder
          </Text>
        </View>
      );
    }

    const transcribing = handoffTranscribing;

    return (
      <View className="flex-1 bg-systemBackground" style={{ paddingTop: insets.top + 8 }}>
        <View className="flex-row justify-end px-5">
          <Pressable
            onPress={handleCancelHandoffRecording}
            disabled={transcribing}
            hitSlop={8}
            className="w-9 h-9 rounded-full items-center justify-center bg-secondarySystemBackground active:opacity-70"
            accessibilityLabel="Cancel and discard"
          >
            <SystemIcon name="xmark" mdName="X" size={13} color="secondaryLabel" />
          </Pressable>
        </View>

        <View className="items-center px-8 mt-4">
          <Text className="text-[32px] font-bold text-label leading-[38px] text-center">
            {transcribing ? 'Almost done…' : 'Swipe back to your app'}
          </Text>
          <Text className="mt-2 text-[15px] text-secondaryLabel leading-6 text-center">
            iOS requires an app switch to activate the microphone.
          </Text>

          <View className="mt-8">
            <HandoffPhoneIllustration transcribing={transcribing} />
          </View>

          <View className="mt-6 flex-row items-center gap-1.5">
            <Text className="text-sm text-tertiaryLabel">
              {transcribing
                ? 'Transcribing your audio'
                : 'Swipe right on the bar at the bottom of your screen'}
            </Text>
            {!transcribing && (
              <SystemIcon name="arrow.right" mdName="ArrowRight" size={12} color="tertiaryLabel" />
            )}
          </View>
        </View>

        <View style={handoffStyles.screenIndicatorRow} pointerEvents="none">
          <View style={handoffStyles.screenIndicator} />
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-systemBackground">
      <StatusBar style="auto" animated />

      <ProAccessConfirmation completion={proCompletion} onConsumed={consumeProCompletion} />

      <TranscriptModal
        transcript={selectedTranscript}
        visible={modalVisible}
        onClose={closeTranscriptModal}
      />

      <View className="px-4" style={{ paddingTop: insets.top + 8 }}>
        <View className="min-h-[44px] flex-row items-center justify-between">
          <Pressable
            onPress={handleTogglePrivateMode}
            accessibilityRole="switch"
            accessibilityState={{ checked: !isPrivateMode }}
            accessibilityLabel="Cloud transcription"
            className="h-9 flex-row items-center rounded-full px-1 active:opacity-80"
            style={{
              backgroundColor: isPrivateMode ? '#E3E0DE' : BRAND,
              boxShadow: '0px 1px 3px rgba(0,0,0,0.18)',
            }}
          >
            {!isPrivateMode && <Text className="ml-2 mr-1 text-xs font-bold text-white">On</Text>}
            <View className="h-7 w-7 items-center justify-center rounded-full bg-white">
              <CloudIcon size={16} color={isPrivateMode ? '#8E8E93' : BRAND} off={isPrivateMode} />
            </View>
            {isPrivateMode && (
              <Text className="ml-1 mr-2 text-xs font-bold text-secondaryLabel">Off</Text>
            )}
          </Pressable>
          <DictationModeControl onModeChange={handleDictationModeChange} />
        </View>
        <KeyboardFullAccessBanner />
        {!isPrivateMode ? (
          <UsageLimitBanner usage={usage} onPress={handleUsageWarningPress} />
        ) : null}
        {isPrivateMode ? (
          <View className="mt-3">
            <ParakeetNudgeBanner />
          </View>
        ) : null}
      </View>

      <View className="items-center justify-center" style={{ flex: 0.52 }}>
        <Pressable
          onPress={handleRecordPress}
          disabled={!isSupported || (!isRecording && (isProcessing || isRecoveringUsageLimit))}
          className="w-28 h-28 rounded-full items-center justify-center active:opacity-85"
          style={[styles.recordButton, !isSupported && styles.recordButtonDisabled]}
        >
          {isSupported ? <GradientGlassSurface shape="circle" /> : null}
          {isProcessing ? (
            <ProcessingWaveform color="#fff" size={32} />
          ) : (
            <SystemIcon name="mic.fill" mdName="Mic" size={36} color="#FFFFFF" />
          )}
        </Pressable>

        <Text className="mt-5 text-sm text-secondaryLabel">
          {isProcessing ? 'Processing...' : 'Tap to record'}
        </Text>

        <Pressable
          onPress={handleFileUpload}
          disabled={isProcessing || isFileProcessing || isRecording || isRecoveringUsageLimit}
          className="mt-4 flex-row items-center gap-2 px-4 py-2.5 rounded-lg bg-tertiarySystemFill active:opacity-70"
        >
          {isFileProcessing ? (
            <ActivityIndicator size="small" color={iosColor('tertiaryLabel')} />
          ) : (
            <SystemIcon name="arrow.up.doc" mdName="Upload" size={15} color="tertiaryLabel" />
          )}
          <Text className="text-xs font-medium text-secondaryLabel">
            {isFileProcessing ? 'Transcribing' : 'Upload audio'}
          </Text>
        </Pressable>
      </View>

      <View className="flex-1">
        {recentTranscripts.length > 0 && (
          <Text className="mb-1.5 px-8 text-xs font-semibold text-secondaryLabel uppercase tracking-wider">
            Recent
          </Text>
        )}

        {recentTranscripts.length === 0 ? (
          <View className="items-center mt-8 gap-2">
            <SystemIcon
              name="text.bubble"
              mdName="MessageSquare"
              size={28}
              color="quaternaryLabel"
            />
            <Text className="text-sm text-tertiaryLabel">
              Tap the mic to start your first transcription
            </Text>
          </View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          >
            <View
              className="mx-4 bg-secondarySystemGroupedBackground"
              style={styles.transcriptsCardShadow}
            >
              <View
                style={{ borderCurve: 'continuous' }}
                className="overflow-hidden rounded-[14px] border border-separator"
              >
                {recentTranscripts.map((transcript, i) => {
                  const isFailed = transcript.status === 'failed';
                  const isRetrying = !!retryingTranscriptIds[transcript.id];
                  return (
                    <React.Fragment key={transcript.id}>
                      {i > 0 ? <View className="ml-4 h-px bg-separator" /> : null}
                      <SwipeableCard inset onDelete={() => handleDeleteTranscript(transcript.id)}>
                        <Pressable
                          onPress={() => {
                            if (!isFailed) openTranscriptModal(transcript);
                          }}
                          className={
                            'flex-row items-start justify-between px-4 py-3 ' +
                            (isFailed ? 'bg-systemRed/10' : 'active:bg-tertiarySystemFill')
                          }
                        >
                          <View className="mr-3 flex-1">
                            <Text className="mb-1 text-xs text-secondaryLabel">
                              {formatRelativeTime(transcript.createdAt, 'long')}
                            </Text>
                            {isFailed ? (
                              <View>
                                <View className="flex-row items-center gap-1.5">
                                  <SystemIcon
                                    name="exclamationmark.circle.fill"
                                    mdName="AlertCircle"
                                    size={14}
                                    color="systemRed"
                                  />
                                  <Text className="text-sm font-semibold text-systemRed">
                                    Transcription failed
                                  </Text>
                                </View>
                                {transcript.errorMessage ? (
                                  <Text
                                    className="mt-1 text-xs leading-4 text-secondaryLabel"
                                    numberOfLines={2}
                                  >
                                    {transcript.errorMessage}
                                  </Text>
                                ) : null}
                              </View>
                            ) : (
                              <Text className="text-sm text-label" numberOfLines={2}>
                                {transcript.text}
                              </Text>
                            )}
                          </View>
                          {isFailed ? (
                            <Pressable
                              onPress={(e) => {
                                e.stopPropagation();
                                handleRetryTranscript(transcript.id).catch(() => undefined);
                              }}
                              disabled={isRetrying || !transcript.audioUrl}
                              className="mt-1 h-8 w-8 items-center justify-center rounded-full bg-systemRed/15 active:opacity-70 disabled:opacity-40"
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              accessibilityRole="button"
                              accessibilityLabel="Retry transcription"
                            >
                              {isRetrying ? (
                                <ActivityIndicator size="small" color={iosColor('systemRed')} />
                              ) : (
                                <SystemIcon
                                  name="arrow.clockwise"
                                  mdName="RotateCcw"
                                  size={14}
                                  color="systemRed"
                                />
                              )}
                            </Pressable>
                          ) : (
                            <Pressable
                              onPress={(e) => {
                                e.stopPropagation();
                                copyToClipboard(transcript.text);
                              }}
                              className="mt-1 p-1.5 active:opacity-70"
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              accessibilityRole="button"
                              accessibilityLabel="Copy transcript"
                            >
                              <SystemIcon
                                name="doc.on.doc"
                                mdName="Copy"
                                size={14}
                                color="tertiaryLabel"
                              />
                            </Pressable>
                          )}
                        </Pressable>
                      </SwipeableCard>
                    </React.Fragment>
                  );
                })}
              </View>
            </View>
          </ScrollView>
        )}
      </View>

      <RecordingOverlay
        visible={isRecording}
        amplitude={currentAmplitude}
        waveformData={waveformData}
        durationSeconds={recordingDuration}
        onDone={handleRecordPress}
        onDiscard={cancelRecording}
      />

      <HomeToast
        visible={showCopiedToast}
        name="checkmark"
        mdName="Check"
        color="brand"
        text="Copied to clipboard"
        top={insets.top + 56}
      />

      <HomeToast
        visible={showNoSpeechToast}
        name="mic.slash.fill"
        mdName="MicOff"
        color="tertiaryLabel"
        text="No speech detected"
        top={insets.top + 56}
      />

      <HomeToast
        visible={!!modeToast}
        name={modeToast?.name ?? 'cloud.fill'}
        mdName={modeToast?.mdName ?? 'Cloud'}
        color={modeToast?.color ?? 'brand'}
        text={modeToast?.text ?? ''}
        top={insets.top + 56}
      />
    </View>
  );
}

function HomeToast({
  visible,
  name,
  mdName,
  color,
  text,
  top,
}: {
  visible: boolean;
  name: string;
  mdName: LucideIconName;
  color: string;
  text: string;
  top: number;
}) {
  if (!visible) return null;
  return (
    <Animated.View
      entering={FadeInDown.duration(250)}
      exiting={FadeOutDown.duration(200)}
      pointerEvents="none"
      style={[styles.toastWrapper, { top }]}
    >
      <Glass className="rounded-2xl">
        <View style={styles.toastInner}>
          <SystemIcon name={name} mdName={mdName} size={14} color={color} />
          <Text className="shrink text-sm font-semibold text-label">{text}</Text>
        </View>
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  recordButton: {
    backgroundColor: BRAND,
    overflow: 'hidden',
    borderCurve: 'continuous',
    boxShadow: '0px 1px 3px rgba(0,0,0,0.08)',
  },
  recordButtonDisabled: {
    backgroundColor: iosColor('quaternarySystemFill'),
  },
  transcriptsCardShadow: {
    borderRadius: 14,
    borderCurve: 'continuous',
    boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.10)',
  },
  toastWrapper: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '88%',
    overflow: 'hidden',
    borderRadius: 16,
    borderCurve: 'continuous',
    // Fallback fill: liquid glass is clear over a flat background, so without
    // this the pill would have no visible backing. Glass renders on top of it.
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(60,60,67,0.18)',
    boxShadow: '0px 6px 20px rgba(0,0,0,0.14)',
    zIndex: 300,
  },
  toastInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    gap: 8,
  },
});

const handoffStyles = StyleSheet.create({
  phoneFrame: {
    width: 220,
    height: 290,
    borderRadius: 36,
    borderCurve: 'continuous',
    borderWidth: 5,
    borderColor: iosColor('separator'),
    overflow: 'hidden',
    backgroundColor: iosColor('secondarySystemBackground'),
  },
  phoneInner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 56,
    paddingBottom: 14,
  },
  waveformWrapper: {
    alignItems: 'center',
  },
  illustrationCaption: {
    marginTop: 14,
    fontSize: 13,
    fontWeight: '600',
    color: iosColor('label'),
  },
  illustrationSubcaption: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '500',
    color: iosColor('tertiaryLabel'),
  },
  homeIndicatorRow: {
    width: '100%',
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  homeIndicator: {
    width: 110,
    height: 4,
    borderRadius: 2,
    backgroundColor: iosColor('label'),
  },
  pulseCircle: {
    position: 'absolute',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: iosColor('link'),
  },
  // Faux iOS home indicator pinned to the bottom edge, matching the native
  // bar's dimensions so the "swipe right on the bar" hint points at something
  // concrete. `label` keeps it black on light and white in dark, like the system.
  screenIndicatorRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 8,
    alignItems: 'center',
  },
  screenIndicator: {
    width: 140,
    height: 5,
    borderRadius: 3,
    backgroundColor: iosColor('label'),
  },
});
