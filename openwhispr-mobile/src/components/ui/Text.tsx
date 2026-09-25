import { createContext, forwardRef, useContext } from 'react';
import { StyleSheet, Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { cssInterop } from 'nativewind';
import { displayFontFamily, fontFamilyForWeight } from '@/lib/fonts';

// A span without its own weight (e.g. an accent-coloured word) keeps its
// parent's face; picking one by its missing weight would drop it to regular
// mid-line.
const ParentFontContext = createContext<string | undefined>(undefined);

const BaseText = forwardRef<RNText, TextProps>(function BaseText({ style, ...props }, ref) {
  const parentFontFamily = useContext(ParentFontContext);
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const headingFontFamily = props.accessibilityRole === 'header' ? displayFontFamily : undefined;
  const inheritedFontFamily = flat.fontWeight == null ? parentFontFamily : undefined;
  const fontFamily =
    flat.fontFamily ??
    headingFontFamily ??
    inheritedFontFamily ??
    fontFamilyForWeight(flat.fontWeight);

  return (
    <ParentFontContext.Provider value={fontFamily}>
      <RNText ref={ref} style={[{ fontFamily }, style]} {...props} />
    </ParentFontContext.Provider>
  );
});

BaseText.displayName = 'AppText';

export const Text = cssInterop(BaseText, { className: 'style' }) as typeof BaseText;
