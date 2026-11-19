import { Linking, View } from 'react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { Group, ListRow, SettingsPage, settings } from '@/android/settings/kit';
import { bodyText } from '@/android/settings/look';
import notices from '@/android/licenses.json';

const entries = [
  {
    name: 'Moonshine Tiny / Small Streaming (English)',
    license: 'MIT',
    owner: 'Useful Sensors, Inc. (dba Moonshine AI)',
    note: 'modelMoonshine',
    url: 'https://github.com/moonshine-ai/moonshine/blob/234f60faa0eb388b01cdf7e60aca232af37aefda/LICENSE',
  },
  {
    name: 'NVIDIA Parakeet TDT 0.6B v3',
    license: 'CC-BY-4.0',
    owner: 'NVIDIA Corporation',
    note: 'parakeetCredit',
    url: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3',
  },
  {
    name: 'Sherpa-ONNX',
    license: 'Apache-2.0',
    owner: 'k2-fsa contributors',
    note: 'sherpaCredit',
    url: 'https://github.com/k2-fsa/sherpa-onnx',
  },
  {
    name: 'Qwen2.5 0.5B Instruct',
    license: 'Apache-2.0',
    owner: 'Qwen Team, Alibaba Cloud',
    note: 'qwenCredit',
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF',
  },
  {
    name: 'Qwen3 1.7B',
    license: 'Apache-2.0',
    owner: 'Qwen Team, Alibaba Cloud',
    note: 'qwen3Credit',
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF',
  },
  {
    name: 'llama.cpp / llama.rn',
    license: 'MIT',
    owner: 'Georgi Gerganov, mybigday and contributors',
    note: 'llamaCredit',
    url: 'https://github.com/mybigday/llama.rn',
  },
];
export default function LicensesScreen() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <SettingsPage title={t('licenses')}>
      <Text style={bodyText}>{t('licenseIntro')}</Text>
      <Group inset={14}>
        {entries.map((entry) => (
          <ListRow
            key={entry.name}
            title={entry.name}
            subtitle={
              <View style={{ gap: 4 }}>
                <Text style={settings.subtitle}>
                  {entry.license} · © {entry.owner}
                </Text>
                <Text style={settings.subtitle}>{t(entry.note)}</Text>
              </View>
            }
            onPress={() => {
              void Linking.openURL(entry.url);
            }}
          />
        ))}
      </Group>
      <Group inset={14}>
        <ListRow
          title="CC-BY-4.0"
          onPress={() => {
            void Linking.openURL('https://creativecommons.org/licenses/by/4.0/');
          }}
        />
      </Group>
      <Group title={t('licenseNotices')} inset={14}>
        {notices.map((notice) => (
          <View key={notice.name}>
            <ListRow
              title={notice.name}
              onPress={() => setExpanded(expanded === notice.name ? null : notice.name)}
            />
            {expanded === notice.name && (
              <>
                <Text selectable style={[settings.subtitle, { paddingHorizontal: 14 }]}>
                  {notice.text}
                </Text>
                <ListRow
                  title={t('licenseSource')}
                  onPress={() => {
                    void Linking.openURL(notice.url);
                  }}
                />
              </>
            )}
          </View>
        ))}
      </Group>
    </SettingsPage>
  );
}
