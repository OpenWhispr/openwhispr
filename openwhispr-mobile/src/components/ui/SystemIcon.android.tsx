import type React from 'react';
import { I18nManager } from 'react-native';
import * as LucideIcons from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { BRAND, iosColor } from '@/config/colors';
import type { LucideIconName, SystemIconColor } from './SystemIcon';

export type { LucideIconName, SystemIconColor } from './SystemIcon';

const TOKEN_COLORS = new Set([
  'label',
  'secondaryLabel',
  'tertiaryLabel',
  'quaternaryLabel',
  'link',
  'separator',
  'systemRed',
  'systemGreen',
  'systemBlue',
]);

const DIRECTIONAL_ICONS: Partial<Record<LucideIconName, LucideIconName>> = {
  ArrowLeft: 'ArrowRight',
  ArrowRight: 'ArrowLeft',
  ChevronLeft: 'ChevronRight',
  ChevronRight: 'ChevronLeft',
};

export function SystemIcon({
  name,
  mdName,
  size = 18,
  color = 'label',
}: {
  name: string;
  mdName?: LucideIconName;
  size?: number;
  color?: SystemIconColor;
}) {
  const { i18n } = useTranslation();
  // An app-language change can retain a JS runtime with a stale native RTL flag.
  const language = i18n.resolvedLanguage || i18n.language;
  const rtl = language ? i18n.dir(language) === 'rtl' : I18nManager.isRTL;
  if (!mdName) {
    if (__DEV__) console.warn(`SystemIcon "${name}" missing mdName for Android fallback.`);
    return null;
  }
  const tint = !color
    ? undefined
    : color === 'brand'
      ? BRAND
      : TOKEN_COLORS.has(color)
        ? iosColor(color)
        : color;
  const icon = rtl ? (DIRECTIONAL_ICONS[mdName] ?? mdName) : mdName;
  const LucideIcon = LucideIcons[icon] as React.ComponentType<{ size?: number; color?: string }>;
  return <LucideIcon size={size} color={tint ?? '#000'} />;
}
