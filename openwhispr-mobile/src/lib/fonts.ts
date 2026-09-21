import type { TextStyle } from 'react-native';

// Family constants — keep in sync with the keys passed to `useFonts` in
// app/_layout.tsx and the asset names installed by @expo-google-fonts.
export const SpaceGrotesk = {
  regular: 'SpaceGrotesk_400Regular',
  medium: 'SpaceGrotesk_500Medium',
  semibold: 'SpaceGrotesk_600SemiBold',
  bold: 'SpaceGrotesk_700Bold',
} as const;

export function fontFamilyForWeight(weight: TextStyle['fontWeight']): string {
  // RN passes fontWeight as a string ('400', 'bold', etc.) or number.
  const w = weight == null ? '400' : String(weight);
  switch (w) {
    case '100':
    case '200':
    case '300':
    case '400':
    case 'normal':
      return SpaceGrotesk.regular;
    case '500':
      return SpaceGrotesk.medium;
    case '600':
      return SpaceGrotesk.semibold;
    case '700':
    case '800':
    case '900':
    case 'bold':
      return SpaceGrotesk.bold;
    default:
      return SpaceGrotesk.regular;
  }
}
