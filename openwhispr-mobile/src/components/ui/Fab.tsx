import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useIsFocused } from '@react-navigation/native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { GlassContainer } from 'expo-glass-effect';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { GradientGlassSurface } from '@/components/ui/GradientGlassSurface';
import { Glass } from '@/components/ui/Glass';
import { safeHaptics } from '@/lib/utils';

const BRAND = '#007AFF';

const SIZE = 56;
const MINI_SIZE = 44;
const MINI_ICON_SIZE = 22;
const MINI_GAP = 12;
const TAB_BAR_OFFSET = Platform.OS === 'ios' ? 110 : 70;
const BOTTOM = TAB_BAR_OFFSET + 32;
const FAB_RIGHT = 20;
const MINI_RIGHT = FAB_RIGHT + (SIZE - MINI_SIZE) / 2;
const STAGGER = 0.18;

export const FAB_BOTTOM_PADDING = BOTTOM + SIZE + 16;

export type FabAction = {
  id: string;
  label: string;
  icon: string;
  mdIcon: LucideIconName;
};

type FabProps = {
  icon: string;
  mdIcon: LucideIconName;
  accessibilityLabel: string;
  onPress?: () => void;
  actions?: FabAction[];
  onActionPress?: (id: string) => void;
};

export function Fab({
  icon,
  mdIcon,
  accessibilityLabel,
  onPress,
  actions,
  onActionPress,
}: FabProps) {
  const isFocused = useIsFocused();
  const hasMenu = (actions?.length ?? 0) > 0;
  const [open, setOpen] = useState(false);
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(open ? 1 : 0, {
      duration: open ? 220 : 160,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
    });
  }, [open, progress]);

  const handleFabPress = () => {
    safeHaptics('light');
    if (hasMenu) {
      setOpen((prev) => !prev);
    } else {
      onPress?.();
    }
  };

  const handleActionPress = (id: string) => {
    safeHaptics('selection');
    setOpen(false);
    onActionPress?.(id);
  };

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${progress.value * 45}deg` }],
  }));

  if (!isFocused) {
    return null;
  }

  return (
    <>
      {open && (
        <Pressable
          onPress={() => setOpen(false)}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.001)',
            zIndex: 9000,
          }}
        />
      )}

      {open && (
        <GlassContainer
          pointerEvents="box-none"
          style={[StyleSheet.absoluteFill, styles.menuLayer]}
        >
          {actions?.map((action, index) => (
            <MiniAction
              key={action.id}
              action={action}
              index={index}
              progress={progress}
              onPress={() => handleActionPress(action.id)}
            />
          ))}
        </GlassContainer>
      )}

      <View
        style={{
          position: 'absolute',
          right: FAB_RIGHT,
          bottom: BOTTOM,
          width: SIZE,
          height: SIZE,
          borderRadius: SIZE / 2,
          backgroundColor: BRAND,
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.28,
          shadowRadius: 10,
          elevation: 9999,
          zIndex: 9999,
        }}
      >
        <GradientGlassSurface shape="circle" />
        <Pressable
          onPress={handleFabPress}
          accessibilityRole="button"
          accessibilityLabel={hasMenu && open ? 'Close menu' : accessibilityLabel}
          accessibilityState={hasMenu ? { expanded: open } : undefined}
          style={({ pressed }) => ({
            width: '100%',
            height: '100%',
            borderRadius: SIZE / 2,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Animated.View style={iconStyle}>
            <BrandDiscMark icon={icon} mdIcon={mdIcon} />
          </Animated.View>
        </Pressable>
      </View>
    </>
  );
}

function BrandDiscMark({ icon, mdIcon }: { icon: string; mdIcon: LucideIconName }) {
  if (icon !== 'plus') {
    return <SystemIcon name={icon} mdName={mdIcon} size={24} color="#FFF" />;
  }

  return (
    <View pointerEvents="none" style={styles.plusMark}>
      <View style={[styles.plusStroke, styles.plusHorizontal]} />
      <View style={[styles.plusStroke, styles.plusVertical]} />
    </View>
  );
}

type MiniActionProps = {
  action: FabAction;
  index: number;
  progress: SharedValue<number>;
  onPress: () => void;
};

function MiniAction({ action, index, progress, onPress }: MiniActionProps) {
  const start = index * STAGGER;
  const span = Math.max(1 - start, 0.0001);
  const bottom = BOTTOM + SIZE + 16 + index * (MINI_SIZE + MINI_GAP);

  const containerStyle = useAnimatedStyle(() => {
    const local = Math.max(0, Math.min(1, (progress.value - start) / span));
    return {
      opacity: local,
      transform: [{ translateY: (1 - local) * 14 }],
    };
  });

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        {
          position: 'absolute',
          right: MINI_RIGHT,
          bottom,
          flexDirection: 'row',
          alignItems: 'center',
          zIndex: 9500,
        },
        containerStyle,
      ]}
    >
      <Pressable
        onPress={onPress}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={action.label}
        style={({ pressed }) => [styles.miniActionButton, { opacity: pressed ? 0.82 : 1 }]}
      >
        <View pointerEvents="none" style={styles.miniActionBase} />
        <Glass.Interactive
          pointerEvents="none"
          tint="light"
          intensity={72}
          style={styles.miniActionGlass}
        >
          <View pointerEvents="none" style={styles.miniActionContent}>
            <Text numberOfLines={1} className="text-[13px] font-semibold text-label">
              {action.label}
            </Text>
            <View style={styles.miniIconSlot}>
              <SystemIcon
                name={action.icon}
                mdName={action.mdIcon}
                size={MINI_ICON_SIZE}
                color="brand"
              />
            </View>
          </View>
        </Glass.Interactive>
        <View pointerEvents="none" style={styles.miniActionHighlight} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  menuLayer: {
    zIndex: 9500,
  },
  miniActionButton: {
    position: 'relative',
    height: MINI_SIZE,
    borderRadius: MINI_SIZE / 2,
    backgroundColor: 'rgba(248,248,250,0.94)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 7,
  },
  miniActionBase: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: MINI_SIZE / 2,
    backgroundColor: 'rgba(248,248,250,0.94)',
  },
  miniActionGlass: {
    height: MINI_SIZE,
    borderRadius: MINI_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.42)',
    overflow: 'hidden',
  },
  miniActionHighlight: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: MINI_SIZE / 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(60,60,67,0.14)',
  },
  miniActionContent: {
    height: MINI_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 14,
  },
  miniIconSlot: {
    width: MINI_SIZE,
    height: MINI_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusMark: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusStroke: {
    position: 'absolute',
    borderRadius: 2,
    backgroundColor: '#FFF',
  },
  plusHorizontal: {
    width: 22,
    height: 2.5,
  },
  plusVertical: {
    width: 2.5,
    height: 22,
  },
});
