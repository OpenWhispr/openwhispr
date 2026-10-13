import React from 'react';
import { Pressable, ActivityIndicator, type ViewStyle } from 'react-native';
import { Text } from '@/components/ui/Text';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
import { GradientGlassSurface } from './GradientGlassSurface';

const buttonVariants = cva(
  'flex flex-row items-center justify-center rounded-full font-medium transition-all active:opacity-80',
  {
    variants: {
      variant: {
        default: 'bg-primary',
        destructive: 'bg-destructive',
        outline: 'border-2 border-border bg-transparent',
        secondary: 'bg-secondary',
        ghost: 'bg-transparent',
        link: 'bg-transparent underline-offset-4',
      },
      size: {
        default: 'h-12 px-6 py-3',
        sm: 'h-10 px-4 py-2',
        lg: 'h-14 px-8 py-4',
        icon: 'h-12 w-12',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

const textVariants = cva('font-medium text-center', {
  variants: {
    variant: {
      default: 'text-primary-foreground',
      destructive: 'text-destructive-foreground',
      outline: 'text-foreground',
      secondary: 'text-secondary-foreground',
      ghost: 'text-foreground',
      link: 'text-primary underline',
    },
    size: {
      default: 'text-base',
      sm: 'text-sm',
      lg: 'text-lg',
      icon: 'text-base',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
});

// Soft drop shadow for the primary gradient pill, matching the keyboard
// extension's dictation button (Swift GradientView in KeyboardViewController).
// Lives on the Pressable (which keeps its opaque `bg-primary` layer) so the
// shadow takes the pill shape; the gradient surface clips itself on top.
const GRADIENT_SHADOW: ViewStyle = {
  shadowColor: '#000000',
  shadowOpacity: 0.18,
  shadowRadius: 6,
  shadowOffset: { width: 0, height: 3 },
  elevation: 4,
};

export interface ButtonProps
  extends VariantProps<typeof buttonVariants>,
    React.ComponentPropsWithoutRef<typeof Pressable> {
  loading?: boolean;
  children?: React.ReactNode;
  className?: string;
}

export function Button({
  className,
  variant,
  size,
  loading,
  disabled,
  children,
  style,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const isGradient = (variant ?? 'default') === 'default';

  return (
    <Pressable
      className={cn(buttonVariants({ variant, size, className }), isDisabled && 'opacity-50')}
      disabled={isDisabled}
      style={
        typeof style === 'function'
          ? (state) => [isGradient && GRADIENT_SHADOW, style(state)]
          : [isGradient && GRADIENT_SHADOW, style]
      }
      {...props}
    >
      {isGradient ? <GradientGlassSurface /> : null}
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'outline' || variant === 'ghost' ? '#000' : '#fff'}
        />
      ) : (
        <Text className={cn(textVariants({ variant, size }))}>{children}</Text>
      )}
    </Pressable>
  );
}
