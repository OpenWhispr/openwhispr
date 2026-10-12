const { FlatCompat } = require('@eslint/eslintrc');

const compat = new FlatCompat({ baseDirectory: __dirname });

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'build/**'],
  },
  ...compat.extends('@react-native', 'prettier'),
  {
    rules: {
      'react-native/no-inline-styles': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'eslint-comments/no-unused-disable': 'off',
      'react/react-in-jsx-scope': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
];
