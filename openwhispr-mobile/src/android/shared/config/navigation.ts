const upstream: typeof import('@/android/shared/config/navigationBase') = require('@/android/shared/config/navigationBase');

export const { customHeaderStackOptions } = upstream;

// Android needs an opaque native header to reserve space above the scroll view.
export const glassStackOptions = {
  ...upstream.glassStackOptions,
  headerTransparent: false,
  headerLargeTitle: false,
};
