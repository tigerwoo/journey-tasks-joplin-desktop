import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// Opt-in real Electron integration test. Always starts its own empty profile.
const executable = process.env.JOURNEY_JOPLIN;
test('native Joplin divider remains visible, resizes both ways, and persists after reload', { skip: !executable, timeout: 180000 }, async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const profile = mkdtempSync(join(tmpdir(), 'journey-resize-'));
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    locale: 'en_GB', 'plugins.devPluginPaths': resolve('dist'),
    'ui.layout': { key: 'root', visible: true, children: [
      { key: 'sideBar', width: 250, visible: true }, { key: 'noteList', width: 362, visible: true },
      { key: 'editor', flexible: true, visible: true }, { key: 'chatPanel', width: 340, visible: false },
      { key: 'plugin-view-io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad-journey.tasks.panel', width: 700, visible: true, context: { pluginId: 'io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad' } },
    ] },
  }));
  writeFileSync(join(profile, 'window-state-prod.json'), JSON.stringify({ width: 2048, height: 1061 }));
  const app = spawn(executable!, ['--profile', profile, '--running-tests', `--remote-debugging-port=${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  app.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  let socket: WebSocket | undefined;
  const until = async <T>(fn: () => Promise<T | undefined>): Promise<T> => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const result = await fn();
      if (result !== undefined) return result;
      if (app.exitCode !== null) throw new Error(`Test Joplin exited: ${errors}`);
      await delay(100);
    }
    throw new Error(`Timed out waiting for isolated Joplin: ${errors}`);
  };
  try {
    const target = await until(async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
        return list.find(t => t.type === 'page' && t.url.endsWith('/index.html'));
      } catch { return undefined; }
    });
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener('open', () => resolve(), { once: true });
      socket!.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(message.error); else request.resolve(message.result);
    });
    const rpc = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string): Promise<any> => {
      const result = await rpc('Runtime.evaluate', { expression, returnByValue: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await rpc('Emulation.setDeviceMetricsOverride', { width: 2048, height: 1000, deviceScaleFactor: 1, mobile: false });
    const ready = () => until(async () => await evaluate("!!document.querySelector('[data-journey-resize-guide]')") ? true : undefined);
    await ready();
    console.log('Isolated panel ready');
    const measure = () => evaluate(`(() => {
      const pane = document.querySelector('[class~="rli-plugin-view-io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad-journey.tasks.panel"]');
      const h = document.querySelector('[data-journey-resize-guide]');
      const r = h.getBoundingClientRect();
      return { width: pane.getBoundingClientRect().width, x: r.x, y: r.y + r.height / 2,
        handleWidth: r.width, hits: [1, r.width / 2, r.width - 1].map(dx => document.elementFromPoint(r.x + dx, r.y + r.height / 2) === h),
        guides: document.querySelectorAll('style[data-journey-resize-styles]').length };
    })()`);
    // Negative control: disabling just the enhancement reproduces the iframe overlap.
    await evaluate("document.querySelector('style[data-journey-resize-styles]').disabled = true");
    const baseline = await measure();
    assert.equal(baseline.hits[2], false, 'native handle right half must reproduce iframe occlusion');
    await evaluate("document.querySelector('style[data-journey-resize-styles]').disabled = false");
    const start = await measure();
    assert.deepEqual(start.hits, [true, true, true]);
    assert.equal(start.handleWidth, 12);
    assert.equal(start.guides, 1);
    const drag = async (dx: number) => {
      const { x: left, y } = await measure();
      const x = left + 9; // Inside the half that the iframe used to cover.
      await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await delay(50);
      for (let step = 1; step <= 4; step++) {
        await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx * step / 4, y, button: 'left', buttons: 1 });
        await delay(20);
      }
      await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y, button: 'left', buttons: 0, clickCount: 1 });
      await delay(150);
      const result = await measure();
      assert.deepEqual(result.hits, [true, true, true], 'drag overlay must not replace the marked divider');
      return result;
    };
    const shrunk = await drag(160), widened = await drag(-80), shrunkAgain = await drag(60);
    assert.equal(shrunk.width, start.width - 160);
    assert.equal(widened.width, shrunk.width + 80);
    assert.equal(shrunkAgain.width, widened.width - 60);
    await until(async () => {
      const layout = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))['ui.layout'];
      return layout.children.find((p: { key: string }) => p.key.includes('io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad'))?.width === shrunkAgain.width ? true : undefined;
    });
    await rpc('Page.reload');
    await ready();
    const reloaded = await measure();
    assert.equal(reloaded.width, shrunkAgain.width);
    assert.equal(reloaded.guides, 1);
    assert.deepEqual(reloaded.hits, [true, true, true]);
    await evaluate(`document.querySelector('[class~="rli-plugin-view-io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad-journey.tasks.panel"]').style.display = 'none'`);
    await until(async () => await evaluate("!document.querySelector('[data-journey-resize-guide]')") ? true : undefined);
    await evaluate(`document.querySelector('[class~="rli-plugin-view-io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad-journey.tasks.panel"]').style.display = 'flex'`);
    await ready();
    await rpc('Emulation.setDeviceMetricsOverride', { width: 1360, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until(async () => await evaluate("document.querySelector('.rli-root').getBoundingClientRect().width === 1360") ? true : undefined);
    const narrowStart = await measure(), narrowShrunk = await drag(80), narrowWidened = await drag(-60);
    assert.equal(narrowShrunk.width, narrowStart.width - 80);
    assert.equal(narrowWidened.width, narrowShrunk.width + 60);
    console.log('Checking minimum width');
    const minimum = await drag(1000);
    assert.equal(minimum.width, 400, 'main panel cannot shrink below its usable width');
    const contentWidth = await evaluate(`document.querySelector('[class~="rli-plugin-view-io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad-journey.tasks.panel"] iframe').getBoundingClientRect().width`);
    assert.ok(contentWidth >= 390, 'webview fills the constrained panel');
    const filterLayout = await evaluate(`(() => {
      const frame = document.querySelector('[class~="rli-plugin-view-io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad-journey.tasks.panel"] iframe');
      const bar = frame.contentDocument.querySelector('.view-options');
      return Array.from(bar.querySelectorAll(':scope > .view-option-controls > *, :scope > .view-search-controls > *')).map(element => {
        const rect = element.getBoundingClientRect();
        return { centerY: rect.y + rect.height / 2, right: rect.right, width: rect.width };
      });
    })()`);
    const firstRow = filterLayout.slice(0, 4);
    assert.ok(firstRow.every((item: { centerY: number }) => Math.abs(item.centerY - firstRow[0].centerY) < 1), 'options and notebook filter share the first row at 400px');
    assert.ok(filterLayout[4].centerY > firstRow[0].centerY, 'search occupies the second row');
    assert.equal(filterLayout[4].centerY, filterLayout[5].centerY, 'search and sort share the second row');
    assert.equal(filterLayout[5].right - filterLayout[5].width - filterLayout[4].right, 8, 'search fills the second row up to the 8px gap before sort');
    assert.ok(filterLayout[3].width < 144, 'notebook filter narrows to the remaining first-row space');
    assert.ok(Math.abs(filterLayout[3].right - filterLayout[5].right) < 1, 'both rows align on the right');
    const recovered = await drag(-100);
    assert.ok(recovered.width > minimum.width, 'panel can grow again after reaching the minimum');
    const report = { baseline, start, shrunk, widened, shrunkAgain, reloaded, narrowStart, narrowShrunk, narrowWidened, minimum, contentWidth, filterLayout, recovered };
    writeFileSync(resolve('tests/artifacts/panel-resize-host-check.json'), JSON.stringify(report, null, 2) + '\n');
    const screenshot = await rpc('Page.captureScreenshot', { format: 'png' });
    writeFileSync(resolve('tests/artifacts/panel-resize-host-check.png'), Buffer.from(screenshot.data, 'base64'));
    console.log(JSON.stringify(report));
  } finally {
    socket?.close();
    if (app.exitCode === null) {
      app.kill('SIGTERM');
      await Promise.race([new Promise<void>(resolve => app.once('exit', () => resolve())), delay(1000)]);
      if (app.exitCode === null) { app.kill('SIGKILL'); await new Promise<void>(resolve => app.once('exit', () => resolve())); }
    }
    rmSync(profile, { recursive: true, force: true });
  }
});
