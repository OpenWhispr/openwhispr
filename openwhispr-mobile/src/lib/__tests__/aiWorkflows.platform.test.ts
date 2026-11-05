import { Platform } from 'react-native';
import * as defaultWorkflows from '../aiWorkflows';
import * as androidWorkflows from '../aiWorkflows.android';
import { workflowModeRestrictions } from '../workflowModeRestrictions';
import { workflowModeRestrictions as androidRestrictions } from '../workflowModeRestrictions.android';

jest.mock('@/lib/inferenceModes', () => {
  const { Platform: runtimePlatform } = require('react-native') as typeof import('react-native');
  const defaults = jest.requireActual(
    '@/lib/inferenceModes',
  ) as typeof import('@/lib/inferenceModes');
  const android = jest.requireActual(
    '@/lib/inferenceModes.android',
  ) as typeof import('@/lib/inferenceModes.android');
  return new Proxy(defaults, {
    get: (_target, name) =>
      Reflect.get(runtimePlatform.OS === 'android' ? android : defaults, name),
  });
});

it.each(['ANDROID_LOCAL_MODE_LOCKED', 'PRIVATE_MODE_LOCKED_REASON', 'cleanupSavedOnDevice'])(
  'keeps the Android %s export out of the default workflow API',
  (name) => {
    expect(defaultWorkflows).not.toHaveProperty(name);
    expect(androidWorkflows).toHaveProperty(name);
  },
);

it('retains the default screen guidance without Android mode restrictions', () => {
  expect(workflowModeRestrictions).toEqual({
    lockedModes: {},
    lockedReason: 'Off while Local Mode is on. Change Dictation in AI Models to turn it off.',
  });
});

it('binds Android screen restrictions to the unchanged workflow values', () => {
  expect(androidRestrictions.lockedModes).toBe(androidWorkflows.ANDROID_LOCAL_MODE_LOCKED);
  expect(androidRestrictions.lockedReason).toBe(androidWorkflows.PRIVATE_MODE_LOCKED_REASON);
  expect(androidRestrictions.lockedModes).toEqual({
    dictation: ['openwhispr'],
    upload: ['openwhispr', 'providers'],
    cleanup: ['openwhispr'],
  });
});

it('uses Android inference defaults for an unset upload in Local Mode', () => {
  const original = Platform.OS;
  Platform.OS = 'android';
  try {
    expect(androidWorkflows.unsetSelection('upload', 'private', 'account')).toEqual({
      mode: 'local',
    });
  } finally {
    Platform.OS = original;
  }
});
