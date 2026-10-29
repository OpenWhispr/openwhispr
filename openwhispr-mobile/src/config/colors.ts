import { PlatformColor } from 'react-native';

export const BRAND = '#007AFF';

// OpenWhispr brand gradient for primary surfaces (buttons, avatar). Mirrors
// the logo gradient: #5B81E4 → #154BD4 → #163992. Mirrors the keyboard extension's dictation
// button (Swift `Palette.brandGradientStart` / `brandGradientMiddle` / `brandGradientEnd` in
// KeyboardViewController.swift) so the app and keyboard stay visually identical.
// Rendered diagonally (top-left → bottom-right) to match that button. Single
// source of truth for every gradient-glass surface.
export const BRAND_GRADIENT = ['#5B81E4', '#154BD4', '#163992'] as const;

// App-wide page background. Overrides iOS `systemBackground` so the warm tone
// appears uniformly across screens and components that read this token.
export const APP_BACKGROUND = '#F8F6F5';

const ANDROID_FALLBACKS: Record<string, string> = {
  label: '#000000',
  secondaryLabel: '#3C3C434D',
  tertiaryLabel: '#3C3C434D',
  quaternaryLabel: '#3C3C432E',
  systemBackground: APP_BACKGROUND,
  secondarySystemBackground: '#F2F2F7',
  secondarySystemGroupedBackground: '#FFFFFF',
  tertiarySystemFill: '#76768014',
  quaternarySystemFill: '#7676800F',
  separator: '#3C3C4349',
  link: BRAND,
  systemRed: '#FF3B30',
  systemGreen: '#34C759',
  systemBlue: BRAND,
  systemPurple: '#AF52DE',
  systemOrange: '#FF9500',
  systemIndigo: '#5856D6',
  systemPink: '#FF2D55',
  systemGray2: '#AEAEB2',
};

const IOS_LITERAL_OVERRIDES: Record<string, string> = {
  systemBackground: APP_BACKGROUND,
  secondarySystemGroupedBackground: '#FFFFFF',
};

export function iosColor(name: string): string {
  if (process.env.EXPO_OS === 'ios') {
    return IOS_LITERAL_OVERRIDES[name] ?? (PlatformColor(name) as unknown as string);
  }
  return ANDROID_FALLBACKS[name] ?? '#000000';
}

// Fixed colors for the Chat tab that have no system token. Text and fills that
// do have one (label, secondaryLabel, ...) use the NativeWind token instead.
export const CHAT_COLORS = {
  darkFill: '#111113',
  hairline: 'rgba(0,0,0,0.08)',
  neutralRing: 'rgba(0,0,0,0.12)',
  neutralTrack: 'rgba(0,0,0,0.06)',
  successForeground: '#1E7A3D',
  successBackground: '#E6F3EA',
  errorForeground: '#B3261E',
  errorBackground: '#FBECEA',
  // BRAND_GRADIENT's middle stop, around the mic while it listens.
  listeningRing: 'rgba(21,75,212,0.22)',
  // Faint enough that text over it keeps its contrast.
  watermark: 'rgba(17,17,19,0.035)',
  onGradient: '#FFFFFF',
  onGradientSubtle: 'rgba(255,255,255,0.55)',
} as const;
