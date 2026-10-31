import React from 'react';
import {
  View,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { OpenWhisprMark } from '@/components/ui/OpenWhisprMark';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';

export const palette = {
  background: '#F8F6F5',
  ink: '#21212B',
  muted: '#66636E',
  blue: '#2457C5',
  soft: '#EEF2FC',
  line: '#E6E1DE',
  white: '#FFFFFF',
};
export const styles = StyleSheet.create({
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
    backgroundColor: palette.blue,
    paddingHorizontal: 22,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: 'white', fontWeight: '600', fontSize: 16 },
  input: {
    borderRadius: 18,
    padding: 16,
    backgroundColor: 'white',
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
        <ActivityIndicator color={secondary ? palette.blue : 'white'} />
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
}: {
  title: string;
  children: React.ReactNode;
  back?: boolean;
  showAccount?: boolean;
  footer?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <SafeAreaView style={styles.page} edges={['top', 'left', 'right']}>
      <View style={[styles.row, { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 }]}>
        {back ? (
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityLabel={t('back')}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
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
