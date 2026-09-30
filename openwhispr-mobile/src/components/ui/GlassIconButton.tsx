import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Glass } from './Glass';

/** Default diameter of the circular glass capsule, shared by all header buttons. */
export const GLASS_CAPSULE_SIZE = 36;

type GlassCapsuleProps = {
  size?: number;
  children: React.ReactNode;
};

/**
 * The visual-only circular "liquid glass" capsule (no press handling). Use
 * directly when the press is owned by a parent (e.g. a `MenuView` trigger);
 * otherwise prefer `GlassIconButton`.
 */
export function GlassCapsule({ size = GLASS_CAPSULE_SIZE, children }: GlassCapsuleProps) {
  return (
    <Glass.Interactive style={{ width: size, height: size, borderRadius: size / 2 }}>
      <View style={styles.center}>{children}</View>
    </Glass.Interactive>
  );
}

type GlassIconButtonProps = {
  onPress: () => void;
  accessibilityLabel: string;
  size?: number;
  children: React.ReactNode;
};

/**
 * A pressable circular "liquid glass" capsule around an icon, mirroring the
 * native iOS 26 navigation-bar button treatment. Used for custom-header back
 * buttons so they match the native header on the note editor.
 */
export function GlassIconButton({
  onPress,
  accessibilityLabel,
  size = GLASS_CAPSULE_SIZE,
  children,
}: GlassIconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <GlassCapsule size={size}>{children}</GlassCapsule>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
