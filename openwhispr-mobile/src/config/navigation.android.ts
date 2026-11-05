const upstream: typeof import('./navigation') = require('./navigation.ts');

export const { customHeaderStackOptions } = upstream;

// Android needs an opaque native header to reserve space above the scroll view.
export const glassStackOptions = {
  ...upstream.glassStackOptions,
  headerTransparent: false,
  headerLargeTitle: false,
};
