import type { StyleProp, ViewStyle } from 'react-native';

export interface SpeakerRenameLayout {
  keyboardStyle?: StyleProp<ViewStyle>;
  sheetStyle?: StyleProp<ViewStyle>;
  formStyle?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}

export function useSpeakerRenameLayout(): SpeakerRenameLayout {
  return {};
}
