import React, { useEffect, useState } from 'react';
import { ScrollView, View, Pressable, Linking } from 'react-native';
import { Text } from '@/components/ui/Text';
import {
  LocalParakeetService,
  type ModelNotice,
} from '@/services/transcription/LocalParakeetService';

interface LicenseEntry {
  name: string;
  license: string;
  copyright: string;
  note?: string;
  url: string;
}

// Static so the screen renders offline — CC-BY attribution must not depend on a network call.
const ENTRIES: LicenseEntry[] = [
  {
    name: 'NVIDIA Parakeet TDT 0.6b (v2, v3)',
    license: 'CC-BY-4.0',
    copyright: '© NVIDIA Corporation',
    note: 'On-device speech recognition models. CoreML conversion by FluidInference.',
    url: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2',
  },
  {
    name: 'Orukeet r3',
    license: 'CC-BY-SA-4.0',
    copyright: '© Oruk AI — adaptation of NVIDIA Parakeet TDT 0.6B v3',
    note: 'Optional on-device speech recognition model (INT8 Core ML build).',
    url: 'https://huggingface.co/oruk/orukeet',
  },
  {
    name: 'FluidAudio',
    license: 'Apache-2.0',
    copyright: '© FluidInference',
    note: "On-device ASR and speaker-diarization runtime, built from Oruk AI's fork with a Core ML buffer performance patch.",
    url: 'https://github.com/Oruk-AI/FluidAudio',
  },
  {
    name: 'fastcluster',
    license: 'BSD-2-Clause',
    copyright: '© Daniel Müllner, © Google Inc.',
    note: 'Hierarchical clustering used by FluidAudio for speaker diarization.',
    url: 'https://danifold.net/fastcluster.html',
  },
  {
    name: 'VBx',
    license: 'Apache-2.0',
    copyright: '© Brno University of Technology',
    note: 'Speaker clustering used by FluidAudio for speaker diarization.',
    url: 'https://github.com/BUTSpeechFIT/VBx',
  },
  {
    name: 'OrukeetCoreML',
    license: 'MIT',
    copyright: '© Knuckles92, © Oruk AI',
    note: 'Verifies, extracts and compiles the Orukeet model on device.',
    url: 'https://github.com/Oruk-AI/orukeet',
  },
  {
    name: 'ZIPFoundation',
    license: 'MIT',
    copyright: '© Thomas Zoechling',
    note: 'Extracts the Orukeet model archive.',
    url: 'https://github.com/weichsel/ZIPFoundation',
  },
  {
    name: 'whisper.cpp / whisper.rn',
    license: 'MIT',
    copyright: '© Georgi Gerganov and contributors',
    note: 'On-device Whisper speech recognition.',
    url: 'https://github.com/ggerganov/whisper.cpp',
  },
];

export default function LicensesScreen() {
  // The notices ship inside the installed model, so they are only there once Orukeet is downloaded.
  const [notices, setNotices] = useState<ModelNotice[]>([]);
  const [showNotices, setShowNotices] = useState(false);

  useEffect(() => {
    let stale = false;
    LocalParakeetService.modelNotices('orukeet')
      .then((loaded) => {
        if (!stale) setNotices(loaded);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, []);

  return (
    <ScrollView
      className="flex-1 bg-systemBackground"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
    >
      <Text className="mb-4 px-1 text-sm text-secondaryLabel">
        OpenWhispr's on-device intelligence is built on these open models and libraries.
      </Text>

      <View className="gap-3">
        {ENTRIES.map((entry) => (
          <Pressable
            key={entry.name}
            onPress={() => Linking.openURL(entry.url)}
            accessibilityRole="link"
            accessibilityLabel={`${entry.name} license details`}
            style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1, borderCurve: 'continuous' })}
            className="rounded-[10px] bg-secondarySystemGroupedBackground p-4"
          >
            <View className="mb-1 flex-row items-center justify-between gap-2">
              <Text className="flex-1 text-[15px] font-semibold text-label">{entry.name}</Text>
              <View
                style={{ borderCurve: 'continuous' }}
                className="rounded-md bg-tertiarySystemFill px-2 py-0.5"
              >
                <Text className="text-[11px] font-semibold text-secondaryLabel">
                  {entry.license}
                </Text>
              </View>
            </View>
            <Text className="text-xs text-secondaryLabel">{entry.copyright}</Text>
            {entry.note ? (
              <Text className="mt-1 text-xs text-tertiaryLabel">{entry.note}</Text>
            ) : null}
          </Pressable>
        ))}
      </View>

      {notices.length > 0 ? (
        <View className="mt-5 gap-3">
          <Pressable
            onPress={() => setShowNotices((shown) => !shown)}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            className="self-start px-1"
          >
            <Text className="text-sm font-medium text-brand">
              {showNotices ? 'Hide model notices' : 'View model notices'}
            </Text>
          </Pressable>
          {showNotices
            ? notices.map((notice) => (
                <View
                  key={notice.fileName}
                  style={{ borderCurve: 'continuous' }}
                  className="rounded-[10px] bg-secondarySystemGroupedBackground p-4"
                >
                  <Text className="mb-2 text-[13px] font-semibold text-label">
                    {notice.fileName}
                  </Text>
                  <Text selectable className="text-xs leading-[18px] text-secondaryLabel">
                    {notice.text}
                  </Text>
                </View>
              ))
            : null}
        </View>
      ) : null}
    </ScrollView>
  );
}
