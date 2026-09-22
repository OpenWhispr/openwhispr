import { forwardRef } from 'react';
import { StyleSheet, Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { cssInterop } from 'nativewind';
import { fontFamilyForWeight } from '@/lib/fonts';

const BaseText = forwardRef<RNText, TextProps>(function BaseText({ style, ...props }, ref) {
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const fontFamily = flat.fontFamily ?? fontFamilyForWeight(flat.fontWeight);

  return <RNText ref={ref} style={[{ fontFamily }, style]} {...props} />;
});

BaseText.displayName = 'AppText';

export const Text = cssInterop(BaseText, { className: 'style' }) as typeof BaseText;
