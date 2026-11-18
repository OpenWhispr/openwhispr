import { useEffect, useRef, useState } from 'react';
import { Alert, Modal, PermissionsAndroid, Pressable, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { AndroidDictation, type Recording } from '../../../modules/android-dictation/src';
import { useHomeT } from './strings';
import { gloss, glossPressed, home, type } from './kit';

const BARS = 48;
const BAR_MAX = 48;

// The recorder reports -60..-20 dBFS as 0..1; a quiet room sits near 0.3, so start the bars there.
const barHeight = (level: number) =>
  Math.max(4, Math.round(Math.min(1, Math.max(0, (level - 0.3) / 0.6)) * BAR_MAX));

const formatElapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * Records straight away with the bubble's own recorder, so a try is transcribed exactly as a
 * bubble dictation is. ✕ and the back gesture throw the recording away; the tick hands it on.
 */
export function TryItRecorder({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: (recording: Recording) => void;
}) {
  const t = useHomeT();
  const { t: tAndroid } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const active = useRef(false);
  const finishing = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = async () => {
      try {
        const microphone = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        );
        if (cancelled) return;
        if (microphone !== PermissionsAndroid.RESULTS.GRANTED) {
          Alert.alert(tAndroid('errorTitle'), t('microphoneNeeded'));
          onCancel();
          return;
        }
        await AndroidDictation!.startRecording();
        if (cancelled) {
          await AndroidDictation!.stopRecording(true).catch(() => undefined);
          return;
        }
        active.current = true;
        setRecording(true);
        const startedAt = Date.now();
        timer = setInterval(() => {
          setElapsed(Date.now() - startedAt);
          const level = AndroidDictation?.getRecordingLevel?.() ?? 0;
          setLevels((previous) => [...previous.slice(1), level]);
        }, 70);
      } catch (error) {
        if (cancelled) return;
        Alert.alert(tAndroid('errorTitle'), (error as Error).message);
        onCancel();
      }
    };
    void start();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (active.current && !finishing.current) {
        active.current = false;
        void AndroidDictation?.stopRecording(true).catch(() => undefined);
      }
    };
    // Starts once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const discard = () => {
    if (finishing.current) return;
    finishing.current = true;
    if (active.current) {
      active.current = false;
      void AndroidDictation?.stopRecording(true).catch(() => undefined);
    }
    onCancel();
  };

  const finish = async () => {
    if (finishing.current || !active.current) return;
    finishing.current = true;
    active.current = false;
    try {
      onDone(await AndroidDictation!.stopRecording(false));
    } catch (error) {
      Alert.alert(tAndroid('errorTitle'), (error as Error).message);
      onCancel();
    }
  };

  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={discard}>
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: home.canvas }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 8,
            }}
          >
            <Pressable
              cssInterop={false}
              accessibilityRole="button"
              accessibilityLabel={t('discard')}
              onPress={discard}
              style={({ pressed }) => ({
                width: 48,
                height: 48,
                marginLeft: -6,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: 'rgba(255,255,255,0.72)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <SystemIcon name="xmark" mdName="X" size={22} color={home.text} />
              </View>
            </Pressable>
            <Text
              accessibilityRole="header"
              style={[type.headline, { flex: 1, textAlign: 'center', lineHeight: 24 }]}
            >
              {t('dictate')}
            </Text>
            <View style={{ width: 42 }} />
          </View>
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 20,
              paddingHorizontal: 16,
            }}
          >
            <View
              accessible={false}
              importantForAccessibility="no-hide-descendants"
              style={{ height: BAR_MAX, flexDirection: 'row', alignItems: 'center', gap: 3 }}
            >
              {levels.map((level, index) => (
                <View
                  key={index}
                  style={{
                    width: 3,
                    height: barHeight(level),
                    borderRadius: 999,
                    backgroundColor: home.accent,
                  }}
                />
              ))}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: recording ? home.error : home.tertiary,
                }}
              />
              <Text style={{ fontSize: 16, lineHeight: 21, color: home.secondary }}>
                {t('listening')}
              </Text>
            </View>
            <Text
              accessibilityRole="timer"
              style={{
                fontSize: 64,
                lineHeight: 72,
                fontWeight: '500',
                letterSpacing: -0.96,
                color: home.text,
                fontVariant: ['tabular-nums'],
              }}
            >
              {formatElapsed(elapsed)}
            </Text>
          </View>
          <View style={{ alignItems: 'center', gap: 8, paddingTop: 8, paddingBottom: 24 }}>
            <Pressable
              cssInterop={false}
              accessibilityRole="button"
              accessibilityLabel={t('done')}
              accessibilityState={{ disabled: !recording }}
              disabled={!recording}
              onPress={() => {
                void finish();
              }}
              style={({ pressed }) => [
                {
                  width: 96,
                  height: 96,
                  borderRadius: 48,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: recording ? 1 : 0.5,
                },
                gloss,
                pressed && glossPressed,
              ]}
            >
              <SystemIcon name="checkmark" mdName="Check" size={28} color="#FFFFFF" />
            </Pressable>
            <Text style={type.footnote}>{t('done')}</Text>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}
