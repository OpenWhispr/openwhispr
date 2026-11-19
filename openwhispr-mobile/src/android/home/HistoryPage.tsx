import { useEffect, useRef, useState } from 'react';
import { Alert, Platform, Pressable, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { toFriendlyTranscriptionErrorMessage } from '@/lib/transcriptionErrors';
import { useTranscriptStore } from '@/store/useTranscriptStore.android';
import { applyHistoryRetention } from '../pipeline';
import { SettingsPage, showToast } from '../settings/kit';
import { edgeCard, edgeField } from '../settings/look';
import { useHomeT } from './strings';
import { home, SectionHeader, type } from './kit';
import { groupHistory, matchHistory } from './model';
import { HistoryRow } from './Sections';

// Android 13 and later confirm every copy with their own pill at the bottom of the screen.
const SYSTEM_CONFIRMS_COPY = Platform.OS === 'android' && Number(Platform.Version) >= 33;

/** Home → See all history: every saved dictation, grouped by day, with a search. */
export default function HistoryPage() {
  const h = useHomeT();
  const { t, i18n } = useTranslation();
  const history = useTranscriptStore((s) => s.transcripts);
  const [query, setQuery] = useState('');
  const [retrying, setRetrying] = useState(false);
  const retryController = useRef<AbortController | null>(null);
  useEffect(() => () => retryController.current?.abort(), []);

  const copy = (text: string) => {
    Clipboard.setStringAsync(text)
      .then(() => {
        if (!SYSTEM_CONFIRMS_COPY) showToast(h('copied'));
      })
      .catch((error: Error) => Alert.alert(t('errorTitle'), error.message));
  };
  const retry = async (id: string) => {
    if (retryController.current) return;
    const controller = new AbortController();
    retryController.current = controller;
    setRetrying(true);
    try {
      await useTranscriptStore.getState().retryTranscript(id, controller.signal);
      if (!controller.signal.aborted) showToast(h('addedToHistory'));
    } catch (error) {
      if (!controller.signal.aborted && (error as Error)?.name !== 'AbortError')
        Alert.alert(t('errorTitle'), toFriendlyTranscriptionErrorMessage(error));
    } finally {
      if (!controller.signal.aborted) {
        await applyHistoryRetention().catch(() => undefined);
        setRetrying(false);
      }
      retryController.current = null;
    }
  };

  const groups = groupHistory(matchHistory(history, query), h, i18n.language);
  return (
    <SettingsPage title={h('history')}>
      <View style={[edgeField, { flexDirection: 'row', alignItems: 'center', paddingLeft: 12 }]}>
        <SystemIcon name="magnifyingglass" mdName="Search" size={18} color={home.tertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={h('searchHistory')}
          placeholderTextColor={home.tertiary}
          accessibilityLabel={h('searchHistory')}
          returnKeyType="search"
          autoCorrect={false}
          style={{
            flex: 1,
            minHeight: 44,
            paddingHorizontal: 10,
            fontSize: 16,
            color: home.text,
          }}
        />
        {query ? (
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityLabel={h('clearSearch')}
            onPress={() => setQuery('')}
            hitSlop={4}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <SystemIcon name="xmark.circle.fill" mdName="CircleX" size={18} color={home.tertiary} />
          </Pressable>
        ) : null}
      </View>
      {!history.length ? (
        <View style={[edgeCard, { padding: 14, gap: 4 }]}>
          <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '500', color: home.text }}>
            {t('emptyHistory')}
          </Text>
          <Text style={type.footnote}>{t('emptyHistoryBody')}</Text>
        </View>
      ) : !groups.length ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[type.footnote, { textAlign: 'center', paddingTop: 24 }]}
        >
          {h('noMatches', { query: query.trim() })}
        </Text>
      ) : (
        groups.map((group) => (
          <View key={group.key} style={{ gap: 8 }}>
            <SectionHeader title={group.title} />
            <View style={edgeCard}>
              {group.rows.map(({ item, meta }, index) => (
                <HistoryRow
                  key={item.id}
                  item={item}
                  meta={meta}
                  last={index === group.rows.length - 1}
                  busy={retrying}
                  onCopy={copy}
                  onRetry={(id) => {
                    void retry(id);
                  }}
                />
              ))}
            </View>
          </View>
        ))
      )}
    </SettingsPage>
  );
}
