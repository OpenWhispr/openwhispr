import React from 'react';
import { TextInput, TextInputProps, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SpaceGrotesk } from '@/lib/fonts';
import { cn } from '../../lib/utils';

export interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  containerClassName?: string;
}

export const Input = React.forwardRef<TextInput, InputProps>(
  ({ className, label, error, containerClassName, style, ...props }, ref) => {
    return (
      <View className={cn('flex flex-col space-y-2', containerClassName)}>
        {label && <Text className="text-sm font-medium leading-none text-foreground">{label}</Text>}
        <TextInput
          ref={ref}
          className={cn(
            'h-12 rounded-lg border border-border bg-background px-4 py-3 text-base text-foreground placeholder:text-muted-foreground',
            error && 'border-destructive',
            className,
          )}
          placeholderTextColor="#9CA3AF"
          style={[{ fontFamily: SpaceGrotesk.regular }, style]}
          {...props}
        />
        {error && <Text className="text-sm text-destructive">{error}</Text>}
      </View>
    );
  },
);

Input.displayName = 'Input';
