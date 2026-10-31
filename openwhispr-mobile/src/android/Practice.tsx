import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Alert, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { AndroidDictation, dictationEvents } from '../../modules/android-dictation/src';
import { PermissionsContent } from './PermissionsScreen';
import { usePracticeSession } from './practiceSession';
import { useBubbleResult } from './bubbleResult';
import type { DictationMode } from './pipeline';
import { Card, styles, palette } from './ui';

export function Practice({
  initialMode = 'dictate',
  onSuccess,
  visible = true,
}: {
  initialMode?: DictationMode;
  onSuccess?: () => void;
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialMode === 'edit' ? t('editSeed') : '');
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
    void AndroidDictation?.setPractice(active, initialMode).catch((failure: Error) =>
      Alert.alert(t('errorTitle'), failure.message),
    );
  }, [initialMode, t, visible]);
  useEffect(() => {
    usePracticeSession.setState({ completedMode: null });
    refresh();
    const status = dictationEvents?.addListener('onStatusChange', refresh);
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
      else {
        usePracticeSession.setState({ active: false });
        void AndroidDictation?.setPractice(false, 'dictate').catch(() => undefined);
      }
    });
    return () => {
      status?.remove();
      foreground.remove();
      usePracticeSession.setState({ active: false, completedMode: null });
      void AndroidDictation?.setPractice(false, 'dictate').catch(() => undefined);
    };
  }, [refresh]);
  useEffect(() => {
    if (revision > initialRevision.current && completedMode === initialMode) {
      initialRevision.current = revision;
      setPassed(true);
      success.current?.();
    }
  }, [revision, completedMode, initialMode]);
  return (
    <View style={{ gap: 20 }}>
      <Text style={styles.body}>{t(`${initialMode}Example`)}</Text>
      <Card>
        <TextInput
          multiline
          accessibilityLabel={t('messagePlaceholder')}
          placeholder={t('messagePlaceholder')}
          value={text}
          onChangeText={setText}
          style={{
            minHeight: 140,
            fontSize: 18,
            lineHeight: 27,
            color: palette.ink,
            textAlignVertical: 'top',
          }}
        />
      </Card>
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
