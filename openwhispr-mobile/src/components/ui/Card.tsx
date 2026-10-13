import React from 'react';
import { View, ViewProps } from 'react-native';
import { cn } from '../../lib/utils';

export interface CardProps extends ViewProps {
  children: React.ReactNode;
}

export function Card({ className, children, ...props }: CardProps) {
  return (
    <View className={cn('rounded-lg bg-card p-4 shadow-sm', className)} {...props}>
      {children}
    </View>
  );
}

export function CardHeader({ className, children, ...props }: CardProps) {
  return (
    <View className={cn('flex flex-col space-y-1.5 pb-3', className)} {...props}>
      {children}
    </View>
  );
}

export function CardTitle({ className, children, ...props }: CardProps) {
  return (
    <View className={cn('text-xl font-semibold leading-none tracking-tight', className)} {...props}>
      {children}
    </View>
  );
}

export function CardDescription({ className, children, ...props }: CardProps) {
  return (
    <View className={cn('text-sm text-muted-foreground', className)} {...props}>
      {children}
    </View>
  );
}

export function CardContent({ className, children, ...props }: CardProps) {
  return (
    <View className={cn('pt-0', className)} {...props}>
      {children}
    </View>
  );
}

export function CardFooter({ className, children, ...props }: CardProps) {
  return (
    <View className={cn('flex flex-row items-center pt-3', className)} {...props}>
      {children}
    </View>
  );
}
