import { useMemo, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useConfigStore } from '@/store/useConfigStore';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { home } from '../home/kit';
import { Group, ListRow, SettingsPage, settings } from './kit';
import { edgeField } from './look';
import { useSettingsT } from './strings';
import {
  TRANSLATE_LANGUAGES,
  currentTranslateTarget,
  phoneLanguages,
  recentLanguages,
  saveTranslateTarget,
  searchLanguages,
  useTranslateRecents,
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
 * Settings › Bubble › Assistant › Translate: the language Translate writes in. Search, then the last
 * picks, the phone's languages and all 60. Tapping one saves it and goes back. Spanish until picked.
 */
export default function TranslateIntoScreen() {
  const t = useSettingsT();
  const [query, setQuery] = useState('');
  const current = currentTranslateTarget(useConfigStore((s) => s.config?.androidTranslationTarget));
  const saved = useTranslateRecents((s) => s.codes);
  const recent = recentLanguages(current.code, saved);
  const phone = useMemo(() => phoneLanguages(phoneTags()), []).filter(
    (item) => !recent.includes(item),
  );
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
      <View
        style={[
          edgeField,
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingLeft: 14,
            paddingRight: 8,
            minHeight: 48,
          },
        ]}
      >
        <SystemIcon name="magnifyingglass" mdName="Search" size={18} color={home.tertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('searchLanguages')}
          placeholderTextColor={home.tertiary}
          accessibilityLabel={t('searchLanguages')}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          style={{ flex: 1, fontSize: 16, color: home.text, paddingVertical: 10 }}
        />
        {query ? (
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityLabel={t('clearSearch')}
            hitSlop={8}
            onPress={() => setQuery('')}
            style={{ padding: 6 }}
          >
            <SystemIcon name="xmark" mdName="X" size={16} color={home.tertiary} />
          </Pressable>
        ) : null}
      </View>

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
          <Group title={t('recent')} inset={14}>
            {recent.map(row)}
          </Group>
          {phone.length > 0 && (
            <Group title={t('onYourPhone')} inset={14}>
              {phone.map(row)}
            </Group>
          )}
          <Group title={t('allLanguages')} inset={14}>
            {TRANSLATE_LANGUAGES.map(row)}
          </Group>
        </>
      )}
    </SettingsPage>
  );
}
