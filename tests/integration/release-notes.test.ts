import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
// @ts-expect-error Release helper is native JavaScript.
import { extractReleaseNotes } from '../../scripts/release-notes.mjs';

const run = (tag: string) => execFileSync(process.execPath, ['scripts/release-notes.mjs', tag], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('release CLI selects exactly the tagged bilingual section, including older versions', () => {
  const fixture = `# Changelog\n\n## v0.2.0\n### English\nNew\n### 中文\n新\n## v0.1.1\n### English\nTarget\n#### Fixes\nDetails\n### 中文\n目标\n## 0.1.0\n### English\nOld\n### 中文\n旧\n`;
  const result = extractReleaseNotes(fixture.replace(/\n/g, '\r\n'), 'v0.1.1');
  assert.equal(result, '### English\nTarget\n#### Fixes\nDetails\n### 中文\n目标\n');
});

test('release CLI rejects missing or invalid tags and emits the actual current version', () => {
  for (const tag of ['v9.9.9', '0.1.1', 'v0.1.1-extra', '']) assert.throws(() => run(tag));
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const notes = run(`v${version}`);
  assert.ok(notes.startsWith('### English\n'));
  assert.ok(notes.indexOf('### 中文') > notes.indexOf('### English'));
  assert.doesNotMatch(notes, /^## v/m);
});


test('release extraction rejects duplicate, empty and incomplete bilingual sections', () => {
  for (const content of [
    '## v0.1.1\n',
    '## v0.1.1\n### English\nOnly English',
    '## v0.1.1\n### 中文\n只有中文',
    '## v0.1.1\n### English\nOne\n### 中文\n一\n## v0.1.1\nDuplicate',
  ]) assert.throws(() => extractReleaseNotes(content, 'v0.1.1'));
});
