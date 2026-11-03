import { fetch } from 'expo/fetch';
import { Platform } from 'react-native';

/**
 * App API calls supply their session explicitly through the Cookie header.
 * Expo defaults to including Android's shared native cookie jar, which can
 * replace that header with a previous account's cookie or authenticate a
 * signed-out request. Disable the jar on Android; preserve iOS behavior.
 */
export const sessionFetch: typeof fetch = (input, init) =>
  fetch(input, Platform.OS === 'android' ? { ...init, credentials: 'omit' } : init);
