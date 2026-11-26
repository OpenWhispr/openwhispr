import { useEffect, useRef, useState } from 'react';
import { Alert, Platform, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { toFriendlyTranscriptionErrorMessage } from '@/lib/transcriptionErrors';
import { useTranscriptStore } from '@/android/store/useTranscriptStore';
import { applyHistoryRetention } from '../pipeline';
import { SettingsPage, showToast } from '../settings/kit';
import { SearchField } from '../controls';
import { useHomeT } from './strings';
import { SectionHeader, useHome } from './kit';
import { groupHistory, matchHistory } from './model';
import { HistoryRow } from './Sections';

// Android 13 and later confirm every copy with their own pill at the bottom of the screen.
const SYSTEM_CONFIRMS_COPY = Platform.OS === 'android' && Number(Platform.Version) >= 33;

/** Home → See all history: every saved dictation, grouped by day, with a search. */
export default function HistoryPage() {
  const h = useHomeT();
  const { t, i18n } = useTranslation();
  const { type, card } = useHome();
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
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={h('searchHistory')}
        clearLabel={h('clearSearch')}
      />
      {!history.length ? (
        <View style={[card, { padding: 14, gap: 4 }]}>
          <Text style={type.rowTitle}>{t('emptyHistory')}</Text>
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
            <View style={card}>
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
