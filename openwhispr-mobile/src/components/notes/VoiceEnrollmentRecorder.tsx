import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import * as FileSystem from 'expo-file-system/legacy';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { WaveformVisualizer } from '@/components/features/WaveformVisualizer';
import { useAudioRecording } from '@/hooks/useAudioRecording';
import { useAudioWaveform } from '@/hooks/useAudioWaveform';
import { BRAND, iosColor } from '@/config/colors';
import { SpeakerProfileOwnerAlreadyExistsError } from '@/data/local/notesRepository';
import {
  VOICE_ENROLLMENT_DIARIZER_MODEL_REQUIRED,
  VoiceEnrollmentError,
  type EnrollVoiceProfileInput,
  type ReenrollVoiceProfileInput,
} from '@/services/diarization/VoiceprintService';
import {
  VOICE_ENROLLMENT_UNEXPLAINED_FAILURE,
  voiceEnrollmentFailureMessage,
} from '@/lib/voiceEnrollmentMessages';
import { isMicPermissionError, showMicPermissionAlert } from '@/lib/permissions';
import { Sentry } from '@/lib/sentry';

type Phase =
  | 'checking-model'
  | 'needs-model'
  | 'ready'
  | 'recording'
  | 'checking'
  | 'download-failed'
  | 'failed'
  | 'done';

interface VoiceEnrollmentRecorderProps {
  isOwner: boolean;
  defaultDisplayName?: string;
  profileId?: number;
  isModelReady: () => Promise<boolean>;
  isModelDownloading: () => boolean;
  downloadModel: () => Promise<void>;
  onSubmit: (input: EnrollVoiceProfileInput | ReenrollVoiceProfileInput) => Promise<void>;
  onDone: () => void;
  onCancel: () => void;
  now?: () => Date;
}

// Reading the script aloud is the consent, so it names what the profile is for.
export const VOICE_ENROLLMENT_SCRIPT =
  "I'm teaching OpenWhispr my voice so it can label me in my meeting notes. This voice profile stays on my device, is only used to recognize me in recordings I choose to process, and I can delete it at any time.";

const MIC_PERMISSION_FAILURE =
  "Couldn't start the microphone. Check that OpenWhispr can use it in Settings, then try again.";
const MIC_START_FAILURE = "Couldn't start the microphone. Try again.";
const STOP_FAILURE = "Couldn't finish the recording. Try again.";

// A call or Siri pauses the recorder, and the pause only shows as it no longer recording.
const RECORDING_INTERRUPTED =
  'Your recording was interrupted, maybe by a call. Start again when you are ready.';

// The check needs 10 s of speech, and normal reading has pauses between words, so Done
// unlocks, and the ring fills, once there is room for them.
const MIN_SECONDS = 15;
const MAX_SECONDS = 30;
// A stalled model request can hang for 30 minutes before it fails. Stop waiting long before
// that; the download carries on, and Retry waits on the same one.
const DOWNLOAD_WAIT_MS = 3 * 60 * 1000;
const RING_SIZE = 88;
const RING_STROKE = 4;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const deleteRecording = (uri: string): void => {
  FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
};

