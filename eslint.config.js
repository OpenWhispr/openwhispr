const js = require("@eslint/js");
const globals = require("globals");
const tseslint = require("typescript-eslint");

module.exports = [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src/dist/**",
      "*.min.js",
      "build/**",
      "openwhispr-mobile/**", // mobile has its own ESLint configuration
      "src/**", // src has its own config
    ],
  },
  {
    files: ["shared/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      sourceType: "module",
      ecmaVersion: "latest",
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      ...tseslint.plugin.configs.recommended.rules,
      "@typescript-eslint/explicit-function-return-type": "error",
    },
  },
  // Main process files (CommonJS)
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Relaxed rules - catch syntax errors but don't be too strict
      "no-unused-vars": [
        "warn",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_|^event|^err|^error" },
      ],
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-control-regex": "off",
      "no-useless-catch": "off",
      "no-async-promise-executor": "off",
      "prefer-const": "off",
      "no-var": "off",
    },
  },
];
