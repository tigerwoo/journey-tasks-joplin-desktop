import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractReleaseNotes } from './release-notes.mjs';
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const pkg = readJson('package.json');
const manifest = readJson('src/manifest.json');
assert.equal(pkg.version, manifest.version, 'Package and manifest versions must match');
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'Release version must be stable semver');
if (process.env.RELEASE_TAG) assert.equal(process.env.RELEASE_TAG, `v${pkg.version}`, 'Tag must match package version');
extractReleaseNotes(readFileSync('changelog.md', 'utf8'), `v${pkg.version}`);
assert.notEqual(pkg.private, true, 'npm publishing must be enabled');
assert.ok(pkg.name.startsWith('joplin-plugin-') && pkg.keywords.includes('joplin-plugin'));
assert.deepEqual(manifest.platforms, ['desktop']);
const base = `publish/${manifest.id}`;
const info = readJson(`${base}.json`);
assert.equal(info.version, pkg.version);
assert.equal(info.id, manifest.id);
assert.deepEqual(info.platforms, ['desktop']);
assert.equal(info._publish_hash, 'sha256:' + createHash('sha256').update(readFileSync(`${base}.jpl`)).digest('hex'));
// Inspect the actual archive: npm's JSON display can redact UUID-like filenames.
const temp = mkdtempSync(path.join(tmpdir(), 'journey-release-'));
let names;
try {
  const [pack] = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], { encoding: 'utf8' }));
  names = execFileSync('tar', ['-tzf', path.join(temp, pack.filename)], { encoding: 'utf8' }).trim().split('\n').map(name => name.replace(/^package\//, ''));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
for (const required of [`${base}.jpl`, `${base}.json`, 'README.md', 'README.zh-CN.md', 'LICENSE', 'package.json']) assert.ok(names.includes(required), `Missing npm file: ${required}`);
for (const name of names) assert.ok(['package.json', 'README.md', 'README.zh-CN.md', 'LICENSE', `${base}.jpl`, `${base}.json`].includes(name), `Unexpected npm file: ${name}`);
console.log(`Release verified: ${pkg.name}@${pkg.version}; npm package contains the JPL and matching manifest`);
