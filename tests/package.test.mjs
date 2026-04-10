import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
  return result;
}

test('package manifest declares a pi package entrypoint', () => {
  const packageJsonPath = join(repoRoot, 'package.json');
  assert.ok(existsSync(packageJsonPath), 'package.json should exist at repository root');

  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  assert.equal(pkg.name, 'pi-advisor');
  assert.equal(pkg.type, 'module');
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('pi-package'), 'keywords should include pi-package');
  assert.deepEqual(pkg.pi?.extensions, ['./index.ts']);

  for (const dep of ['@mariozechner/pi-ai', '@mariozechner/pi-coding-agent', '@mariozechner/pi-tui', '@sinclair/typebox']) {
    assert.equal(pkg.peerDependencies?.[dep], '*', `peerDependencies should include ${dep}`);
  }
});

test('package exposes index.ts and advisor implementation files', () => {
  assert.ok(existsSync(join(repoRoot, 'index.ts')), 'index.ts should exist');
  assert.ok(existsSync(join(repoRoot, 'advisor.ts')), 'advisor.ts should exist');
});

test('README documents install and usage', () => {
  const readmePath = join(repoRoot, 'README.md');
  assert.ok(existsSync(readmePath), 'README.md should exist');

  const readme = readFileSync(readmePath, 'utf8');
  assert.match(readme, /pi install npm:pi-advisor/i);
  assert.match(readme, /\/advisor on/i);
  assert.match(readme, /pi package/i);
});

test('package includes a license file matching package.json', () => {
  const licensePath = join(repoRoot, 'LICENSE');
  assert.ok(existsSync(licensePath), 'LICENSE should exist');
  const license = readFileSync(licensePath, 'utf8');
  assert.match(license, /MIT License/i);
});

test('pi can load the package entrypoint as an extension smoke test', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'pi-advisor-home-'));
  try {
    const result = run('pi', ['-e', './index.ts', '--print', '--no-session', '--no-tools', '/advisor'], {
      env: {
        ...process.env,
        HOME: fakeHome,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
