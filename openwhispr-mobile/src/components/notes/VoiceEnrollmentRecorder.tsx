import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { GradientGlassSurface } from '@/components/ui/GradientGlassSurface';
import { WaveformVisualizer } from '@/components/features/WaveformVisualizer';
import { useAudioRecording } from '@/hooks/useAudioRecording';
import { useAudioWaveform } from '@/hooks/useAudioWaveform';
import { BRAND } from '@/config/colors';
import type {
  EnrollVoiceProfileInput,
  ReenrollVoiceProfileInput,
} from '@/services/diarization/VoiceprintService';
import { SpeakerProfileOwnerAlreadyExistsError } from '@/data/local/notesRepository';

type VoiceEnrollmentSubmitInput = EnrollVoiceProfileInput | ReenrollVoiceProfileInput;

interface VoiceEnrollmentRecorderProps {
  isOwner: boolean;
  defaultDisplayName?: string;
  profileId?: number;
  onSubmit: (input: VoiceEnrollmentSubmitInput) => Promise<void>;
  onCancel?: () => void;
  now?: () => Date;
}

const MAX_TAKES = 2;
const TARGET_SECONDS = 30;

const formatError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'object' && error && 'code' in error) return String(error.code);
  return 'Voice enrollment failed. Try another take.';
};

const formatTime = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const cleanupUris = async (uris: string[]): Promise<void> => {
  await Promise.all(
    uris.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined)),
  );
};

