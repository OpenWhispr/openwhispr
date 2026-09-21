import React from 'react';
import { ScrollView, View, Pressable, Linking } from 'react-native';
import { Text } from '@/components/ui/Text';

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
    name: 'FluidAudio',
    license: 'Apache-2.0',
    copyright: '© FluidInference',
    note: 'On-device ASR and speaker-diarization runtime.',
    url: 'https://github.com/FluidInference/FluidAudio',
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
    </ScrollView>
  );
}
