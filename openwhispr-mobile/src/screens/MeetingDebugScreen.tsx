import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Text } from '@/components/ui/Text';
import { getDiarizer } from '@/lib/diarization/getDiarizer';
import {
  DEBUG_ROTATION_CHOICES_MS,
  getDebugRotationMs,
  setDebugRotationMs,
  timeSpeakerPass,
  type SpeakerPassTiming,
} from '@/lib/debug/meetingDebug';
import { ROTATION_MS } from '@/services/transcription/realtimeReconnect';
import { AudioTools } from '../../modules/audio-tools/src';

// Development builds only: shortens the meeting device checks. Never shown in a release build.

const minutes = (valueMs: number): string => `${Math.round(valueMs / 60_000)} min`;
const seconds = (valueMs: number): string => `${(valueMs / 1000).toFixed(1)} s`;

const rotationLabel = (valueMs: number | null): string =>
  valueMs === null ? `Normal (${minutes(ROTATION_MS)})` : minutes(valueMs);

type PassState =
  | { kind: 'idle' }
  | { kind: 'running'; fileName: string }
  | { kind: 'done'; fileName: string; timing: SpeakerPassTiming }
  | { kind: 'error'; message: string };

export default function MeetingDebugScreen(): React.ReactElement | null {
  const [rotationMs, setRotationMs] = useState<number | null>(getDebugRotationMs());
  const [pass, setPass] = useState<PassState>({ kind: 'idle' });

  const chooseRotation = useCallback((valueMs: number | null) => {
    setDebugRotationMs(valueMs);
    setRotationMs(getDebugRotationMs());
  }, []);

  const runSpeakerPass = useCallback(async () => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: 'audio/*',
      copyToCacheDirectory: true,
    });
    if (picked.canceled) return;
    const file = picked.assets[0];
    const fileName = file.name ?? 'audio file';
    setPass({ kind: 'running', fileName });
    try {
      const diarizer = getDiarizer();
      if (!diarizer.isAvailable() || !(await diarizer.isModelDownloaded())) {
        throw new Error('Download the speaker model first (AI Models > Speaker Separation).');
      }
      const timing = await timeSpeakerPass(file.uri, {
        transcodeToWav: (inputUri) => AudioTools.transcodeToWav(inputUri),
        diarize: (wavUri) => diarizer.diarize(wavUri),
        cleanup: (uris) => AudioTools.cleanup(uris),
        now: () => Date.now(),
      });
      setPass({ kind: 'done', fileName, timing });
    } catch (caught) {
      setPass({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'The speaker pass failed',
      });
    }
  }, []);

  if (!__DEV__) return null;

  const isRunning = pass.kind === 'running';

  return (
    <ScrollView
      className="flex-1 bg-systemBackground"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
    >
      <View
        style={{ borderCurve: 'continuous' }}
        className="rounded-[10px] bg-secondarySystemGroupedBackground p-4"
      >
        <Text className="text-[17px] font-semibold text-label">Session rotation</Text>
        <Text className="mt-1 text-sm text-secondaryLabel">
          How long a cloud meeting streams before it rolls into a fresh session. Applies to the next
          rotation and resets when the app restarts.
        </Text>
        <View className="mt-3 flex-row gap-2">
          {DEBUG_ROTATION_CHOICES_MS.map((choiceMs) => {
            const selected = choiceMs === rotationMs;
            return (
              <Pressable
                key={String(choiceMs)}
                testID={`rotation-${choiceMs ?? 'normal'}`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => chooseRotation(choiceMs)}
                style={{ borderCurve: 'continuous' }}
                className={`flex-1 items-center rounded-lg py-2.5 ${
                  selected ? 'bg-brand' : 'bg-tertiarySystemFill'
                }`}
              >
                <Text className={`text-sm font-medium ${selected ? 'text-white' : 'text-label'}`}>
                  {rotationLabel(choiceMs)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View
        style={{ borderCurve: 'continuous' }}
        className="mt-5 rounded-[10px] bg-secondarySystemGroupedBackground p-4"
      >
        <Text className="text-[17px] font-semibold text-label">Speaker pass timing</Text>
        <Text className="mt-1 text-sm text-secondaryLabel">
          Runs speaker separation on an audio file from Files and shows how long it took. Keep the
          app open until it finishes.
        </Text>
        <Pressable
          testID="run-speaker-pass"
          accessibilityRole="button"
          disabled={isRunning}
          onPress={runSpeakerPass}
          style={{ borderCurve: 'continuous', opacity: isRunning ? 0.5 : 1 }}
          className="mt-3 items-center rounded-lg bg-brand py-2.5"
        >
          <Text className="text-sm font-medium text-white">Choose audio file</Text>
        </Pressable>

        {pass.kind === 'running' ? (
          <View className="mt-3 flex-row items-center gap-2">
            <ActivityIndicator size="small" />
            <Text className="text-xs text-secondaryLabel">Running on {pass.fileName}…</Text>
          </View>
        ) : null}

        {pass.kind === 'error' ? (
          <Text className="mt-3 text-xs text-systemRed">{pass.message}</Text>
        ) : null}

        {pass.kind === 'done' ? (
          <View className="mt-3 gap-1">
            <Text className="text-sm text-label">{pass.fileName}</Text>
            <Text className="text-sm text-secondaryLabel">
              Audio length: {minutes(pass.timing.audioMs)}
            </Text>
            <Text className="text-sm text-secondaryLabel">
              Convert: {seconds(pass.timing.transcodeMs)}
            </Text>
            <Text testID="speaker-pass-time" className="text-sm font-semibold text-label">
              Speaker pass: {seconds(pass.timing.diarizeMs)}
            </Text>
            <Text className="text-sm text-secondaryLabel">
              Speakers: {pass.timing.speakerCount} · Turns: {pass.timing.turnCount}
            </Text>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
