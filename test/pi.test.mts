// The pi host's pointer skills: one plugin/pi/skills/amber-<name>/SKILL.md per
// shared skill, under the name pi accepts, pointing at the shared file and
// keeping its explicit-only flag. The pi extension itself runs inside pi and
// is checked by hand in a scratch zone (DEVELOPMENT.md). A plugin build from
// before the pi host (a parity reference) has no plugin/pi: skipped there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { PLUGIN } from './support/plugin.mjs';

const SHARED = path.join(PLUGIN, 'skills');
const POINTERS = path.join(PLUGIN, 'pi', 'skills');
const skip = !fs.existsSync(POINTERS);

function frontmatter(file: string): Map<string, string> {
  const text = fs.readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, file + ' has frontmatter');
  const fields = new Map<string, string>();
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) fields.set(kv[1] ?? '', kv[2] ?? '');
  }
  return fields;
}

const sharedNames = (): string[] =>
  fs
    .readdirSync(SHARED)
    .filter((n) => fs.existsSync(path.join(SHARED, n, 'SKILL.md')))
    .sort();

test('every shared skill has exactly one pi pointer skill', { skip }, () => {
  const pointers = fs.readdirSync(POINTERS).sort();
  assert.deepEqual(
    pointers,
    sharedNames().map((n) => 'amber-' + n),
  );
});

test('pi pointer skills carry a valid name and description', { skip }, () => {
  for (const name of sharedNames()) {
    const fields = frontmatter(
      path.join(POINTERS, 'amber-' + name, 'SKILL.md'),
    );
    assert.equal(fields.get('name'), 'amber-' + name);
    assert.match(fields.get('name') ?? '', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const description = fields.get('description') ?? '';
    assert.ok(description.length > 0, name + ' has a description');
    assert.ok(description.length <= 1024, name + ' description fits pi');
  }
});

test(
  'pi pointer skills keep the explicit-only flag of the shared skill',
  { skip },
  () => {
    for (const name of sharedNames()) {
      const shared = frontmatter(path.join(SHARED, name, 'SKILL.md'));
      const pointer = frontmatter(
        path.join(POINTERS, 'amber-' + name, 'SKILL.md'),
      );
      assert.equal(
        pointer.get('disable-model-invocation'),
        shared.get('disable-model-invocation'),
        name,
      );
    }
  },
);

test('pi pointer skills link to files that exist', { skip }, () => {
  for (const name of sharedNames()) {
    const file = path.join(POINTERS, 'amber-' + name, 'SKILL.md');
    const text = fs.readFileSync(file, 'utf8');
    const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1] ?? '');
    assert.ok(
      links.includes('../../../skills/' + name + '/SKILL.md'),
      name + ' points at its shared skill',
    );
    for (const link of links) {
      assert.ok(
        fs.existsSync(path.resolve(path.dirname(file), link)),
        name + ': ' + link,
      );
    }
  }
});
