import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as Haptics from 'expo-haptics';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function formatRelativeTime(
  timestamp: number | string,
  mode: 'short' | 'long' = 'long',
): string {
  const date =
    typeof timestamp === 'string'
      ? new Date(timestamp.endsWith('Z') ? timestamp : timestamp + 'Z')
      : new Date(timestamp);
  if (isNaN(date.getTime())) return '';

  if (mode === 'short') {
    const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
    if (days === 0)
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (days === 1) return 'Yesterday';
    if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

type HapticType = 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error';

export function safeHaptics(type: HapticType): void {
  try {
    switch (type) {
      case 'light':
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        return;
      case 'medium':
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        return;
      case 'heavy':
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        return;
      case 'selection':
        Haptics.selectionAsync();
        return;
      case 'success':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return;
      case 'warning':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      case 'error':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
    }
  } catch {}
}

export function formatLargeNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function makeContentHash(content: string): string {
  return String(content.length) + '-' + content.slice(0, 50);
}
