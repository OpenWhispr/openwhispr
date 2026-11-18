import { KeyboardAvoidingView } from 'react-native';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { createFormSheet } from './FormSheetCore.android';

export const FormSheet = createFormSheet(function useFormPresentation() {
  const { copy } = useAndroidCopy();
  return {
    copy,
    keyboardHandlesPadding: true,
    wrapContent: (content, { keyboardHeight, sheetTop }) => (
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        enabled={keyboardHeight > 0}
        // KAV measures within the sheet; keyboard coordinates start at the screen top.
        keyboardVerticalOffset={sheetTop}
      >
        {content}
      </KeyboardAvoidingView>
    ),
    submitButton: (canSubmit, shadow) => ({
      accessibilityRole: 'button',
      accessibilityState: { disabled: !canSubmit },
      style: [canSubmit ? shadow : null, { borderCurve: 'continuous' }],
      className: `active:opacity-90 relative min-h-[52px] py-3 items-center justify-center rounded-full ${
        canSubmit ? 'bg-link' : 'bg-quaternarySystemFill'
      }`,
    }),
    destructiveButton: {
      className: 'active:opacity-60 mt-2.5 min-h-12 items-center justify-center',
    },
  };
});
