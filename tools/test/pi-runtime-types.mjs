// Supplemental check: ordinary package tsc intentionally excludes pi's
// handwritten extensions. Resolve host-supplied types without installing peers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const install =
  process.env.PI_MANAGED_INSTALL_ROOT ||
  path.join(os.homedir(), '.pi/agent/install');
let host = process.env.PI_RUNTIME_PACKAGE_ROOT;
if (!host) {
  const versionFile = path.join(install, 'current-version');
  if (!fs.existsSync(versionFile)) {
    throw new Error(
      'Set PI_RUNTIME_PACKAGE_ROOT to the installed @earendil-works/pi-coding-agent package directory (pi 1.3+). No packages are installed by this check.',
    );
  }
  host = path.join(
    install,
    'releases',
    fs.readFileSync(versionFile, 'utf8').trim(),
    'node_modules/@earendil-works/pi-coding-agent',
  );
}
const modules = path.resolve(host, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-runtime-types-'));
try {
  const file = path.join(dir, 'tsconfig.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: 'ES2022',
        module: 'preserve',
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        types: ['node'],
        typeRoots: [path.resolve('node_modules/@types')],
        paths: {
          '@earendil-works/pi-ai': [
            path.join(modules, '@earendil-works/pi-ai/dist/index.d.ts'),
          ],
          '@earendil-works/pi-coding-agent': [
            path.join(host, 'dist/index.d.ts'),
          ],
        },
      },
      files: [
        path.resolve('plugin/pi/index.ts'),
        ...['index', 'fast', 'switch-model'].map((name) =>
          path.resolve(`plugin/pi/runtime/${name}.ts`),
        ),
      ],
    }),
  );
  const result = spawnSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', file],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0)
    console.log('Handwritten pi adapter/runtime strict typecheck passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
