import {
  snapshotKeyboardInferenceRoute,
  readKeyboardInferenceRoute,
  readKeyboardProviderResult,
  listPendingProviderRecoveryJobs,
  clearKeyboardProviderRecovery,
} from '../keyboardInferenceRoute';
import { AppGroupStorage } from '../../../modules/app-group-storage/src';
const mockJobIds: string[] = [];
jest.mock('../../../modules/background-uploader/src', () => ({
  BackgroundUploader: {
    listProviderRecoveryJobIds: () => mockJobIds,
    clearProviderRecovery: jest.fn(() => false),
  },
}));
const mockStorage = new Map<string, string>();
const mockRoute = {
  provider: 'byok',
  cleanupUnavailable: 'Cleanup is unavailable. Your raw transcript is saved.',
  agentUnavailable: 'Agent is unavailable. Your raw transcript is saved.',
  inferenceRoute: {
    mode: 'providers',
    scope: 'dictation',
    providerId: 'groq',
    modelId: 'whisper-large-v3-turbo',
    endpoint: 'https://api.groq.com/openai/v1',
    credentialRef: 'provider.groq',
  },
};
jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    getItem: (key: string) => mockStorage.get(key) ?? null,
    removeItem: (key: string) => mockStorage.delete(key),
    setItem: (key: string, value: string) => mockStorage.set(key, value),
  },
}));
jest.mock('../inferenceRouting', () => ({ snapshotTranscriptionJob: () => mockRoute }));
beforeEach(() => {
  mockStorage.clear();
  mockJobIds.length = 0;
});
it('persists a versioned route and only returns it for the original job', () => {
  snapshotKeyboardInferenceRoute('one');
  expect(readKeyboardInferenceRoute('one')).toEqual(mockRoute);
  expect(readKeyboardInferenceRoute('two')).toBeUndefined();
  expect(JSON.parse(mockStorage.get('keyboard_inference_route')!)).toMatchObject({
    version: 1,
    jobId: 'one',
  });
});
it('does not reinterpret corrupted metadata as a Cloud route', () => {
  mockStorage.set('keyboard_inference_route', '{invalid');
  expect(() => readKeyboardInferenceRoute('one')).toThrow('route');
});

it('recovers the original per-job route when the latest recording changed', () => {
  mockStorage.set(
    'keyboard_inference_route',
    JSON.stringify({ version: 1, jobId: 'new', route: { provider: 'cloud' } }),
  );
  mockStorage.set(
    'keyboard_upload_route.old',
    JSON.stringify({ version: 1, jobId: 'old', route: mockRoute }),
  );
  expect(readKeyboardInferenceRoute('old')).toEqual(mockRoute);
});
it('recovers a completed provider response with its original route only', () => {
  mockStorage.set(
    'keyboard_provider_result.old',
    JSON.stringify({ version: 1, jobId: 'old', text: 'raw original words', route: mockRoute }),
  );
  expect(readKeyboardProviderResult('old')).toEqual({
    text: 'raw original words',
    route: mockRoute,
  });
  expect(readKeyboardProviderResult('new')).toBeUndefined();
});
it('rejects a completed provider response with mismatched job metadata', () => {
  mockStorage.set(
    'keyboard_provider_result.old',
    JSON.stringify({ version: 1, jobId: 'new', text: 'wrong words', route: mockRoute }),
  );
  expect(() => readKeyboardProviderResult('old')).toThrow('route');
});

it('enumerates older pending jobs independently, including upload context and corrupted entries', () => {
  mockJobIds.push('old', 'upload', 'broken');
  mockStorage.set(
    'keyboard_upload_route.old',
    JSON.stringify({ version: 1, jobId: 'old', route: mockRoute }),
  );
  mockStorage.set('keyboard_upload_audio.old', 'file:///old.wav');
  const uploadRoute = {
    ...mockRoute,
    inferenceRoute: { ...mockRoute.inferenceRoute, scope: 'upload' },
  };
  mockStorage.set(
    'keyboard_provider_result.upload',
    JSON.stringify({
      version: 1,
      jobId: 'upload',
      requestContext: 'file',
      text: 'older upload',
      route: uploadRoute,
    }),
  );
  mockStorage.set('keyboard_upload_audio.upload', 'file:///upload.wav');
  mockStorage.set('keyboard_upload_route.broken', '{bad');
  mockStorage.set('keyboard_upload_audio.broken', 'file:///broken.wav');
  const jobs = listPendingProviderRecoveryJobs();
  expect(jobs).toHaveLength(3);
  expect(jobs[0]).toMatchObject({
    jobId: 'old',
    audioUri: 'file:///old.wav',
    route: mockRoute,
    requestContext: 'keyboard',
  });
  expect(jobs[1]).toMatchObject({
    jobId: 'upload',
    requestContext: 'file',
    result: { text: 'older upload', route: uploadRoute },
  });
  expect(jobs[2]).toMatchObject({
    jobId: 'broken',
    audioUri: 'file:///broken.wav',
    error: expect.any(String),
  });
  expect(mockStorage.has('keyboard_upload_audio.old')).toBe(true);
});
it('includes a legacy active job and clears only the durably handled job', () => {
  mockStorage.set('keyboard_recording_job_id', 'legacy');
  mockStorage.set('keyboard_upload_audio.legacy', 'file:///legacy.wav');
  mockStorage.set('keyboard_upload_audio.other', 'file:///other.wav');
  expect(listPendingProviderRecoveryJobs()).toEqual([
    expect.objectContaining({ jobId: 'legacy', audioUri: 'file:///legacy.wav' }),
  ]);
  clearKeyboardProviderRecovery('legacy');
  expect(mockStorage.has('keyboard_upload_audio.legacy')).toBe(false);
  expect(mockStorage.has('keyboard_upload_audio.other')).toBe(true);
});
it('refuses a stored route for a provider the mobile build no longer ships', () => {
  const route = {
    provider: 'byok',
    inferenceRoute: {
      mode: 'providers',
      scope: 'dictation',
      providerId: 'corti',
      modelId: 'corti-transcribe',
      endpoint: 'https://api.eu.corti.app/v2',
      credentialRef: 'provider.corti',
    },
  };
  AppGroupStorage.setItem(
    'keyboard_upload_route.corti',
    JSON.stringify({ version: 1, jobId: 'corti', route }),
  );
  expect(() => readKeyboardInferenceRoute('corti')).toThrow(
    'The original keyboard provider route is unavailable. Record again.',
  );
});
