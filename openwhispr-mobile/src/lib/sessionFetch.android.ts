import { fetch } from 'expo/fetch';

// Prevent Android's shared native cookie jar from replacing the explicit account cookie.
export const sessionFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, credentials: 'omit' });
