import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

export const glassStackOptions: NativeStackNavigationOptions = {
  headerTransparent: true,
  headerLargeTitle: true,
  headerBlurEffect: 'systemMaterial',
  headerLargeStyle: { backgroundColor: 'transparent' },
  headerShadowVisible: false,
  headerLargeTitleShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal',
};

/**
 * For screens that draw their own header with `TabScreenHeader` instead of the
 * native bar.
 *
 * iOS 26 gives every content ScrollView an automatic scroll edge effect, which
 * blurs content under the navigation area. With no native bar above it that
 * reads as an unexplained lighter band with a divider, so the header and the
 * body stop looking like one surface. Hiding it also resolves react-native-
 * screens' `blurEffect` + `scrollEdgeEffects` overlap warning.
 */
export const customHeaderStackOptions: NativeStackNavigationOptions = {
  headerShown: false,
  scrollEdgeEffects: { top: 'hidden', bottom: 'hidden', left: 'hidden', right: 'hidden' },
};
