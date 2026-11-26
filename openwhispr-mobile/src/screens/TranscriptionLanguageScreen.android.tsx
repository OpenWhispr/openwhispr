import { useState } from 'react';
import { Alert, FlatList, View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import registry from '@/config/languageRegistry.json';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { safeHaptics } from '@/lib/utils';
import { speechModelSupportsLanguages } from '@/android/speechCapabilities';
import type { AndroidSpeechModelId } from '@/android/speechSelection';
import { Badge, ListRow, SettingsPage, useSettings } from '@/android/settings/kit';
import { MODEL_ROWS, modelName } from '@/android/settings/modelCatalog';
import { useSettingsT } from '@/android/settings/strings';
import { useNavigationBar } from '@/android/navigationBar';
import { useSettingsLook } from '@/android/settings/look';
import { SearchField } from '@/android/controls';
import { languageChoice } from '@/android/onboarding/languages';

function Divider() {
  const { look } = useSettingsLook();
  return <View style={{ height: 1, marginLeft: 14, backgroundColor: look.hairline }} />;
}

/** Settings → Language: one searchable list; a tap saves and goes straight back. */
export default function LanguageScreen() {
  const t = useSettingsT();
  const settings = useSettings();
  // Settings' card: the glass edge, corners 16.
  const { edgeCard: cardStyle } = useSettingsLook();
  const config = useConfigStore((s) => s.config);
  const local = useProcessingModeStore((s) => s.activeMode === 'private');
  const [query, setQuery] = useState('');
  // The card stops 16 dp above the gesture handle or the button bar.
  const { buttons, inset } = useNavigationBar();
  // What dictation uses now, so a language picked in onboarding shows here too.
  const selected = languageChoice(config?.languages, config?.preferredLanguage);
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
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t('searchLanguages')}
        clearLabel={t('clearSearch')}
      />
      {/* One card that fills the room left down to the handle or bar and scrolls inside, so the
          list never runs off the bottom of the screen. */}
      <View style={[cardStyle, { flexShrink: 1 }]}>
        <FlatList
          data={languages}
          keyExtractor={(item) => item.code}
          keyboardShouldPersistTaps="handled"
          style={{ flexGrow: 0 }}
          ItemSeparatorComponent={Divider}
          ListEmptyComponent={
            <Text style={[settings.subtitle, { padding: 16 }]}>
              {t('noLanguages', { query: query.trim() })}
            </Text>
          }
          renderItem={({ item }) => (
            <ListRow
              title={item.code === 'auto' ? t('autoDetect') : item.label}
              badge={
                item.code === 'auto' ? (
                  <Badge label={t('recommended')} onSelected={selected === 'auto'} />
                ) : undefined
              }
              selected={selected === item.code}
              trailing={null}
              onPress={() => choose(item.code, item.label)}
            />
          )}
        />
      </View>
      <Text
        style={[
          settings.subtitle,
          { paddingHorizontal: 4, marginTop: -8, marginBottom: 16 + (buttons ? 0 : inset) },
        ]}
      >
        {search ? '' : t('languagesFooter', { count: registry.languages.length - 1 })}
      </Text>
    </SettingsPage>
  );
}
