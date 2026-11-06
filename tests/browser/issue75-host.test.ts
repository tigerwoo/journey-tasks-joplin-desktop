import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const executable = process.env.JOURNEY_JOPLIN;
const pluginId = 'io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad';
const main = `plugin-view-${pluginId}-journey.tasks.panel`;
const mini = `plugin-view-${pluginId}-journey.tasks.mini`;

test('issue75: built desktop panels collapse to 32px, restore, toggle and survive resize/restart', { skip: !executable, timeout: 60000 }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'journey75-host-'));
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    locale: 'en_GB', 'plugins.devPluginPaths': resolve('dist'),
    'ui.layout': { key: 'root', visible: true, direction: 'row', children: [
      { key: 'sideBar', width: 180, visible: true }, { key: 'noteList', width: 200, visible: true },
      { key: 'editor', flexible: true, visible: true },
      { key: main, width: 500, visible: true, context: { pluginId } },
      { key: mini, width: 250, visible: false, context: { pluginId } },
    ] },
  }));
  writeFileSync(join(profile, 'window-state-prod.json'), JSON.stringify({ width: 1600, height: 1000 }));
  const server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(r => server.close(() => r()));
  const startApp = () => spawn(executable!, ['--profile', profile, '--running-tests', `--remote-debugging-port=${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let app = startApp();
  let stderr = ''; app.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-3000); });
  let socket: WebSocket | undefined;
  const until = async <T>(fn: () => Promise<T | undefined>): Promise<T> => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const result = await fn(); if (result !== undefined) return result;
      if (app.exitCode !== null) throw new Error(`Isolated Joplin exited: ${stderr}`);
      await delay(100);
    }
    throw new Error(`Isolated Joplin timed out: ${stderr}`);
  };
  try {
    const target = await until(async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
        return list.find(t => t.type === 'page' && t.url.endsWith('/index.html'));
      } catch { return undefined; }
    });
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((r, j) => { socket!.addEventListener('open', () => r(), { once: true }); socket!.addEventListener('error', j, { once: true }); });
    let sequence = 0;
    const pending = new Map<number, (value: any) => void>();
    const contexts = new Set<number>();
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.executionContextCreated') contexts.add(message.params.context.id);
      if (message.method === 'Runtime.executionContextDestroyed') contexts.delete(message.params.executionContextId);
      if (message.method === 'Runtime.executionContextsCleared') contexts.clear();
      const done = pending.get(message.id); if (done) { pending.delete(message.id); done(message); }
    };
    socket.addEventListener('message', onMessage);
    const rpc = (method: string, params: object = {}): Promise<any> => new Promise((r, j) => {
      const id = ++sequence; pending.set(id, r); socket!.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending.delete(id)) j(new Error(`RPC timed out: ${method}`)); }, 5000).unref();
    });
    const evaluate = async (expression: string, contextId?: number) => {
      const reply = await rpc('Runtime.evaluate', { expression, returnByValue: true, ...(contextId ? { contextId } : {}) });
      if (reply.error || reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.error || reply.result.exceptionDetails));
      return reply.result.result.value;
    };
    await rpc('Runtime.enable');
    await rpc('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    const clickView = async (selector: string) => {
      const context = await until(async () => {
        for (const id of contexts) {
          try { if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`, id)) return id; } catch { /* Frame reloaded. */ }
        }
        return undefined;
      });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`, context);
    };
    const measure = () => evaluate(`(() => {
      const size = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return {width: Math.round(r.width), height: Math.round(r.height)}; };
      return { main: size('[class~="rli-${main}"]'), mini: size('[class~="rli-${mini}"]'),
        miniInner: size('[class~="rli-${mini}"]>div:first-child'), editor: size('.rli-editor'), inner: size('.rli-editor>div:first-child') };
    })()`);
    const waitMode = async (collapsed: boolean) => until(async () => {
      const value = await measure();
      if (collapsed ? value.main?.width === 0 && value.mini?.width === 32 : value.main?.width > 0 && value.mini?.width === 0) return value;
      return undefined;
    });
    await until(async () => (await measure()).main?.width > 0 && await evaluate("!!document.querySelector('.journey-tasks-icon')") ? true : undefined);
    // Native command/menu registration completes after the iframe first renders.
    await delay(1000);
    await clickView('.window-actions button');
    const collapsed = await waitMode(true);
    assert.equal(collapsed.miniInner.width, 32);
    assert.equal(collapsed.inner.width, collapsed.editor.width - 5, 'content uses the released space without covering the divider');
    await clickView('#restore');
    const restored = await waitMode(false);
    assert.equal(restored.main.width, 500);
    assert.ok(collapsed.inner.width > restored.inner.width + 400);
    await clickView('.window-actions button');
    await waitMode(true);
    await rpc('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
    const resized = await until(async () => {
      const value = await measure(); return value.editor.width < collapsed.editor.width ? value : undefined;
    });
    assert.equal(resized.mini.width, 32);
    assert.equal(resized.inner.width, resized.editor.width - 5);
    const toggle = () => evaluate("document.querySelector('.journey-tasks-icon').closest('button').click()");
    await toggle();
    await until(async () => { const value = await measure(); return value.main.width === 0 && value.mini.width === 0 ? true : undefined; });
    await toggle();
    const reopened = await waitMode(false);
    assert.equal(reopened.main.width, 500);
    assert.equal(reopened.inner.width, reopened.editor.width - 5);
    // Actual pointer drag: expanded panel retains Joplin's native resizer.
    const point = await evaluate("(() => { const r=document.querySelector('.rli-editor').getBoundingClientRect(); return {x:r.right-2,y:r.y+r.height/2}; })()");
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 8; step++) {
      await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + step * 10, y: point.y, button: 'left', buttons: 1 });
      await delay(20);
    }
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 80, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    const dragged = await until(async () => { const value = await measure(); return value.main.width < reopened.main.width ? value : undefined; });
    assert.equal(dragged.main.width, 420);
    await clickView('.window-actions button'); await waitMode(true);
    await clickView('#restore');
    assert.equal((await waitMode(false)).main.width, 420, 'collapse never rewrites the saved main width');
    await until(async () => {
      try {
        const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
        return settings['ui.layout'].children.find((item: any) => item.key === main)?.width === 420 ? true : undefined;
      } catch { return undefined; }
    });
    // The layout editor must retain full-size move controls for the independent mini view.
    const nativeCommand = async (name: string) => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
      const target = targets.find(item => item.url.includes(`pluginId=${pluginId}&`));
      assert.ok(target);
      const connection = new WebSocket(target.webSocketDebuggerUrl);
      try {
        await new Promise<void>((r, j) => { connection.addEventListener('open', () => r(), { once: true }); connection.addEventListener('error', j, { once: true }); });
        await new Promise<void>((r, j) => {
          const timeout = setTimeout(() => j(new Error('Native layout command timed out')), 5000);
          connection.addEventListener('message', event => {
            const response = JSON.parse(String(event.data)); if (response.id !== 1) return;
            clearTimeout(timeout);
            if (response.error || response.result.exceptionDetails) j(new Error(JSON.stringify(response)));
            else r();
          });
          connection.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `void joplin.commands.execute(${JSON.stringify(name)})`, returnByValue: true } }));
        });
      } finally { connection.close(); }
    };
    await nativeCommand('toggleLayoutMoveMode');
    const moveWidth = await until(async () => await evaluate(`document.querySelector('.change-app-layout-dialog [class~="rli-${mini}"]')?.getBoundingClientRect().width`));
    assert.ok(moveWidth >= 40, 'move controls must not be clipped to the 32px rail');
    await nativeCommand('toggleLayoutMoveMode');
    await until(async () => await evaluate("!document.querySelector('.change-app-layout-dialog')") ? true : undefined);
    // Restart the whole application, including its plugin background windows.
    const restart = async () => {
      socket?.close(); app.kill('SIGTERM');
      await Promise.race([new Promise<void>(r => app.once('exit', () => r())), delay(1000)]);
      if (app.exitCode === null) { app.kill('SIGKILL'); await new Promise<void>(r => app.once('exit', () => r())); }
      contexts.clear(); app = startApp();
      app.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-3000); });
      const restartedTarget = await until(async () => {
        try {
          const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
          return list.find(item => item.type === 'page' && item.url.endsWith('/index.html'));
        } catch { return undefined; }
      });
      socket = new WebSocket(restartedTarget.webSocketDebuggerUrl);
      await new Promise<void>((r, j) => { socket!.addEventListener('open', () => r(), { once: true }); socket!.addEventListener('error', j, { once: true }); });
      socket.addEventListener('message', onMessage);
      await rpc('Runtime.enable');
      await rpc('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
    };
    await restart();
    await until(async () => { const value = await measure(); return value.main?.width === 420 && value.mini?.width === 0 ? true : undefined; });
    await until(async () => await evaluate("!!document.querySelector('.journey-tasks-icon')") ? true : undefined);
    await delay(1000);
    await clickView('.window-actions button'); await waitMode(true);
    await clickView('#restore'); await waitMode(false);

    await clickView('.window-actions button'); await waitMode(true);
    const artifacts = resolve('.tmp/issue75-host'); mkdirSync(artifacts, { recursive: true });
    const foldedScreenshot = await rpc('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifacts, 'collapsed.png'), Buffer.from(foldedScreenshot.result.data, 'base64'));
    await clickView('#restore'); await waitMode(false);
    // Closing must survive a complete process restart, rather than reopening at boot.
    await toggle();
    await until(async () => { const value = await measure(); return value.main.width === 0 && value.mini.width === 0 ? true : undefined; });
    await delay(1500); // Let Joplin flush its setting store before terminating the process.
    await restart();
    await until(async () => await evaluate("!!document.querySelector('.journey-tasks-icon')") ? true : undefined);
    await delay(1000);
    const hiddenAfterRestart = await measure();
    assert.equal(hiddenAfterRestart.main.width, 0);
    assert.equal(hiddenAfterRestart.mini.width, 0);
    await toggle();
    assert.equal((await waitMode(false)).main.width, 420);
    await clickView('.window-actions button'); await waitMode(true);
    await delay(1500);
    await restart();
    await until(async () => await evaluate("!!document.querySelector('.journey-tasks-icon')") ? true : undefined);
    await delay(1000);
    const collapsedAfterRestart = await waitMode(true);
    assert.equal(collapsedAfterRestart.mini.width, 32);
    await clickView('#restore');
    assert.equal((await waitMode(false)).main.width, 420);
    const report = { collapsed, restored, resized, reopened, dragged, moveWidth, hiddenAfterRestart, collapsedAfterRestart };
    writeFileSync(join(artifacts, 'result.json'), JSON.stringify(report, null, 2));
    const screenshot = await rpc('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifacts, 'restored.png'), Buffer.from(screenshot.result.data, 'base64'));
    console.log(JSON.stringify(report));
  } finally {
    socket?.close();
    app.kill('SIGTERM');
    await Promise.race([new Promise<void>(r => app.once('exit', () => r())), delay(1000)]);
    if (app.exitCode === null) app.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }
});
