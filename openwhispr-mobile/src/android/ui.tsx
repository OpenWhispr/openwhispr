import React from 'react';
import {
  View,
  Pressable,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { OpenWhisprMark } from '@/android/shared/components/ui/OpenWhisprMark';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { makeStyles, useTheme, type AndroidTheme } from './ThemeProvider';

/** The older Android pages' palette (Models, Permissions, Assistant, meeting setup), per scheme. */
function uiPalette({ scheme, tokens: k }: AndroidTheme) {
  return {
    background: k.canvas,
    ink: k.ink,
    muted: k.secondary,
    blue: k.accent,
    soft: scheme === 'dark' ? k.accentSoft : '#EEF2FC',
    line: k.track,
    white: k.surface,
    /** Words on the blue button. */
    onBlue: k.onGlass,
    /** The blue button: the accent in light, the brand glass's blue in dark (white reads on it). */
    button: scheme === 'dark' ? k.glassBottom : k.accent,
  };
}

const palettes: Partial<Record<AndroidTheme['scheme'], ReturnType<typeof uiPalette>>> = {};

/** The palette for the scheme in use. Read it at render; a switch repaints in place. */
export function useUiPalette() {
  const theme = useTheme();
  return (palettes[theme.scheme] ??= uiPalette(theme));
}

/** The shared page styles for the scheme in use. */
export const useUiStyles = makeStyles((theme) => {
  const palette = uiPalette(theme);
  return {
    page: { flex: 1, backgroundColor: palette.background },
    content: {
      padding: 20,
      gap: 24,
      paddingBottom: 36,
      width: '100%',
      maxWidth: 680,
      alignSelf: 'center',
    },
    title: {
      fontSize: 32,
      lineHeight: 39,
      fontWeight: '600',
      color: palette.ink,
      letterSpacing: -0.8,
    },
    heading: {
      fontSize: 21,
      lineHeight: 28,
      fontWeight: '600',
      color: palette.ink,
      letterSpacing: -0.5,
    },
    body: { fontSize: 16, lineHeight: 24, color: palette.muted },
    caption: { fontSize: 13, lineHeight: 19, color: palette.muted },
    card: {
      backgroundColor: palette.white,
      padding: 20,
      borderRadius: 20,
      gap: 12,
      borderWidth: 1,
      borderColor: palette.line,
    },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    button: {
      minHeight: 54,
      borderRadius: 28,
      backgroundColor: palette.button,
      paddingHorizontal: 22,
      paddingVertical: 15,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonText: { color: palette.onBlue, fontWeight: '600', fontSize: 16 },
    input: {
      borderRadius: 18,
      padding: 16,
      backgroundColor: palette.white,
      borderWidth: 1,
      borderColor: palette.line,
      color: palette.ink,
      fontSize: 17,
      minHeight: 56,
    },
    pill: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderRadius: 24,
      backgroundColor: palette.white,
      borderWidth: 1,
      borderColor: palette.line,
    },
  } as const;
});
export function Button({
  label,
  onPress,
  secondary,
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  busy?: boolean;
}) {
  const styles = useUiStyles();
  const palette = useUiPalette();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && { backgroundColor: palette.soft },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.75 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={secondary ? palette.blue : palette.onBlue} />
      ) : (
        <Text style={[styles.buttonText, secondary && { color: palette.ink }]}>{label}</Text>
      )}
    </Pressable>
  );
}
export function Page({
  title,
  children,
  back = false,
  showAccount = true,
  footer,
  scrollRef,
}: {
  title: string;
  children: React.ReactNode;
  back?: boolean;
  showAccount?: boolean;
  footer?: React.ReactNode;
  /** A tab's first screen passes one so tapping its tab again scrolls it to the top. */
  scrollRef?: React.Ref<ScrollView>;
}) {
  const { t } = useTranslation();
  const styles = useUiStyles();
  const palette = useUiPalette();
  return (
    <SafeAreaView style={styles.page} edges={['top', 'left', 'right']}>
      <View style={[styles.row, { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 }]}>
        {back ? (
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityLabel={t('back')}
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace('/(tabs)/(record)')
            }
            style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
          >
            <SystemIcon name="chevron.left" mdName="ArrowLeft" size={22} color={palette.ink} />
          </Pressable>
        ) : (
          <OpenWhisprMark size={30} color={palette.blue} />
        )}
        <Text
          accessibilityRole="header"
          style={{ fontSize: 18, fontWeight: '600', flex: 1, color: palette.ink }}
        >
          {title}
        </Text>
        {!back && showAccount && <AccountButton />}
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="height">
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {children}
        </ScrollView>
        {footer && (
          <SafeAreaView
            edges={['bottom']}
            style={{ paddingHorizontal: 24, paddingTop: 12, backgroundColor: palette.background }}
          >
            {footer}
          </SafeAreaView>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
export function AccountButton() {
  const { t } = useTranslation();
  const palette = useUiPalette();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={t('account')}
      onPress={() => router.push('/(account)')}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: palette.soft,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <SystemIcon name="person.crop.circle" mdName="UserRound" size={21} color={palette.blue} />
    </Pressable>
  );
}
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useUiStyles();
  return (
    <View style={{ gap: 8 }}>
      <Text
        accessibilityRole="header"
        style={[styles.caption, { paddingHorizontal: 4, fontWeight: '600' }]}
      >
        {title}
      </Text>
      <Card style={{ gap: 0, paddingVertical: 4 }}>{children}</Card>
    </View>
  );
}
export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const styles = useUiStyles();
  return <View style={[styles.card, style]}>{children}</View>;
}
export function Row({
  title,
  detail,
  onPress,
  icon,
  disabled = false,
}: {
  title: string;
  detail?: string;
  onPress: () => void;
  icon?: LucideIconName;
  disabled?: boolean;
}) {
  const styles = useUiStyles();
  const palette = useUiPalette();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { minHeight: 60, paddingVertical: 12, opacity: disabled ? 0.5 : pressed ? 0.6 : 1 },
      ]}
    >
      {icon && (
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            backgroundColor: palette.soft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <SystemIcon name="circle" mdName={icon} size={18} color={palette.blue} />
        </View>
      )}
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ fontSize: 17, color: palette.ink }}>{title}</Text>
        {detail && <Text style={styles.caption}>{detail}</Text>}
      </View>
      <SystemIcon name="chevron.right" mdName="ChevronRight" size={17} color={palette.muted} />
    </Pressable>
  );
}
