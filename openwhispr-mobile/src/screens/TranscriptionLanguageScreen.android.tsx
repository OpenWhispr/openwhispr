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
import { Badge, Group, ListRow, SettingsPage, useSettings } from '@/android/settings/kit';
import { SystemIcon } from '@/components/ui/SystemIcon';
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

/**
 * Settings → Language: what dictation uses now in its own Current card, then every other choice
 * (Auto-detect first, then A to Z). A search filters one list instead. A tap saves and goes back.
 */
export default function LanguageScreen() {
  const t = useSettingsT();
  const settings = useSettings();
  // Settings' card: the glass edge, corners 16.
  const { edgeCard: cardStyle, sectionLabel } = useSettingsLook();
  const config = useConfigStore((s) => s.config);
  const local = useProcessingModeStore((s) => s.activeMode === 'private');
  const [query, setQuery] = useState('');
  // The list stops 16 dp above the gesture handle or the button bar.
  const { buttons, inset } = useNavigationBar();
  // What dictation uses now, so a language picked in onboarding shows here too.
  const selected = languageChoice(config?.languages, config?.preferredLanguage);
  const search = query.trim().toLowerCase();
  const current = registry.languages.find((item) => item.code === selected);
  // Without a search, the current choice sits in its own card above, so the list leaves it out.
  const languages = registry.languages.filter((item) =>
    search
      ? item.label.toLowerCase().includes(search) || item.code.toLowerCase() === search
      : item.code !== current?.code,
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

  const autoBadge = (onSelected: boolean) => (
    <Badge label={t('recommended')} onSelected={onSelected} />
  );

  return (
    <SettingsPage title={t('language')} scroll={false}>
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t('searchLanguages')}
        clearLabel={t('clearSearch')}
      />
      {!search && current && (
        <Group title={t('currentLanguage')}>
          <ListRow
            title={current.code === 'auto' ? t('autoDetect') : current.label}
            badge={current.code === 'auto' ? autoBadge(false) : undefined}
            subtitle={t(current.code === 'auto' ? 'currentAutoBody' : 'currentLanguageBody')}
            trailing={
              <SystemIcon name="checkmark" mdName="Check" size={20} color={settings.accent} />
            }
          />
        </Group>
      )}
      {!search && (
        <Text accessibilityRole="header" style={[sectionLabel, { marginBottom: -4 }]}>
          {t('allLanguages')}
        </Text>
      )}
      {/* One card that fills the room left down to the handle or bar and scrolls inside, so the
          list never runs off the bottom of the screen. */}
      <View style={[cardStyle, { flexShrink: 1, marginBottom: 16 + (buttons ? 0 : inset) }]}>
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
              badge={item.code === 'auto' ? autoBadge(selected === 'auto') : undefined}
              selected={selected === item.code}
              trailing={null}
              onPress={() => choose(item.code, item.label)}
            />
          )}
        />
      </View>
    </SettingsPage>
  );
}