export function VoiceEnrollmentRecorder({
  isOwner,
  defaultDisplayName,
  profileId,
  onSubmit,
  onCancel,
  now = () => new Date(),
}: VoiceEnrollmentRecorderProps) {
  const recording = useAudioRecording();
  const { currentAmplitude, waveformData } = useAudioWaveform(
    recording.audioRecorder,
    recording.isRecording,
  );
  const [displayName, setDisplayName] = useState(defaultDisplayName ?? (isOwner ? 'Me' : ''));
  // Consent is given by reading the on-screen script aloud, so it is stamped when
  // the first take starts rather than gated behind a separate checkbox.
  const [consentAcceptedAt, setConsentAcceptedAt] = useState<string | null>(null);
  const [recordingActive, setRecordingActive] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [takes, setTakes] = useState<Array<{ uri: string; mimeType: string }>>([]);
  const takesRef = useRef(takes);
  const cancelRecordingRef = useRef(recording.cancelRecording);
  const [error, setError] = useState<string | null>(null);
  const [showRetry, setShowRetry] = useState(false);
  const [saving, setSaving] = useState(false);

  takesRef.current = takes;
  cancelRecordingRef.current = recording.cancelRecording;

  useEffect(() => {
    setDisplayName(defaultDisplayName ?? (isOwner ? 'Me' : ''));
  }, [defaultDisplayName, isOwner]);

  useEffect(
    () => () => {
      cleanupUris(takesRef.current.map((take) => take.uri)).catch(() => undefined);
      Promise.resolve(cancelRecordingRef.current()).catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (!recordingActive) {
      setElapsedSeconds(0);
      return;
    }
    const interval = setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => clearInterval(interval);
  }, [recordingActive]);

  const stopAndAcceptTake = useCallback(async () => {
    const uri = await recording.stopRecordingRaw();
    setRecordingActive(false);
    if (!uri) {
      setError('Recording did not produce an audio file.');
      return;
    }
    setError(null);
    setShowRetry(false);
    setTakes((current) => [...current, { uri, mimeType: 'audio/wav' }].slice(0, MAX_TAKES));
  }, [recording]);

  const handleRecordPress = useCallback(async () => {
    if (saving || takes.length >= MAX_TAKES) return;
    try {
      if (recordingActive) {
        await stopAndAcceptTake();
        return;
      }
      setError(null);
      setShowRetry(false);
      if (!consentAcceptedAt) setConsentAcceptedAt(now().toISOString());
      await recording.startRecording();
      setRecordingActive(true);
    } catch (caught) {
      setRecordingActive(false);
      setError(formatError(caught));
    }
  }, [consentAcceptedAt, now, recording, recordingActive, saving, stopAndAcceptTake, takes.length]);

  const handleRemoveTakes = useCallback(() => {
    const uris = takes.map((take) => take.uri);
    setTakes([]);
    setError(null);
    setShowRetry(false);
    cleanupUris(uris).catch(() => undefined);
  }, [takes]);

  const handleSubmit = useCallback(async () => {
    const trimmedName = displayName.trim();
    if (!consentAcceptedAt || takes.length === 0) return;
    if (!isOwner && !trimmedName) return;

    setSaving(true);
    setError(null);
    const submittedTakes = takes;
    const submittedUris = submittedTakes.map((take) => take.uri);
    const baseInput = {
      recordings: submittedTakes,
      displayName: trimmedName || 'Me',
      isOwner,
      consentAccepted: true,
      consentAcceptedAt,
    };

    try {
      if (profileId === undefined) {
        await onSubmit(baseInput);
      } else {
        await onSubmit({ ...baseInput, profileId });
      }
      await cleanupUris(submittedUris);
      setTakes([]);
      setShowRetry(false);
    } catch (caught) {
      await cleanupUris(submittedUris);
      setTakes([]);
      setShowRetry(true);
      if (caught instanceof SpeakerProfileOwnerAlreadyExistsError) throw caught;
      setError(formatError(caught));
    } finally {
      setSaving(false);
    }
  }, [consentAcceptedAt, displayName, isOwner, onSubmit, profileId, takes]);

  const handleCancel = useCallback(() => {
    cleanupUris(takes.map((take) => take.uri)).catch(() => undefined);
    onCancel?.();
  }, [onCancel, takes]);

  const trimmedName = displayName.trim();
  const avatarInitial = trimmedName ? trimmedName[0].toUpperCase() : '?';
  const canSave = takes.length > 0 && (isOwner || !!trimmedName) && !saving;
  const canRecordMore = takes.length < MAX_TAKES;
  const countLabel = recordingActive
    ? `Recording ${takes.length + 1} of ${MAX_TAKES}`
    : `${takes.length} of ${MAX_TAKES} recorded`;

  return (
    <View className="gap-5">
      <View className="gap-2">
        <Text className="text-[13px] uppercase tracking-wider text-secondaryLabel">Profile</Text>
        <View
          className="flex-row items-center gap-3 rounded-xl border border-separator bg-secondarySystemGroupedBackground p-2"
          style={{ borderCurve: 'continuous' }}
        >
          <View className="h-11 w-11 items-center justify-center overflow-hidden rounded-full bg-primary">
            <GradientGlassSurface shape="circle" />
            <Text className="text-[17px] font-semibold text-white">{avatarInitial}</Text>
          </View>
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder={isOwner ? 'Me' : 'Speaker name'}
            placeholderTextColor="rgba(60,60,67,0.3)"
            testID="voice-enrollment-name"
            className="flex-1 text-[17px] font-semibold text-label"
          />
        </View>
      </View>

      <View className="gap-2">
        <Text className="text-[13px] uppercase tracking-wider text-secondaryLabel">Read aloud</Text>
        <View
          className="rounded-xl border border-separator bg-secondarySystemGroupedBackground p-4"
          style={{ borderCurve: 'continuous' }}
        >
          <Text className="text-[15px] leading-6 text-label">
            Today I am creating a voice profile for meeting notes. This 10 second voiceprint stays
            on my device and helps label future transcripts. It is used only to recognize my voice
            in recordings I choose to process, and it is not shared with other people or services. I
            can delete them whenever I choose.
          </Text>
        </View>
      </View>

      <View className="items-center gap-2">
        <WaveformVisualizer
          isRecording={recordingActive}
          height={120}
          color={BRAND}
          amplitude={currentAmplitude}
          waveformData={waveformData}
        />
        {recordingActive ? (
          <View className="flex-row items-center gap-2">
            <View className="h-2 w-2 rounded-full bg-systemRed" />
            <Text className="text-[14px] font-medium text-secondaryLabel">
              {`Recording · ${formatTime(elapsedSeconds)} / ${formatTime(TARGET_SECONDS)}`}
            </Text>
          </View>
        ) : null}
      </View>

      <View className="gap-3">
        <Text className="text-center text-[14px] font-semibold text-label">{countLabel}</Text>
        {canRecordMore ? (
          recordingActive ? (
            <Pressable
              onPress={handleRecordPress}
              accessibilityRole="button"
              testID="voice-enrollment-record"
              className="h-14 flex-row items-center justify-center gap-2 rounded-full border border-separator bg-secondarySystemGroupedBackground active:opacity-80"
              style={{ borderCurve: 'continuous' }}
            >
              <View className="h-2.5 w-2.5 rounded-full bg-systemRed" />
              <Text className="text-base font-medium text-systemRed">Stop</Text>
            </Pressable>
          ) : (
            <Button
              onPress={handleRecordPress}
              disabled={saving}
              testID="voice-enrollment-record"
              accessibilityState={{ disabled: saving }}
            >
              {takes.length === 0 ? 'Record Take' : 'Record Another'}
            </Button>
          )
        ) : null}
        {canRecordMore ? (
          <Text className="text-center text-[13px] leading-5 text-tertiaryLabel">
            One recording is enough. Record another if you want better reliability.
          </Text>
        ) : null}
        {takes.length > 0 || showRetry ? (
          <Pressable
            onPress={handleRemoveTakes}
            accessibilityRole="button"
            accessibilityLabel="Retry recording"
            testID="voice-enrollment-retry"
            className="items-center py-1"
          >
            <Text className="text-[14px] font-medium text-brand">Retry recording</Text>
          </Pressable>
        ) : null}
      </View>

      {error ? (
        <View
          className="rounded-xl border border-systemRed/30 bg-systemRed/10 p-3"
          testID="voice-enrollment-error"
        >
          <Text className="text-[14px] leading-5 text-systemRed">{error}</Text>
        </View>
      ) : null}

      <View className="flex-row gap-3">
        {onCancel ? (
          <Button variant="secondary" className="flex-1" onPress={handleCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          className="flex-1"
          onPress={handleSubmit}
          disabled={!canSave}
          loading={saving}
          testID="voice-enrollment-save"
          accessibilityState={{ disabled: !canSave }}
        >
          Save
        </Button>
      </View>
    </View>
  );
}
