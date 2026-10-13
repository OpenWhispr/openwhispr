import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND_GRADIENT } from '@/config/colors';

type GradientGlassSurfaceProps = {
  /** Gradient stops rendered diagonally (top-left → bottom-right). Defaults to the brand blue gradient. */
  colors?: readonly [string, string, ...string[]];
  /** Render the glossy border highlight that sells the Apple-glass sheen. */
  sheen?: boolean;
  /** Circular buttons use a curved border treatment so the sheen does not read as a clipped edge. */
  shape?: 'default' | 'circle';
  /** Corner radius. Defaults to a pill/circle (clamped to half the smaller side). */
  radius?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * Absolute-fill background that layers the OpenWhispr blue gradient with a
 * glossy border highlight for an Apple "liquid glass" sheen. It self-clips to
 * a pill/circle, so place it inside a relatively-positioned, rounded parent that
 * carries a solid fallback background — the parent's opaque layer casts the
 * shadow and shows through if the gradient ever fails to load. Non-interactive:
 * touches pass through to the parent.
 */
export function GradientGlassSurface({
  colors = BRAND_GRADIENT,
  sheen = true,
  shape = 'default',
  radius = 9999,
  style,
}: GradientGlassSurfaceProps) {
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.clip, { borderRadius: radius }, style]}
    >
      <LinearGradient
        colors={colors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {sheen && shape === 'circle' ? (
        <View style={[StyleSheet.absoluteFill, styles.circleBorder, { borderRadius: radius }]} />
      ) : sheen ? (
        <>
          <View style={[StyleSheet.absoluteFill, styles.border, { borderRadius: radius }]} />
          <LinearGradient
            colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.72)', 'rgba(255,255,255,0)']}
            locations={[0, 0.48, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.topSheen}
          />
          <LinearGradient
            colors={['rgba(255,255,255,0.48)', 'rgba(255,255,255,0.08)', 'rgba(255,255,255,0)']}
            locations={[0, 0.58, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={styles.leftSheen}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  border: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  circleBorder: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.38)',
  },
  topSheen: {
    position: 'absolute',
    top: 0,
    left: 2,
    right: 2,
    height: 2,
  },
  leftSheen: {
    position: 'absolute',
    top: 3,
    left: 0,
    bottom: 3,
    width: 1.5,
  },
});
