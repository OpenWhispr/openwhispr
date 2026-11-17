import { useState } from 'react';
import { Alert, FlatList, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import registry from '@/config/languageRegistry.json';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { safeHaptics } from '@/lib/utils';
import { home } from '@/android/home/kit';
import { speechModelSupportsLanguages } from '@/android/speechCapabilities';
import type { AndroidSpeechModelId } from '@/android/speechSelection';
import { Badge, ListRow, SettingsPage, cardStyle, settings } from '@/android/settings/kit';
import { MODEL_ROWS, modelName } from '@/android/settings/modelCatalog';
import { useSettingsT } from '@/android/settings/strings';

/** Settings → Language: one searchable list; a tap saves and goes straight back. */
export default function LanguageScreen() {
  const t = useSettingsT();
  const config = useConfigStore((s) => s.config);
  const local = useProcessingModeStore((s) => s.activeMode === 'private');
  const [query, setQuery] = useState('');
  const selected = config?.preferredLanguage ?? 'auto';
  const search = query.trim().toLowerCase();
  const languages = registry.languages.filter(
    (item) =>
      !search || item.label.toLowerCase().includes(search) || item.code.toLowerCase() === search,
  );

  const save = (code: string, speech?: AndroidSpeechModelId) => {
    void useConfigStore.getState().updateConfig({
      preferredLanguage: code,
      ...(speech ? { androidSpeechModel: speech } : {}),
    });
    router.back();
  };

  const choose = (code: string, label: string) => {
    safeHaptics('light');
    const speech: AndroidSpeechModelId = config?.androidSpeechModel ?? 'parakeet-v3';
    // Dictation on this phone: warn when its speech model can't hear the language.
    if (!local || code === 'auto' || speechModelSupportsLanguages(speech, [code])) {
      save(code);
      return;
    }
    const other = MODEL_ROWS.find(
      (row) =>
        row.kind === 'speech' &&
        row.id !== speech &&
        speechModelSupportsLanguages(row.id as AndroidSpeechModelId, [code]),
    );
    const model = modelName(speech);
    Alert.alert(
      t('modelCantDo', { model, language: label }),
      other
        ? t('modelCantDoBody', { other: modelName(other.id) })
        : t('modelCantDoCloud', { language: label }),
      [
        // With nothing on the phone that can do it, the language is only kept on purpose.
        ...(other ? [] : [{ text: t('cancel'), style: 'cancel' as const }]),
        { text: t('keepModel', { model }), onPress: () => save(code) },
        ...(other
          ? [
              {
                text: t('useModel', { model: modelName(other.id) }),
                onPress: () => save(code, other.id as AndroidSpeechModelId),
              },
            ]
          : []),
      ],
    );
  };

  return (
    <SettingsPage title={t('language')} scroll={false}>
      <View
        style={[
          cardStyle,
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 12,
            borderColor: query ? home.accent : home.borderDefault,
            boxShadow: undefined,
          },
        ]}
      >
        <SystemIcon name="magnifyingglass" mdName="Search" size={18} color={home.tertiary} />
        <TextInput
          accessibilityLabel={t('searchLanguages')}
          placeholder={t('searchLanguages')}
          placeholderTextColor={home.tertiary}
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          style={{ flex: 1, minHeight: 44, fontSize: 17, color: home.text }}
        />
      </View>
      <FlatList
        data={languages}
        keyExtractor={(item) => item.code}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 32 }}
        style={{ flex: 1 }}
        ListEmptyComponent={
          <Text style={[settings.subtitle, { paddingHorizontal: 4 }]}>
            {t('noLanguages', { query: query.trim() })}
          </Text>
        }
        ListFooterComponent={
          languages.length && !search ? (
            <Text style={[settings.subtitle, { padding: 4, paddingTop: 12 }]}>
              {t('languagesFooter', { count: registry.languages.length - 1 })}
            </Text>
          ) : null
        }
        renderItem={({ item, index }) => (
          <View
            style={[
              cardStyle,
              {
                borderRadius: 0,
                borderTopWidth: index === 0 ? 1 : 0,
                borderBottomWidth: index === languages.length - 1 ? 1 : 0,
                borderTopLeftRadius: index === 0 ? 14 : 0,
                borderTopRightRadius: index === 0 ? 14 : 0,
                borderBottomLeftRadius: index === languages.length - 1 ? 14 : 0,
                borderBottomRightRadius: index === languages.length - 1 ? 14 : 0,
                boxShadow: undefined,
              },
            ]}
          >
            {index > 0 && (
              <View style={{ height: 1, marginLeft: 16, backgroundColor: home.divider }} />
            )}
            <ListRow
              title={item.code === 'auto' ? t('autoDetect') : item.label}
              badge={
                item.code === 'auto' ? (
                  <Badge label={t('recommended')} onSelected={selected === 'auto'} />
                ) : undefined
              }
              selected={selected === item.code}
              trailing={selected === item.code ? undefined : null}
              onPress={() => choose(item.code, item.label)}
            />
          </View>
        )}
      />
    </SettingsPage>
  );
}
