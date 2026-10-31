import React from 'react';
import { I18nManager, type ColorValue } from 'react-native';
import { Image } from 'expo-image';
import * as LucideIcons from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { BRAND, iosColor } from '@/config/colors';

const IS_IOS = process.env.EXPO_OS === 'ios';

const TOKEN_COLORS = {
  label: 'label',
  secondaryLabel: 'secondaryLabel',
  tertiaryLabel: 'tertiaryLabel',
  quaternaryLabel: 'quaternaryLabel',
  link: 'link',
  separator: 'separator',
  systemRed: 'systemRed',
  systemGreen: 'systemGreen',
  systemBlue: 'systemBlue',
} as const;

const LITERAL_COLORS = {
  brand: BRAND,
} as const;

export type SystemIconColor = keyof typeof TOKEN_COLORS | keyof typeof LITERAL_COLORS | string;
export type LucideIconName = keyof typeof LucideIcons;

type SystemIconProps = {
  name: string;
  mdName?: LucideIconName;
  size?: number;
  color?: SystemIconColor;
};

function resolveColor(color?: SystemIconColor): ColorValue | undefined {
  if (!color) return undefined;
  if (color in TOKEN_COLORS) return iosColor(TOKEN_COLORS[color as keyof typeof TOKEN_COLORS]);
  if (color in LITERAL_COLORS) return LITERAL_COLORS[color as keyof typeof LITERAL_COLORS];
  return color;
}

export function SystemIcon({ name, mdName, size = 18, color = 'label' }: SystemIconProps) {
  const tint = resolveColor(color);

  if (IS_IOS) {
    return (
      <Image
        source={`sf:${name}`}
        style={{ width: size, height: size }}
        tintColor={tint as string | undefined}
      />
    );
  }

  return <AndroidSystemIcon name={name} mdName={mdName} size={size} color={color} />;
}

export function AndroidSystemIcon({ name, mdName, size = 18, color = 'label' }: SystemIconProps) {
  const tint = resolveColor(color);
  const { i18n } = useTranslation();
  // RN caches I18nManager.isRTL for the lifetime of the JS runtime. Android can
  // recreate its activity for an app-language change while retaining that runtime.
  const language = i18n.resolvedLanguage || i18n.language;
  const rtl = language ? i18n.dir(language) === 'rtl' : I18nManager.isRTL;

  if (!mdName) {
    if (__DEV__) console.warn(`SystemIcon "${name}" missing mdName for Android fallback.`);
    return null;
  }

  const directionalIcons: Partial<Record<LucideIconName, LucideIconName>> = {
    ArrowLeft: 'ArrowRight',
    ArrowRight: 'ArrowLeft',
    ChevronLeft: 'ChevronRight',
    ChevronRight: 'ChevronLeft',
  };
  const icon = rtl ? (directionalIcons[mdName] ?? mdName) : mdName;
  const LucideIcon = LucideIcons[icon] as React.ComponentType<{
    size?: number;
    color?: string;
  }>;
  return <LucideIcon size={size} color={(tint as string | undefined) ?? '#000'} />;
}
