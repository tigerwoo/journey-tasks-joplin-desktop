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
test('issue77: list and calendar filters fill one or two rows without an orphaned trailing control', { skip: !executable, timeout: 180000 }, async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const profile = mkdtempSync(join(tmpdir(), 'journey77-layout-'));
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    locale: 'zh_CN', 'plugins.devPluginPaths': resolve('dist'),
    'ui.layout': { key: 'root', visible: true, children: [
      { key: 'sideBar', width: 250, visible: true }, { key: 'noteList', width: 362, visible: true },
      { key: 'editor', flexible: true, visible: true }, { key: 'chatPanel', width: 340, visible: false },
      { key: 'plugin-view-io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad-journey.tasks.panel', width: 400, visible: true, context: { pluginId: 'io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad' } },
    ] },
  }));
  writeFileSync(join(profile, 'window-state-prod.json'), JSON.stringify({ width: 2048, height: 1061 }));
  const app = spawn(executable!, ['--profile', profile, '--running-tests', `--remote-debugging-port=${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  app.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  let socket: WebSocket | undefined;
  const until = async <T>(fn: () => Promise<T | undefined>): Promise<T> => {
    const deadline = Date.now() + 60000;
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
    const report: unknown[] = [];
    const frameExpression = `document.querySelector('[class~="rli-plugin-view-io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad-journey.tasks.panel"] iframe')`;
    for (const mode of ['list', 'calendar']) {
      await evaluate(`(${frameExpression}).contentDocument.querySelectorAll('.mode-switch button')[${mode === 'list' ? 0 : 1}].click()`);
      await until(async () => await evaluate(`!!(${frameExpression}).contentDocument.querySelector('${mode === 'list' ? '.list-sort' : '.calendar-summary'}')`) ? true : undefined);
      for (const width of [400, 440, 500, 501, 600, 708, 800, 801, 900, 1100]) {
        console.log(`Checking ${mode} at ${width}px`);
        await evaluate(`(() => { const frame = ${frameExpression}; frame.closest('.resizableLayoutItem').style.setProperty('width', '${width}px', 'important'); frame.style.setProperty('width', '${width}px', 'important'); frame.style.setProperty('flex-shrink', '0', 'important'); })()`);
        await until(async () => await evaluate(`(${frameExpression}).contentWindow.innerWidth === ${width}`) ? true : undefined);
        const layout = await evaluate(`(() => {
          const doc = (${frameExpression}).contentDocument;
          const rect = element => {
            const r = element.getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width, centerY: r.y + r.height / 2 };
          };
          return {
            bar: rect(doc.querySelector('.view-options')),
            controls: Array.from(doc.querySelector('.view-option-controls').children).map(rect),
            search: rect(doc.querySelector('.task-search')),
            trailing: rect(doc.querySelector('.list-sort, .calendar-summary')),
          };
        })()`);
        const context = `${mode} at ${width}px`;
        const { bar, controls, search, trailing } = layout;
        assert.ok(controls.every((r: { centerY: number }) => Math.abs(r.centerY - controls[0].centerY) < 1), `${context}: first controls stay together`);
        assert.ok(Math.abs(search.centerY - trailing.centerY) < 1, `${context}: search and trailing control stay together`);
        assert.ok(Math.abs(trailing.left - search.right - 8) < 1, `${context}: search fills all space before the trailing control`);
        assert.ok(Math.abs(trailing.right - bar.right) < 1, `${context}: trailing control aligns right`);
        if (width <= 800) {
          assert.ok(search.centerY > controls[0].centerY, `${context}: exactly two rows`);
          assert.ok(Math.abs(search.left - bar.left) < 1, `${context}: search aligns left`);
          assert.ok(Math.abs(controls[3].right - bar.right) < 1, `${context}: notebook fills remaining first-row space`);
        } else {
          assert.ok(Math.abs(search.centerY - controls[0].centerY) < 1, `${context}: one row`);
        }
        report.push({ mode, width, ...layout });
      }
    }
    writeFileSync(resolve('.tmp/issue77-layout-report.json'), JSON.stringify(report, null, 2));
    console.log('Verified list and calendar layouts at 400, 440, 500, 501, 600, 708, 800, 801, 900 and 1100px');
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
