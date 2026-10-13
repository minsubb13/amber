// Lint for the TypeScript sources (src/), the development tools (tools/) and
// the test suites (test/). plugin/ holds generated output, so it is not
// linted here.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Asynchronous Node APIs the plugin sources must not use (see the src/ block).
const ASYNC_FS = [
  'access', 'appendFile', 'chmod', 'chown', 'close', 'copyFile', 'cp', 'createReadStream',
  'createWriteStream', 'exists', 'fchmod', 'fchown', 'fdatasync', 'fstat', 'fsync', 'ftruncate',
  'futimes', 'lchown', 'link', 'lstat', 'lutimes', 'mkdir', 'mkdtemp', 'open', 'opendir', 'read',
  'readdir', 'readFile', 'readlink', 'readv', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'statfs',
  'symlink', 'truncate', 'unlink', 'utimes', 'watch', 'watchFile', 'write', 'writeFile', 'writev',
  'promises',
];
const ASYNC_CHILD_PROCESS = ['exec', 'execFile', 'fork', 'spawn'];
const TIMERS = ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'nextTick'];
const SYNC_ONLY = 'Plugin code stays synchronous.';
const names = (list) => `/^(${list.join('|')})$/`;

export default defineConfig(
  { ignores: ['build/', 'node_modules/', 'plugin/', 'eslint.config.mjs'] },
  {
    files: ['src/**/*.ts', 'src/**/*.cts', 'src/**/*.mts', 'tools/**/*.mts', 'tools/**/*.cts', 'test/**/*.mts'],
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
    // handling to compare, which the parity capture cannot observe. The
    // modules are bound under one name each (fs, childProcess) so that every
    // use goes through a member access these selectors see.
    files: ['src/**/*.ts', 'src/**/*.cts', 'src/**/*.mts'],
    rules: {
      // The typescript-eslint version also checks `import x = require(...)`.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            ...['fs/promises', 'timers', 'timers/promises', 'stream/promises'].flatMap((name) => [
              { name, message: SYNC_ONLY },
              { name: `node:${name}`, message: SYNC_ONLY },
            ]),
            ...['fs', 'node:fs'].map((name) => ({ name, importNames: ASYNC_FS, message: SYNC_ONLY })),
            ...['child_process', 'node:child_process'].map((name) => ({
              name,
              importNames: ASYNC_CHILD_PROCESS,
              message: SYNC_ONLY,
            })),
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: ':function[async=true]', message: SYNC_ONLY },
        { selector: 'AwaitExpression', message: SYNC_ONLY },
        { selector: "MemberExpression[property.name='then']", message: SYNC_ONLY },
        { selector: `Identifier[name=${names(TIMERS)}]`, message: SYNC_ONLY },
        { selector: `MemberExpression[object.name='fs'][property.name=${names(ASYNC_FS)}]`, message: SYNC_ONLY },
        {
          selector: `MemberExpression[object.name='childProcess'][property.name=${names(ASYNC_CHILD_PROCESS)}]`,
          message: SYNC_ONLY,
        },
        {
          selector: `VariableDeclarator[init.name='fs'] > ObjectPattern > Property[key.name=${names(ASYNC_FS)}]`,
          message: SYNC_ONLY,
        },
        {
          selector: `VariableDeclarator[init.name='childProcess'] > ObjectPattern > Property[key.name=${names(ASYNC_CHILD_PROCESS)}]`,
          message: SYNC_ONLY,
        },
        {
          selector: "TSImportEqualsDeclaration[moduleReference.expression.value=/^(node:)?fs$/][id.name!='fs']",
          message: 'Bind node:fs as fs.',
        },
        {
          selector:
            "TSImportEqualsDeclaration[moduleReference.expression.value=/^(node:)?child_process$/][id.name!='childProcess']",
          message: 'Bind node:child_process as childProcess.',
        },
        {
          selector:
            "ImportDeclaration[source.value=/^(node:)?fs$/] > :matches(ImportNamespaceSpecifier, ImportDefaultSpecifier)[local.name!='fs']",
          message: 'Bind node:fs as fs.',
        },
        {
          selector:
            "ImportDeclaration[source.value=/^(node:)?child_process$/] > :matches(ImportNamespaceSpecifier, ImportDefaultSpecifier)[local.name!='childProcess']",
          message: 'Bind node:child_process as childProcess.',
        },
        {
          selector:
            "CallExpression[callee.object.name='process'][callee.property.name=/^(on|once|addListener|prependListener|prependOnceListener)$/][arguments.0.value=/^SIG/]",
          message: 'Plugin code installs no signal handlers.',
        },
        {
          selector:
            "CallExpression[callee.object.name='process'][callee.property.name=/^(on|once|addListener|prependListener|prependOnceListener)$/][arguments.0.type!='Literal']",
          message: 'Name process events with a string literal.',
        },
      ],
    },
  },
  {
    // node:test runs a registered test whether or not anyone awaits the
    // promise test() returns; the suites register their tests at the top
    // level, as node:test intends.
    files: ['test/**/*.mts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] },
          ],
        },
      ],
    },
  },
);
