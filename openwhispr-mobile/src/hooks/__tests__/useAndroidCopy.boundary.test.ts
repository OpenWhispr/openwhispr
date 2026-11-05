import { renderHook } from '@testing-library/react-native';

// iOS must be able to load shared copy consumers without the Android translation runtime.
jest.mock('react-i18next', () => {
  throw new Error('Android translation runtime reached the default copy hook');
});

it('renders stable fallback text without loading the Android translation runtime', () => {
  const { useAndroidCopy } =
    jest.requireActual<typeof import('../useAndroidCopy')>('../useAndroidCopy');
  const { result, rerender } = renderHook(() => useAndroidCopy());
  const copy = result.current.copy;
  expect(copy('library.today', 'Today')).toBe('Today');
  expect(copy('missing', 'Literal {{name}} & <text>', { name: 'Different' })).toBe(
    'Literal {{name}} & <text>',
  );
  expect(copy('missing', '', { defaultValue: 'Other fallback' })).toBe('');
  expect(result.current.language).toBe('en');
  rerender({});
  expect(result.current.copy).toBe(copy);
});
