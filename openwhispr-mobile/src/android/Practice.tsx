import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Alert, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { AndroidDictation, dictationEvents } from '../../modules/android-dictation/src';
import { PermissionsContent } from './PermissionsScreen';
import { usePracticeSession } from './practiceSession';
import { useBubbleResult } from './bubbleResult';
import { makeStyles } from './ThemeProvider';

const useStyles = makeStyles((t) => ({
  body: { fontSize: 16, lineHeight: 24, color: t.tokens.secondary },
  card: { ...t.flat, padding: 20, borderRadius: 20, gap: 12 },
  field: {
    minHeight: 140,
    fontSize: 18,
    lineHeight: 27,
    color: t.tokens.ink,
    textAlignVertical: 'top',
  },
}));

/** Practice with the real bubble in a field inside the app. The bubble dictates only. */
export function Practice({
  onSuccess,
  visible = true,
}: {
  onSuccess?: () => void;
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const [text, setText] = useState('');
  const [ready, setReady] = useState(false);
  const [passed, setPassed] = useState(false);
  const completedMode = usePracticeSession((s) => s.completedMode);
  const revision = usePracticeSession((s) => s.revision);
  const initialRevision = useRef(revision);
  const success = useRef(onSuccess);
  success.current = onSuccess;
  const error = useBubbleResult((s) => s.error);
  const refresh = useCallback(() => {
    const status = AndroidDictation?.getStatus();
    setReady(
      Boolean(status?.enabled && status.overlay && status.accessibility && status.microphone),
    );
    const active = visible && AppState.currentState === 'active';
    usePracticeSession.setState({ active });
    void AndroidDictation?.setPractice(active).catch((failure: Error) =>
      Alert.alert(t('errorTitle'), failure.message),
    );
  }, [t, visible]);
  useEffect(() => {
    usePracticeSession.setState({ completedMode: null });
    refresh();
    const status = dictationEvents?.addListener('onStatusChange', refresh);
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
      else {
        usePracticeSession.setState({ active: false });
        void AndroidDictation?.setPractice(false).catch(() => undefined);
      }
    });
    return () => {
      status?.remove();
      foreground.remove();
      usePracticeSession.setState({ active: false, completedMode: null });
      void AndroidDictation?.setPractice(false).catch(() => undefined);
    };
  }, [refresh]);
  useEffect(() => {
    if (revision > initialRevision.current && completedMode === 'dictate') {
      initialRevision.current = revision;
      setPassed(true);
      success.current?.();
    }
  }, [revision, completedMode]);
  return (
    <View style={{ gap: 20 }}>
      <Text style={styles.body}>{t('dictateExample')}</Text>
      <View style={styles.card}>
        <TextInput
          multiline
          accessibilityLabel={t('messagePlaceholder')}
          placeholder={t('messagePlaceholder')}
          value={text}
          onChangeText={setText}
          style={styles.field}
        />
      </View>
      <Text accessibilityLiveRegion="polite" style={styles.body}>
        {t(passed ? 'success' : 'realBubblePractice')}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.body}>
          {error}
        </Text>
      ) : null}
      {!ready && <PermissionsContent />}
    </View>
  );
}
