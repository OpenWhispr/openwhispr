import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { makeStyles } from '@/android/ThemeProvider';
import type { SpeakerRenameLayout } from './speakerRenameLayout';

// The scrim is a colour, so the sheet's styles are built per scheme (dark theme §3b).
const useStyles = makeStyles(() => ({
  keyboardContainer: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  sheet: { maxHeight: '100%', flexShrink: 1 },
  form: { flexShrink: 1 },
  content: { gap: 16 },
}));

export function useSpeakerRenameLayout(): SpeakerRenameLayout {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  return {
    keyboardStyle: [styles.keyboardContainer, { paddingTop: insets.top + 8 }],
    sheetStyle: styles.sheet,
    formStyle: styles.form,
    contentStyle: styles.content,
  };
}
