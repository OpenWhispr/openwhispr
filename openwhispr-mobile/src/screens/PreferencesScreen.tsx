import React from 'react';
import { router } from 'expo-router';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { SoonBadge } from '@/components/ui/SoonBadge';
import { useConfigStore } from '@/store/useConfigStore';
import { useConfigToggle } from '@/hooks/useConfigToggle';
import { DEFAULT_LANGUAGE, getLanguage } from '@/lib/languages';

export default function PreferencesScreen() {
  const config = useConfigStore((state) => state.config);
  const autoLearn = config?.autoLearnCorrections ?? true;
  const language = getLanguage(config?.preferredLanguage ?? DEFAULT_LANGUAGE);
  const handleToggleAutoLearn = useConfigToggle('autoLearnCorrections');

  return (
    <SettingsScreen>
      <SettingsSection title="General">
        <SettingsRow
          iconStyle="line"
          icon="paintbrush"
          mdIcon="Paintbrush"
          title="Appearance"
          rightElement={<SoonBadge />}
          showChevron={false}
        />
        <SettingsRow
          iconStyle="line"
          icon="globe"
          mdIcon="Globe"
          title="Transcription Language"
          subtitle={language.label}
          onPress={() => router.push('/(account)/transcription-language')}
        />
        <SettingsRow
          iconStyle="line"
          icon="text.book.closed"
          mdIcon="BookText"
          title="Auto-learn from Corrections"
          description="Words you edit into a transcription are automatically added to your dictionary."
          rightElement={<SettingsSwitch value={autoLearn} onValueChange={handleToggleAutoLearn} />}
          showChevron={false}
        />
      </SettingsSection>
      <SettingsSection>
        <SettingsRow
          iconStyle="line"
          icon="keyboard"
          mdIcon="Keyboard"
          title="Keyboard"
          description="Setup, dictation and typing"
          onPress={() => router.push('/(account)/keyboard')}
        />
      </SettingsSection>
    </SettingsScreen>
  );
}
