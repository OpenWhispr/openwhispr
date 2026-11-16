import { buildApiUrl, isSecureHttpEndpoint, normalizeBaseUrl } from '../providerEndpoints';

it('allows plain HTTP only for private-network hosts', () => {
  expect(isSecureHttpEndpoint('https://server.example/v1')).toBe(true);
  expect(isSecureHttpEndpoint('http://10.0.0.2:8000/v1')).toBe(true);
  expect(isSecureHttpEndpoint('http://100.101.102.103/v1')).toBe(true);
  expect(isSecureHttpEndpoint('http://box.tailnet.ts.net/v1')).toBe(true);
  expect(isSecureHttpEndpoint('http://[fd00::1]:8000/v1')).toBe(true);
  expect(isSecureHttpEndpoint('http://10.example.com/v1')).toBe(false);
  expect(isSecureHttpEndpoint('http://server.example/v1')).toBe(false);
  expect(isSecureHttpEndpoint('not a url')).toBe(false);
});

it('normalizes pasted endpoint URLs to their API base', () => {
  expect(normalizeBaseUrl(' https://server.example/v1/chat/completions ')).toBe(
    'https://server.example/v1',
  );
  expect(normalizeBaseUrl('https://server.example/v1/audio/transcriptions')).toBe(
    'https://server.example/v1',
  );
  expect(normalizeBaseUrl('https://server.example/v1/')).toBe('https://server.example/v1');
  expect(buildApiUrl('https://server.example/v1/', 'models')).toBe(
    'https://server.example/v1/models',
  );
});
