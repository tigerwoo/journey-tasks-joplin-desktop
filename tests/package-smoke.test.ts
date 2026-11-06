import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { build } from 'esbuild';
// @ts-expect-error Build helper is native JavaScript.
import { dictionaries } from '../scripts/compact-dictionaries.mjs';
import { registry } from '../src/i18n';
import { MemoryJoplin } from './support/memory-joplin';

const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf8'));
test('built JPL has valid portable tar headers, exactly the runtime files and matching SHA256', () => {
  const bytes = readFileSync(`publish/${manifest.id}.jpl`);
  let offset = 0; const names: string[] = [];
  while (offset + 512 <= bytes.length) {
    const h = bytes.subarray(offset, offset + 512);
    if (h.every(b => b === 0)) break;
    const name = h.subarray(0, 100).toString().replace(/\0.*$/, '');
    const size = parseInt(h.subarray(124, 136).toString().replace(/\0.*$/, ''), 8);
    const stored = parseInt(h.subarray(148, 156).toString().replace(/\0.*$/, '').trim(), 8);
    const copy = Buffer.from(h); copy.fill(32, 148, 156);
    assert.equal(copy.reduce((a, b) => a + b, 0), stored);
    names.push(name); assert.ok(!name.includes('..'));
    assert.deepEqual(bytes.subarray(offset + 512, offset + 512 + size), readFileSync(`dist/${name}`));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const css = readFileSync('dist/panel.css', 'utf8');
  assert.doesNotMatch(css, /data:image/);
  const assets = [...css.matchAll(/url\(["']?(?:\.\/)?(assets\/[^)"']+)["']?\)/g)].map(match => match[1]!);
  assert.equal(assets.length, 1, 'support QR must reference a packaged file');
  assert.match(assets[0]!, /^assets\/bmc_qr-[\w-]+\.png$/);
  assert.deepEqual(names.sort(), ['LICENSE', 'mini.css', 'mini.js', 'host.css', 'index.js', 'manifest.json', 'panel.css', 'panel.js', ...assets].sort());
  // Native restore dialogs now include their own localized errors; the total JPL budget stays unchanged.
  const limits: Record<string, number> = { 'index.js': 275_000, 'panel.js': 1_150_000, 'panel.css': 40_000 };
  for (const [file, limit] of Object.entries(limits)) assert.ok(readFileSync('dist/' + file).length <= limit, `${file} exceeds ${limit} bytes`);
  assert.ok(bytes.length <= 1_500_000, 'JPL exceeds 1.5 MB');
  const info = JSON.parse(readFileSync(`publish/${manifest.id}.json`, 'utf8'));
  assert.equal(info._publish_hash, 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
});

test('actual compiled plugin registers, starts against public API contract and serves the panel handshake', async () => {
  const host = new MemoryJoplin() as any; host.namespace = manifest.id;
  host.notebooks.set('book', { id: 'book', title: '测试笔记本' });
  let registration: { onStart(): Promise<void> } | undefined;
  let messageHandler: ((message: unknown) => Promise<any>) | undefined;
  const scripts: string[] = []; const commands: string[] = [];
  let chromeCssLoaded = false;
  host.plugins = { register(value: typeof registration) { registration = value; }, installationDir: async () => 'dist' };
  host.window = { loadChromeCssFile: async (file: string) => {
    assert.equal(file, 'dist/host.css');
    const css = readFileSync(file, 'utf8');
    assert.match(css, /\.toolbar-icon\.journey-tasks-icon/);
    assert.match(css, /data:image\/svg\+xml/);
    chromeCssLoaded = true;
  } };
  host.commands = { execute: async () => {}, register: async (command: any) => { commands.push(command.name); } };
  host.views = { panels: {
    create: async (id: string) => id, setHtml: async (id: string, html: string) => { assert.match(html, id.endsWith('.mini') ? /id="restore"/ : /id="root"/); assert.doesNotMatch(html, /<!doctype|<html|<head|<body/i); },
    addScript: async (_id: string, asset: string) => { assert.ok(existsSync('dist/' + asset)); scripts.push(asset); },
    onMessage: async (id: string, handler: typeof messageHandler) => { if (id.endsWith('.panel')) messageHandler = handler; },
    show: async () => {}, postMessage() {},
  } };
  runInNewContext(readFileSync('dist/index.js', 'utf8'), { joplin: host, console, Intl, Date, Math, Uint8Array, crypto: webcrypto,
    setTimeout: () => 1, clearTimeout() {} }, { timeout: 2000 });
  assert.ok(registration); await registration.onStart();
  assert.deepEqual(scripts, ['panel.css', 'panel.js', 'mini.css', 'mini.js']);
  assert.ok(chromeCssLoaded, 'compiled plugin must load the packaged SVG toolbar icon');
  assert.ok(commands.includes('journey.completeSelected'));
  assert.ok(messageHandler);
  const response = await messageHandler({ protocolVersion: 1, requestId: 'smoke', action: 'snapshot', query: { view: 'today' } });
  assert.equal(response.ok, true); assert.equal(response.snapshot.view, 'today');
  assert.equal(response.snapshot.folders[0].id, 'book');
  const created = await messageHandler({ protocolVersion: 1, requestId: 'compiled-create', action: 'command', command: {
    requestId: 'compiled-create', action: 'createTask', input: { title: '编译产物创建', notebookId: 'book',
      schedule: { kind: 'allDay', date: '2026-10-24', zone: 'Asia/Shanghai' } },
  } });
  assert.equal(created.result.status, 'saved', created.result.message);
  const after = await messageHandler({ protocolVersion: 1, requestId: 'after-create', action: 'snapshot', query: { view: 'month', date: '2026-10-24' } });
  assert.ok(after.snapshot.items.some((item: any) => item.title === '编译产物创建'));
  assert.equal(after.snapshot.diagnostics.length, 0);

});

test('compact bundled dictionaries preserve every translation in all 26 locales and the host subset', async () => {
  const metadata = JSON.parse(readFileSync('publish/build-metadata.json', 'utf8'));
  for (const keys of [undefined, new Set<string>(metadata.hostTranslationKeys)]) {
    const result = await build({ entryPoints: ['src/i18n/index.ts'], bundle: true, platform: 'browser',
      format: 'cjs', write: false, plugins: [await dictionaries(keys)] });
    const module = { exports: {} as any };
    runInNewContext(result.outputFiles[0]!.text, { module, exports: module.exports });
    const bundled = module.exports;
    assert.equal(Object.keys(bundled.registry).length, 26);
    for (const [locale, entry] of Object.entries(registry)) {
      const expected = Object.fromEntries(Object.entries(entry.dictionary).filter(([key]) => !keys || keys.has(key)));
      assert.deepEqual(JSON.parse(JSON.stringify(bundled.registry[locale].dictionary)), expected, locale);
      for (const [key, value] of Object.entries(expected)) assert.equal(bundled.createTranslator(locale)(key), value);
      assert.equal(bundled.resolveLanguage('auto', locale), locale);
      if (keys) {
        assert.equal(bundled.registry[locale].dictionary['settings.title'], undefined);
        for (const code of ['MISSING', 'INVALID', 'ENDED', 'NOTEBOOK', 'FAILED'])
          assert.ok(bundled.registry[locale].dictionary[`backend.RESTORE_FIRST_${code}`], `${locale}: native restore error ${code}`);
      }
    }
  }
});
