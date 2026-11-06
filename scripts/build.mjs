import { build } from 'esbuild';
import ts from 'typescript';
import { dictionaries } from './compact-dictionaries.mjs';
import { mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await mkdir('publish', { recursive: true });
// Keep localized text in UTF-8 instead of expanding it to Unicode escape sequences.
const opts = { bundle: true, platform: 'browser', target: 'es2020', charset: 'utf8', minify: true,
  legalComments: 'eof', sourcemap: false, metafile: true, tsconfig: 'tsconfig.json' };
// Discover the host graph before pruning: UI-only translations must never enter index.js.
const hostOptions = { ...opts, entryPoints: ['src/index.ts'], outfile: 'dist/index.js', format: 'cjs' };
const graph = await build({ ...hostOptions, write: false });
const hostKeys = new Set();
const translationKeys = new Set(Object.keys(JSON.parse(await readFile('src/i18n/locales/zh-CN.json', 'utf8'))));
for (const file of Object.keys(graph.metafile.inputs)) {
  if (!file.startsWith('src/') || file.startsWith('src/i18n/') || !/\.tsx?$/.test(file)) continue;
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isStringLiteralLike(node) && translationKeys.has(node.text)) hostKeys.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const host = await build({ ...hostOptions, plugins: [await dictionaries(hostKeys)] });
const panel = await build({ ...opts, entryPoints: ['src/panel/index.tsx'], outfile: 'dist/panel.js', format: 'iife', plugins: [await dictionaries()] });
for (const meta of [host.metafile, panel.metafile]) {
  for (const out of Object.values(meta.outputs)) {
    if (out.imports.length) throw new Error('Unexpected external runtime imports: ' + JSON.stringify(out.imports));
  }
}
await build({ ...opts, entryPoints: ['src/panel/mini.ts'], outfile: 'dist/mini.js', format: 'iife' });
await copyFile('src/panel/mini.css', 'dist/mini.css');
const css = await build({ entryPoints: ['src/panel/panel.css'], outfile: 'dist/panel.css', bundle: true,
  loader: { '.png': 'file' }, assetNames: 'assets/[name]-[hash]', metafile: true, target: 'es2020', minify: true });
await copyFile('src/panel/host.css', 'dist/host.css');
await copyFile('src/manifest.json', 'dist/manifest.json');
const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
await copyFile('LICENSE', 'dist/LICENSE');
// JPL uses an ordinary uncompressed portable tar archive (same as Joplin generator).
function header(name, size) {
  const h = Buffer.alloc(512);
  const str = (v, o, n) => h.write(v, o, Math.min(Buffer.byteLength(v), n), 'utf8');
  const oct = (v, o, n) => str(v.toString(8).padStart(n - 1, '0') + '\0', o, n);
  str(name, 0, 100); oct(0o644, 100, 8); oct(0, 108, 8); oct(0, 116, 8);
  oct(size, 124, 12); oct(0, 136, 12); h.fill(32, 148, 156); h[156] = 48;
  str('ustar\0', 257, 6); str('00', 263, 2);
  const sum = h.reduce((a, b) => a + b, 0);
  str(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
const chunks = [];
const runtimeFiles = ['mini.js', 'mini.css', 'host.css', 'index.js', 'panel.js', 'panel.css', 'manifest.json', 'LICENSE',
  ...Object.keys(css.metafile.outputs).filter(file => file !== 'dist/panel.css').map(file => path.relative('dist', file))];
const artifactBytes = {};
for (const name of runtimeFiles) {
  const data = await readFile('dist/' + name);
  artifactBytes[name] = data.length;
  console.log(`  ${name}: ${data.length} bytes`);
  chunks.push(header(name, data.length), data, Buffer.alloc((512 - data.length % 512) % 512));
}
chunks.push(Buffer.alloc(1024));
const archive = Buffer.concat(chunks);
const dest = `publish/${manifest.id}.jpl`;
await writeFile(dest, archive);
await writeFile(`publish/${manifest.id}.json`, JSON.stringify({ ...manifest,
  _publish_hash: 'sha256:' + createHash('sha256').update(archive).digest('hex') }, null, 2) + '\n');
await writeFile('publish/build-metadata.json', JSON.stringify({ format: 1, inputs: Object.keys(host.metafile.inputs),
  panelInputs: Object.keys(panel.metafile.inputs), runtime: 'browser-compatible JavaScript', artifactBytes, hostTranslationKeys: [...hostKeys].filter(key => key.includes('.')).sort(), archiveBytes: archive.length }, null, 2));
console.log(`Built ${dest} (${archive.length} bytes)`);
