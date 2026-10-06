import { Platform, type TextStyle } from 'react-native';
import { getLoadedFonts } from 'expo-font';

type FontFaces = { regular: string; medium: string; semibold: string; bold: string };

// Keep in sync with the keys passed to `useFonts` in app/_layout.tsx. Space
// Grotesk is the fallback for builds without Yowza.
const SPACE_GROTESK: FontFaces = {
  regular: 'SpaceGrotesk_400Regular',
  medium: 'SpaceGrotesk_500Medium',
  semibold: 'SpaceGrotesk_600SemiBold',
  bold: 'SpaceGrotesk_700Bold',
};

// Yowza is licensed, so app.config.js embeds it in the native binary only when
// `npm run download:brand-fonts` fetched it. iOS names an embedded face by its
// PostScript name, Android by its file name.
function embeddedFace(postScriptName: string): string {
  return Platform.OS === 'ios' ? postScriptName : postScriptName.toLowerCase();
}

// Every emphasis weight is set in Yowza Soft Medium: Yowza's own Medium and
// Bold read too heavy at mobile sizes, so mobile departs from desktop here.
const YOWZA_SOFT_MEDIUM = embeddedFace('Yowza-Soft-Std-Medium');
const YOWZA: FontFaces = {
  regular: embeddedFace('Yowza-Std-Regular'),
  medium: YOWZA_SOFT_MEDIUM,
  semibold: YOWZA_SOFT_MEDIUM,
  bold: YOWZA_SOFT_MEDIUM,
};

// Ask the running binary, not the JS bundle: an OTA update or a dev bundle can
// run on a native build made with or without the fonts.
const embeddedFonts = new Set(getLoadedFonts());
const hasYowza = Object.values(YOWZA).every((face) => embeddedFonts.has(face));

export const AppFont: FontFaces = hasYowza ? YOWZA : SPACE_GROTESK;

// Headings are set in Yowza Soft, like desktop's h1–h6. Without Yowza they keep
// their weight-based face.
export const displayFontFamily: string | undefined = hasYowza ? YOWZA_SOFT_MEDIUM : undefined;

export function fontFamilyForWeight(weight: TextStyle['fontWeight']): string {
  // RN passes fontWeight as a string ('400', 'bold', etc.) or number.
  const w = weight == null ? '400' : String(weight);
  switch (w) {
    case '100':
    case '200':
    case '300':
    case '400':
    case 'normal':
      return AppFont.regular;
    case '500':
      return AppFont.medium;
    case '600':
      return AppFont.semibold;
    case '700':
    case '800':
    case '900':
    case 'bold':
      return AppFont.bold;
    default:
      return AppFont.regular;
  }
}
