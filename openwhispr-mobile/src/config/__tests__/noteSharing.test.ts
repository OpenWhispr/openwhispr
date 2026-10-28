import { getNoteShareViewerBaseUrl } from '../noteSharing';
import { buildNoteShareUrl } from '@/lib/notes/noteShareTokens';

const token = `ow_share_${'a'.repeat(32)}`;
const originalApiUrl = process.env.EXPO_PUBLIC_API_URL;
const originalNotesUrl = process.env.EXPO_PUBLIC_NOTES_URL;

afterEach(() => {
  if (originalApiUrl === undefined) delete process.env.EXPO_PUBLIC_API_URL;
  else process.env.EXPO_PUBLIC_API_URL = originalApiUrl;
  if (originalNotesUrl === undefined) delete process.env.EXPO_PUBLIC_NOTES_URL;
  else process.env.EXPO_PUBLIC_NOTES_URL = originalNotesUrl;
});

it('uses the hosted viewer only with the hosted API', () => {
  delete process.env.EXPO_PUBLIC_API_URL;
  delete process.env.EXPO_PUBLIC_NOTES_URL;
  expect(getNoteShareViewerBaseUrl()).toBe('https://notes.openwhispr.com');
  expect(buildNoteShareUrl(token)).toBe(`https://notes.openwhispr.com/n/${token}`);
});

it('requires a paired viewer for a custom API', () => {
  process.env.EXPO_PUBLIC_API_URL = 'https://staging.example.com';
  delete process.env.EXPO_PUBLIC_NOTES_URL;
  expect(() => buildNoteShareUrl(token)).toThrow();
  process.env.EXPO_PUBLIC_NOTES_URL = 'https://notes.staging.example.com/';
  expect(buildNoteShareUrl(token)).toBe(`https://notes.staging.example.com/n/${token}`);
});

it.each([
  'http://notes.example.com',
  'https://user:password@notes.example.com',
  'https://notes.example.com?query=1',
  'https://notes.example.com/#fragment',
])('rejects unsafe viewer base %s', (url) => {
  process.env.EXPO_PUBLIC_NOTES_URL = url;
  expect(() => getNoteShareViewerBaseUrl()).toThrow();
});

it('accepts loopback HTTP for local development', () => {
  process.env.EXPO_PUBLIC_API_URL = 'http://localhost:3000';
  process.env.EXPO_PUBLIC_NOTES_URL = 'http://127.0.0.1:3001';
  expect(buildNoteShareUrl(token)).toBe(`http://127.0.0.1:3001/n/${token}`);
});
