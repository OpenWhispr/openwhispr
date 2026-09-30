import React from 'react';
import { View, type ViewProps, type StyleProp, type ViewStyle } from 'react-native';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { BlurView, type BlurTint } from 'expo-blur';
import { cn } from '@/lib/utils';

const LIQUID_GLASS = isLiquidGlassAvailable();

type GlassProps = ViewProps & {
  className?: string;
  tint?: BlurTint;
  intensity?: number;
  interactive?: boolean;
  children?: React.ReactNode;
};

function GlassImpl({
  className,
  style,
  tint = 'systemMaterial',
  intensity = 80,
  interactive,
  children,
  ...rest
}: GlassProps) {
  if (LIQUID_GLASS) {
    return (
      <GlassView
        style={style as StyleProp<ViewStyle>}
        className={cn(className)}
        isInteractive={interactive}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View style={[{ overflow: 'hidden' }, style]} className={cn(className)} {...rest}>
      <BlurView tint={tint} intensity={intensity} style={{ flex: 1 }}>
        {children}
      </BlurView>
    </View>
  );
}

export function Glass(props: GlassProps) {
  return <GlassImpl {...props} />;
}

Glass.Interactive = function GlassInteractive(props: GlassProps) {
  return <GlassImpl {...props} interactive />;
};
