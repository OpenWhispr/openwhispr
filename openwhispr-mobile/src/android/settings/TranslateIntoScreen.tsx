import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { Group, ListRow, SettingsPage, useSettings } from './kit';
import { SearchField } from '../controls';
import { useSettingsT } from './strings';
import {
  TRANSLATE_LANGUAGES,
  currentTranslateTarget,
  phoneLanguages,
  saveTranslateTarget,
  searchLanguages,
  type TranslateLanguage,
} from './translateLanguages';

function phoneTags(): string[] {
  try {
    const tags = AndroidDictation?.getLocales?.();
    if (tags?.length) return tags;
    const one = AndroidDictation?.getLocale?.();
    return one ? [one] : [];
  } catch {
    return [];
  }
}

/**
 * Settings › Bubble › Assistant › Translate: the language Translate writes in. Search, then the
 * phone's languages and the rest of the 60, each once. Tapping one saves it and goes back. Spanish
 * until picked.
 */
export default function TranslateIntoScreen() {
  const t = useSettingsT();
  const settings = useSettings();
  const [query, setQuery] = useState('');
  const current = currentTranslateTarget(useConfigStore((s) => s.config?.androidTranslationTarget));
  const phone = useMemo(() => phoneLanguages(phoneTags()), []);
  // All languages leaves out the phone's, which are listed above it.
  const rest = useMemo(() => TRANSLATE_LANGUAGES.filter((item) => !phone.includes(item)), [phone]);
  const results = query.trim() ? searchLanguages(query) : null;

  const pick = (language: TranslateLanguage) => {
    void saveTranslateTarget(language).finally(() => {
      if (router.canGoBack()) router.back();
    });
  };
  const row = (language: TranslateLanguage) => {
    const selected = language.code === current.code;
    return (
      <ListRow
        key={language.code}
        title={language.label}
        selected={selected}
        trailing={selected ? undefined : null}
        accessibilityLabel={
          language.native === language.label ? undefined : `${language.label}, ${language.native}`
        }
        onPress={() => pick(language)}
      />
    );
  };

  return (
    <SettingsPage title={t('translateInto')}>
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t('searchLanguages')}
        clearLabel={t('clearSearch')}
        autoCapitalize="none"
      />

      {results ? (
        results.length ? (
          <Group inset={14}>{results.map(row)}</Group>
        ) : (
          <View
            accessibilityLiveRegion="polite"
            style={{ paddingTop: 40, gap: 6, paddingHorizontal: 16 }}
          >
            <Text style={[settings.rowTitle, { textAlign: 'center' }]}>
              {t('noLanguageCalled', { query: query.trim() })}
            </Text>
            <Text style={[settings.subtitle, { textAlign: 'center' }]}>{t('noLanguageHint')}</Text>
          </View>
        )
      ) : (
        <>
          {phone.length > 0 && (
            <Group title={t('onYourPhone')} inset={14}>
              {phone.map(row)}
            </Group>
          )}
          <Group title={t('allLanguages')} inset={14}>
            {rest.map(row)}
          </Group>
        </>
      )}
    </SettingsPage>
  );
}
