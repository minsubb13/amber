// Lint for the TypeScript sources (src/) and the development tools (tools/).
// plugin/ holds generated output and the legacy CommonJS tests, so it is
// not linted here.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['build/', 'node_modules/', 'plugin/', 'eslint.config.mjs'] },
  {
    files: ['src/**/*.ts', 'src/**/*.cts', 'src/**/*.mts', 'tools/**/*.mts', 'tools/**/*.cts'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // CommonJS sources (.cts) import with `import x = require(...)`, the
      // only form verbatimModuleSyntax accepts there; bare require() stays
      // forbidden.
      '@typescript-eslint/no-require-imports': ['error', { allowAsImport: true }],
    },
  },
  {
    // The plugin is a set of short synchronous programs: the reference code
    // uses no asynchronous I/O, promises, timers or signal handlers (only the
    // hook reads stdin through stream events). Keeping the port that way
    // keeps output order tied to the writes it reports and leaves no signal
    // handling to compare, which the parity capture cannot observe.
    files: ['src/**/*.ts', 'src/**/*.cts', 'src/**/*.mts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: ['fs/promises', 'node:fs/promises'], patterns: ['*/promises'] },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: ':function[async=true]', message: 'Plugin code stays synchronous.' },
        { selector: 'AwaitExpression', message: 'Plugin code stays synchronous.' },
        { selector: "MemberExpression[property.name='then']", message: 'Plugin code stays synchronous.' },
        { selector: "MemberExpression[object.name='fs'][property.name='promises']", message: 'Use synchronous fs.' },
        {
          selector:
            "CallExpression[callee.object.name='fs'][callee.property.name=/^(access|appendFile|chmod|close|copyFile|mkdir|open|read|readdir|readFile|rename|rm|rmdir|stat|unlink|write|writeFile)$/]",
          message: 'Use the synchronous fs API.',
        },
        {
          selector: "CallExpression[callee.name=/^(setTimeout|setInterval|setImmediate|queueMicrotask)$/]",
          message: 'Plugin code stays synchronous.',
        },
        {
          selector:
            "CallExpression[callee.object.name='process'][callee.property.name=/^(on|once|addListener|prependListener|prependOnceListener)$/][arguments.0.value=/^SIG/]",
          message: 'Plugin code installs no signal handlers.',
        },
      ],
    },
  },
);
