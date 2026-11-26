import { useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { AddLanguageSheet, LanguageRows } from '../onboarding/LanguagesScreen';
import { SecondaryButton } from '../onboarding/kit';
import { useOnboardingT } from '../onboarding/strings';
import { savedLanguages } from '../onboarding/languages';
import { SettingsPage, useSettings } from './kit';
import { useSettingsT } from './strings';

/**
 * Settings › Language: the languages picked in onboarding, to add to or remove. Each change saves
 * at once, as onboarding does: one list, with Settings' old single pick cleared so it can't
 * override it. One language is sent to dictation, cleanup and the assistant as a hint; none or
 * several means auto-detect.
 */
export default function LanguagesSettingsScreen() {
  const t = useSettingsT();
  const ot = useOnboardingT();
  const settings = useSettings();
  const config = useConfigStore((state) => state.config);
  const codes = savedLanguages(config?.languages, config?.preferredLanguage);
  const [adding, setAdding] = useState(false);
  const save = (next: string[]) => {
    void useConfigStore.getState().updateConfig({ languages: next, preferredLanguage: undefined });
  };
  return (
    <SettingsPage title={t('languagesPage')}>
      <Text style={[settings.subtitle, { paddingHorizontal: 4 }]}>
        {t(codes.length ? 'languagesPageBody' : 'languagesPageAuto')}
      </Text>
      <LanguageRows
        codes={codes}
        onRemove={(code) => save(codes.filter((item) => item !== code))}
      />
      <View style={{ marginTop: 4 }}>
        <SecondaryButton label={ot('addLanguage')} onPress={() => setAdding(true)} />
      </View>
      <AddLanguageSheet
        visible={adding}
        selected={codes}
        onClose={() => setAdding(false)}
        onAdd={(code) => {
          if (!codes.includes(code)) save([...codes, code]);
          setAdding(false);
        }}
      />
    </SettingsPage>
  );
}
