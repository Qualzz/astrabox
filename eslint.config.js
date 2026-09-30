import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.arcade/**', 'output/**', 'art/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-args': 'error',
      'no-dupe-keys': 'error', 'no-duplicate-case': 'error', 'valid-typeof': 'error',
    },
  },
  { files: ['src/**/*.js', 'cartridges/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['server/**/*.js', 'scripts/**/*.mjs', 'deploy/**/*.mjs', 'eslint.config.js'], languageOptions: { globals: globals.node } },
  { files: ['tests/**/*.js'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
];
