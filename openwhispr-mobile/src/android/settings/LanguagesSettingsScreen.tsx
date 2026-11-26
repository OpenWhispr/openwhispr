import { useEffect, useState } from 'react';
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
 * override it. There is always one: with nothing saved, the phone's language is shown and saved.
 * One language is sent to dictation, cleanup and the assistant as a hint; several means
 * auto-detect.
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
  const unsaved = !!config && (!config.languages?.length || !!config.preferredLanguage);
  useEffect(() => {
    if (unsaved) save(codes);
    // Once, when the screen finds nothing saved as a list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsaved]);
  return (
    <SettingsPage title={t('languagesPage')}>
      <Text style={[settings.subtitle, { paddingHorizontal: 4 }]}>{t('languagesPageBody')}</Text>
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