// Rejects when the wait times out or `signal` aborts (the recorder left).
const waitForDownload = async (
  download: Promise<void> | null,
  signal: AbortSignal,
): Promise<void> => {
  if (!download) return;
  if (signal.aborted) throw new Error('Left while waiting for the model download');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Model download timed out')), DOWNLOAD_WAIT_MS);
    onAbort = () => reject(new Error('Left while waiting for the model download'));
    signal.addEventListener('abort', onAbort);
  });
  try {
    await Promise.race([download, timeout]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
};

const reportFailure = (error: unknown, stage: string): void => {
  Sentry.captureException(error, { tags: { feature: 'voice-enrollment', stage } });
};

// Also reports failures the message can't explain, so they can be diagnosed.
const checkFailureMessage = (error: unknown): string => {
  const message = voiceEnrollmentFailureMessage(error);
  if (message === VOICE_ENROLLMENT_UNEXPLAINED_FAILURE) reportFailure(error, 'check');
  return message;
};

type RecorderLike = { uri?: string | null; isRecording?: boolean } | null | undefined;

// Reading a released native recorder throws, so a failed read means there is no file to track.
const readRecorderUri = (recorder: RecorderLike): string | null => {
  try {
    return recorder?.uri || null;
  } catch {
    return null;
  }
};

const readRecorderIsRecording = (recorder: RecorderLike): boolean => {
  try {
    return !!recorder?.isRecording;
  } catch {
    return false;
  }
};

export function VoiceEnrollmentRecorder({
  isOwner,
  defaultDisplayName,
  profileId,
  isModelReady,
  isModelDownloading,
  downloadModel,
  onSubmit,
  onDone,
  onCancel,
  now = () => new Date(),
}: VoiceEnrollmentRecorderProps): React.JSX.Element {
  const recording = useAudioRecording();
  const { currentAmplitude, waveformData } = useAudioWaveform(
    recording.audioRecorder,
    recording.isRecording,
  );
  const [phase, setPhase] = useState<Phase>('checking-model');
  const [downloadStatus, setDownloadStatus] = useState<'idle' | 'downloading' | 'failed'>('idle');
  const [displayName, setDisplayName] = useState(defaultDisplayName ?? (isOwner ? 'Me' : ''));
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const consentAtRef = useRef<string | null>(null);
  const downloadRef = useRef<Promise<void> | null>(null);
  // The file the recorder is writing, captured while it starts. On unmount the recorder
  // hook releases the native recorder before this component's cleanup runs, and a
  // released recorder can't be asked for its uri any more.
  const activeUriRef = useRef<string | null>(null);
  // A finished recording not yet handed to onSubmit; deleted if you leave.
  const pendingUriRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const leftRef = useRef(new AbortController());
  // The hook returns a new object each render; reading it through a ref keeps the
  // callbacks below stable.
  const recordingRef = useRef(recording);
  recordingRef.current = recording;

  const fail = useCallback((message: string): void => {
    if (!mountedRef.current) return;
    setFailure(message);
    setPhase('failed');
  }, []);

  // Stops the recorder, then deletes the sample it was writing.
  const discardActiveRecording = useCallback((): void => {
    const uri = activeUriRef.current;
    activeUriRef.current = null;
    // The executor runs now, and turns a throw from a released recorder into a rejection.
    new Promise((resolve) => resolve(recordingRef.current.cancelRecording()))
      .catch(() => undefined)
      .then(() => {
        if (uri) deleteRecording(uri);
      });
  }, []);

  useEffect(() => {
    // Set here too, since Fast Refresh reruns effects on the same refs.
    mountedRef.current = true;
    leftRef.current = new AbortController();
    return () => {
      mountedRef.current = false;
      leftRef.current.abort();
      if (pendingUriRef.current) deleteRecording(pendingUriRef.current);
      pendingUriRef.current = null;
      // Releasing the recorder has already stopped it. A stop still in flight that
      // resolves later finds the component gone and deletes the same file again.
      discardActiveRecording();
    };
  }, [discardActiveRecording]);

  const startDownload = useCallback((): void => {
    setDownloadStatus('downloading');
    const download = downloadModel();
    downloadRef.current = download;
    download.then(
      () => {
        if (downloadRef.current === download) downloadRef.current = null;
        if (mountedRef.current) setDownloadStatus('idle');
      },
      () => {
        if (mountedRef.current) setDownloadStatus('failed');
      },
    );
  }, [downloadModel]);

  useEffect(() => {
    // Opened again while an earlier visit's download runs: you already said yes, so join it.
    if (isModelDownloading()) {
      startDownload();
      setPhase('ready');
      return;
    }
    let active = true;
    isModelReady().then(
      (ready) => active && setPhase(ready ? 'ready' : 'needs-model'),
      () => active && setPhase('needs-model'),
    );
    return () => {
      active = false;
    };
  }, [isModelDownloading, isModelReady, startDownload]);

  const trimmedName = displayName.trim();
  const asksForName = !isOwner && profileId === undefined;

  const discardPending = (uri: string): void => {
    pendingUriRef.current = null;
    deleteRecording(uri);
  };

  const submit = useCallback(
    async (uri: string): Promise<void> => {
      submittingRef.current = true;
      setPhase('checking');
      // Held here while the model downloads so leaving deletes it.
      pendingUriRef.current = uri;
      try {
        await waitForDownload(downloadRef.current, leftRef.current.signal);
      } catch {
        submittingRef.current = false;
        // Kept so a retried download can check it without reading again.
        if (mountedRef.current) setPhase('download-failed');
        // Unless leaving has already deleted it.
        else if (pendingUriRef.current === uri) discardPending(uri);
        return;
      }
      // Left while stopping or waiting: nothing will check this recording.
      if (!mountedRef.current) {
        submittingRef.current = false;
        discardPending(uri);
        return;
      }
      // From here the enrollment service owns the file until the finally below.
      pendingUriRef.current = null;
      const consent = {
        recordings: [{ uri, mimeType: 'audio/wav' }],
        consentAccepted: true as const,
        consentAcceptedAt: consentAtRef.current ?? now().toISOString(),
      };
      let keepRecording = false;
      try {
        // A retrain keeps the profile's current name, even one changed during the read.
        await onSubmit(
          profileId === undefined
            ? { ...consent, displayName: trimmedName, isOwner }
            : { ...consent, profileId },
        );
        if (mountedRef.current) setPhase('done');
      } catch (caught) {
        if (caught instanceof SpeakerProfileOwnerAlreadyExistsError) {
          // onSubmit has already explained this one and left the screen.
          return;
        }
        if (
          caught instanceof VoiceEnrollmentError &&
          caught.code === VOICE_ENROLLMENT_DIARIZER_MODEL_REQUIRED
        ) {
          // Kept so the read can be checked once the model is downloaded.
          keepRecording = mountedRef.current;
          if (keepRecording) {
            pendingUriRef.current = uri;
            setPhase('needs-model');
          }
          return;
        }
        fail(checkFailureMessage(caught));
      } finally {
        submittingRef.current = false;
        if (!keepRecording) deleteRecording(uri);
      }
    },
    [fail, isOwner, now, onSubmit, profileId, trimmedName],
  );

  const stop = useCallback(async (): Promise<void> => {
    // Done and the 30 s auto-stop can land together; only the first one stops.
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    try {
      const uri = await recordingRef.current.stopRecordingRaw();
      if (!uri) {
        discardActiveRecording();
        fail(RECORDING_INTERRUPTED);
        return;
      }
      // submit owns the file from here, so leaving no longer deletes it as the active one.
      activeUriRef.current = null;
      await submit(uri);
    } catch (caught) {
      discardActiveRecording();
      reportFailure(caught, 'stop');
      fail(STOP_FAILURE);
    } finally {
      stoppingRef.current = false;
    }
  }, [discardActiveRecording, fail, submit]);

  // Paused by a call or Siri: say so now, not after reading on into a paused recorder.
  const handleInterruption = useCallback((): void => {
    const uri = activeUriRef.current;
    activeUriRef.current = null;
    // A paused recorder ignores cancel; stopping it finishes the file so it can be deleted.
    Promise.resolve()
      .then(() => recordingRef.current.audioRecorder.stop())
      .catch(() => undefined)
      .then(() => recordingRef.current.cancelRecording())
      .catch(() => undefined)
      .then(() => {
        if (uri) deleteRecording(uri);
      });
    fail(RECORDING_INTERRUPTED);
  }, [fail]);

  useEffect(() => {
    if (phase !== 'recording') {
      setElapsedSeconds(0);
      return;
    }
    const interval = setInterval(() => {
      if (!stoppingRef.current && !readRecorderIsRecording(recordingRef.current.audioRecorder)) {
        clearInterval(interval);
        handleInterruption();
        return;
      }
      setElapsedSeconds((seconds) => seconds + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [handleInterruption, phase]);

  useEffect(() => {
    if (phase === 'recording' && elapsedSeconds >= MAX_SECONDS) stop().catch(() => undefined);
  }, [elapsedSeconds, phase, stop]);

  const start = useCallback(async (): Promise<void> => {
    // The phase stays ready while the microphone opens; a second tap would prepare a
    // second file that nothing deletes.
    if (startingRef.current || activeUriRef.current) return;
    startingRef.current = true;
    setFailure(null);
    consentAtRef.current ??= now().toISOString();
    try {
      await recordingRef.current.startRecording();
      activeUriRef.current = readRecorderUri(recordingRef.current.audioRecorder);
      // Left before the microphone opened: stop it and drop what it started writing.
      if (!mountedRef.current) {
        discardActiveRecording();
        return;
      }
      setPhase('recording');
    } catch (caught) {
      if (isMicPermissionError(caught)) {
        // Same rule as dictation: only point at Settings when iOS couldn't ask itself.
        if (!caught.nativePromptShown) showMicPermissionAlert();
        fail(MIC_PERMISSION_FAILURE);
      } else {
        reportFailure(caught, 'start');
        fail(MIC_START_FAILURE);
      }
    } finally {
      startingRef.current = false;
    }
  }, [discardActiveRecording, fail, now]);

  // Downloads the model, then checks a recording that was waiting for it.
  const downloadAndCheck = useCallback(async (): Promise<void> => {
    // A second tap before the re-render would check, and delete, the same file twice.
    if (submittingRef.current) return;
    startDownload();
    const uri = pendingUriRef.current;
    if (uri) await submit(uri);
    else setPhase('ready');
  }, [startDownload, submit]);

  if (phase === 'checking-model') {
    return <ActivityIndicator className="mt-10" />;
  }

  if (phase === 'needs-model') {
    return (
      <View className="gap-4">
        <Text accessibilityRole="header" className="text-[20px] font-semibold text-label">
          Download the speaker model
        </Text>
        <Text className="text-[15px] leading-5 text-secondaryLabel">
          OpenWhispr needs a one-time download of about 100 MB to recognize voices. It runs entirely
          on your device after that.
        </Text>
        <Button
          testID="voice-enrollment-download"
          onPress={() => {
            downloadAndCheck().catch(() => undefined);
          }}
        >
          Download
        </Button>
        <Button testID="voice-enrollment-not-now" variant="secondary" onPress={onCancel}>
          Not Now
        </Button>
      </View>
    );
  }

  if (phase === 'done') {
    const labelled = isOwner ? `you as ${trimmedName}` : trimmedName;
    return (
      <View className="items-center gap-3 pt-6">
        <SystemIcon
          name="checkmark.circle.fill"
          mdName="CircleCheck"
          size={44}
          color="systemGreen"
        />
        <Text className="text-[22px] font-semibold text-label">All set</Text>
        <Text className="text-center text-[15px] leading-5 text-secondaryLabel">
          {`Future on-device meetings will label ${labelled}.`}
        </Text>
        <Button testID="voice-enrollment-done" className="mt-2 self-stretch" onPress={onDone}>
          Done
        </Button>
      </View>
    );
  }

  const needsName = asksForName && !trimmedName;
  const canStop = elapsedSeconds >= MIN_SECONDS;
  const ringProgress = Math.min(elapsedSeconds / MIN_SECONDS, 1);

  return (
    <View className="gap-5">
      {asksForName ? (
        <TextInput
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="Their name"
          placeholderTextColor={iosColor('tertiaryLabel')}
          editable={phase === 'ready' || phase === 'failed'}
          testID="voice-enrollment-name"
          className="rounded-xl border border-separator bg-secondarySystemGroupedBackground px-4 py-3 text-[17px] text-label"
          style={{ borderCurve: 'continuous' }}
        />
      ) : null}

      <Text className="text-[15px] leading-5 text-secondaryLabel">
        Read this aloud in your normal voice. It takes about 20 seconds.
      </Text>
      <View
        className="rounded-xl border border-separator bg-secondarySystemGroupedBackground p-4"
        style={{ borderCurve: 'continuous' }}
      >
        <Text className="text-[19px] leading-7 text-label">{VOICE_ENROLLMENT_SCRIPT}</Text>
      </View>

      {downloadStatus === 'downloading' ? (
        <View className="flex-row items-center gap-2" testID="voice-enrollment-downloading">
          <ActivityIndicator size="small" />
          <Text className="text-[13px] text-secondaryLabel">Downloading speaker model…</Text>
        </View>
      ) : null}
      {downloadStatus === 'failed' && phase !== 'download-failed' ? (
        <View className="flex-row items-center justify-between">
          <Text className="text-[13px] text-systemRed">
            The speaker model didn&apos;t download.
          </Text>
          <Pressable
            onPress={startDownload}
            accessibilityRole="button"
            testID="voice-enrollment-download-retry-inline"
            className="min-h-11 justify-center px-2"
          >
            <Text className="text-[14px] font-medium text-brand">Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {phase === 'failed' && failure ? (
        <View
          className="gap-2 rounded-xl border border-systemRed/30 bg-systemRed/10 p-3"
          testID="voice-enrollment-error"
        >
          <Text className="text-[14px] leading-5 text-systemRed">{failure}</Text>
        </View>
      ) : null}

      {phase === 'checking' ? (
        <View className="items-center gap-2 py-6" testID="voice-enrollment-checking">
          <ActivityIndicator />
          <Text className="text-[15px] text-secondaryLabel">
            {downloadStatus === 'downloading'
              ? 'Waiting for the speaker model to finish downloading…'
              : 'Checking your voice…'}
          </Text>
        </View>
      ) : phase === 'download-failed' ? (
        <View className="gap-3 py-2">
          <Text className="text-[15px] leading-5 text-secondaryLabel">
            The speaker model hasn&apos;t finished downloading, so your recording couldn&apos;t be
            checked yet.
          </Text>
          <Button
            testID="voice-enrollment-download-retry"
            onPress={() => {
              downloadAndCheck().catch(() => undefined);
            }}
          >
            Retry
          </Button>
        </View>
      ) : phase === 'failed' ? (
        <Button
          testID="voice-enrollment-try-again"
          onPress={() => {
            setFailure(null);
            setPhase('ready');
          }}
        >
          Try Again
        </Button>
      ) : (
        <View className="items-center gap-4">
          {phase === 'recording' ? (
            <WaveformVisualizer
              isRecording
              height={80}
              color={BRAND}
              amplitude={currentAmplitude}
              waveformData={waveformData}
            />
          ) : null}
          <Pressable
            onPress={phase === 'ready' ? () => start().catch(() => undefined) : undefined}
            disabled={phase !== 'ready' || needsName}
            accessibilityRole="button"
            accessibilityLabel={phase === 'recording' ? 'Recording' : 'Start recording'}
            accessibilityState={{ disabled: phase !== 'ready' || needsName }}
            testID="voice-enrollment-record"
            style={{ width: RING_SIZE, height: RING_SIZE, opacity: needsName ? 0.4 : 1 }}
            className="items-center justify-center"
          >
            <Svg width={RING_SIZE} height={RING_SIZE} style={{ position: 'absolute' }}>
              <Circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_RADIUS}
                stroke={BRAND}
                strokeOpacity={0.15}
                strokeWidth={RING_STROKE}
                fill="none"
              />
              <Circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_RADIUS}
                stroke={BRAND}
                strokeWidth={RING_STROKE}
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - ringProgress)}
                strokeLinecap="round"
                fill="none"
                transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
              />
            </Svg>
            <View className="h-16 w-16 items-center justify-center rounded-full bg-brand">
              <SystemIcon name="mic.fill" mdName="Mic" size={26} color="#FFFFFF" />
            </View>
          </Pressable>
          {phase === 'recording' ? (
            <View className="items-center gap-2 self-stretch">
              <Button
                testID="voice-enrollment-stop"
                className="self-stretch"
                disabled={!canStop}
                onPress={() => {
                  stop().catch(() => undefined);
                }}
              >
                Done
              </Button>
              {canStop ? null : (
                <Text className="text-[13px] text-tertiaryLabel">Keep reading</Text>
              )}
            </View>
          ) : (
            <Text className="text-[13px] text-tertiaryLabel">Tap to start reading</Text>
          )}
        </View>
      )}
    </View>
  );
}
