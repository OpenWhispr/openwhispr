import { StyleSheet } from 'react-native';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { createAddWordsSheet } from './AddWordsSheetCore';

export const AddWordsSheet = createAddWordsSheet(function useWordsPresentation() {
  const { copy } = useAndroidCopy();
  return {
    copy,
    inputProps: () => ({
      accessibilityLabel: copy('library.addWords', 'Add words'),
      // Android measures single-line hints at infinite width, clipping wrapped large text.
      multiline: true,
      submitBehavior: 'blurAndSubmit',
    }),
    // NativeWind drops callback styles; keep Android constraints in static styles.
    chipStyle: (base) => [styles.chip, base],
    chipClassName: 'py-1 active:opacity-60',
    chipTextProps: { style: styles.chipText },
  };
});

const styles = StyleSheet.create({
  chip: {
    maxWidth: '100%',
    minWidth: 48,
    minHeight: 48,
  },
  chipText: {
    minWidth: 0,
    flexShrink: 1,
  },
});
