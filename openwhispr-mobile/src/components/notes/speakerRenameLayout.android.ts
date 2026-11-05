import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SpeakerRenameLayout } from './speakerRenameLayout';

const styles = StyleSheet.create({
  keyboardContainer: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  sheet: { maxHeight: '100%', flexShrink: 1 },
  form: { flexShrink: 1 },
  content: { gap: 16 },
});

export function useSpeakerRenameLayout(): SpeakerRenameLayout {
  const insets = useSafeAreaInsets();
  return {
    keyboardStyle: [styles.keyboardContainer, { paddingTop: insets.top + 8 }],
    sheetStyle: styles.sheet,
    formStyle: styles.form,
    contentStyle: styles.content,
  };
}
