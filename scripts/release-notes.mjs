import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Keep every release under a level-two version heading, newest first.
export function extractReleaseNotes(changelog, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('Expected a stable release tag such as v0.1.1');
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^##\s+v?(\d+\.\d+\.\d+)\s*$/.exec(lines[i]);
    if (match) headings.push({ version: `v${match[1]}`, line: i });
  }
  const matches = headings.filter(heading => heading.version === tag);
  if (matches.length !== 1) throw new Error(`Expected exactly one changelog section for ${tag}`);
  const start = matches[0];
  const end = headings.find(heading => heading.line > start.line)?.line ?? lines.length;
  const notes = lines.slice(start.line + 1, end).join('\n').trim();
  if (!notes || !/^### English\s*$/m.test(notes) || !/^### 中文\s*$/m.test(notes)) {
    throw new Error(`Changelog for ${tag} must contain English and Chinese release notes`);
  }
  return notes + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(extractReleaseNotes(readFileSync('changelog.md', 'utf8'), process.argv[2] ?? process.env.RELEASE_TAG));
}
