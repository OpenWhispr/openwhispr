const upstream: typeof import('./colors') = require('./colors.ts');

export const { BRAND, BRAND_GRADIENT, APP_BACKGROUND, CHAT_COLORS } = upstream;

const ANDROID_OVERRIDES: Record<string, string> = {
  secondaryLabel: '#69666F',
  tertiaryLabel: '#737078',
  tertiarySystemBackground: '#FFFFFF',
};

export function iosColor(name: string): string {
  return ANDROID_OVERRIDES[name] ?? upstream.iosColor(name);
}
