import { theme } from '@/android/theme';

const upstream: typeof import('./colors') = require('./colors.ts');

export const { BRAND, BRAND_GRADIENT, CHAT_COLORS } = upstream;

/** Android's page is the glossy white canvas (`src/android/theme`), not iOS's warm one. */
export const APP_BACKGROUND = theme.canvas;

const ANDROID_OVERRIDES: Record<string, string> = {
  secondaryLabel: '#69666F',
  tertiaryLabel: '#737078',
  tertiarySystemBackground: '#FFFFFF',
  systemBackground: theme.canvas,
};

export function iosColor(name: string): string {
  return ANDROID_OVERRIDES[name] ?? upstream.iosColor(name);
}
