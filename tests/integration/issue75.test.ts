import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { App } from '../../src/panel/App';
import { startPlugin } from '../../src/bootstrap';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';

test('issue75: collapse preserves the view; native toolbar toggles actual host visibility and restores editors', async () => {
  const host = new MemoryJoplin() as any;
  host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  const commands = new Map<string, any>();
  const visibility: boolean[] = [];
  let receive: (event: any) => void = () => {};
  const mainId = 'journey.tasks.panel', miniId = 'journey.tasks.mini';
  const hostVisible = new Map<string, boolean>();
  const html = new Map<string, string>();
  const handlers = new Map<string, (message: any) => Promise<any>>();
  const toolbar: unknown[][] = [];
  const chromeStyles: string[] = [];
  host.plugins = { installationDir: async () => "/plugin/journey" };
  host.window = { loadChromeCssFile: async (path: string) => { chromeStyles.push(path); } };
  host.commands = { register: async (command: any) => commands.set(command.name, command), execute: async () => {} };
  host.views = { toolbarButtons: { create: async (...args: unknown[]) => { toolbar.push(args); } }, panels: {
    create: async (id: string) => id, setHtml: async (id: string, value: string) => { html.set(id, value); }, addScript: async () => {}, onMessage: async (id: string, handler: any) => { handlers.set(id, handler); },
    postMessage: (id: string, message: any) => { if (id === mainId) receive({ message }); },
    show: async (id: string, visible: boolean) => { hostVisible.set(id, visible); if (id === mainId) visibility.push(visible); },
    visible: async (id: string) => hostVisible.get(id) ?? false,
  } };
  const runtime = await startPlugin(host);
  await runtime.app.dispatch({ action: 'savePreferences', requestId: 'language', preferences: { language: 'zh-CN' } });
  const listeners = new Map<string, Function>();
  const noop = () => {};
  const values = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { addEventListener: (name: string, fn: Function) => listeners.set(name, fn), removeEventListener: noop,
      dispatchEvent: (event: any) => listeners.get(event.type)?.(event), innerWidth: 1000, innerHeight: 800 },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    navigator: { platform: 'MacIntel', languages: ['zh-CN'] },
    webviewApi: { onMessage: (handler: typeof receive) => { receive = handler; }, postMessage: (message: any) => runtime.panel.handleMessage(message) },
  };
  const originals = Object.keys(values).map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  let renderer: ReturnType<typeof create> | undefined;
  try {
    Object.entries(values).forEach(([name, value]) => Object.defineProperty(globalThis, name, { configurable: true, value }));
    await act(async () => { renderer = create(React.createElement(App)); });
    const button = (label: string) => renderer!.root.findAllByType('button').find(node => node.props['aria-label'] === label)!;
    const main = () => renderer!.root.findByType('main');
    const collapse = async () => act(async () => { button('折叠面板').props.onClick(); });
    const isCollapsed = () => { assert.equal(hostVisible.get(mainId), false); assert.equal(hostVisible.get(miniId), true); };
    const restoreMini = async () => act(async () => {
      assert.equal((await handlers.get(miniId)!({ action: 'restorePanel', protocolVersion: 1, requestId: 'restore' })).ok, true);
    });
    await act(async () => { renderer!.root.findAllByType('button').find(node => node.children.includes('明天'))!.props.onClick(); });
    await collapse();
    isCollapsed();
    assert.equal(main().props.hidden, false, 'React tree stays mounted inside the hidden host panel');
    await restoreMini();
    assert.equal(hostVisible.get(miniId), false);
    assert.equal(main().props.hidden, false);
    assert.ok(renderer!.root.findAllByType('button').some(node => node.children.includes('明天') && node.props['aria-pressed']));
    await collapse();
    await act(async () => { await commands.get('journey.showTasks').execute(); });
    assert.equal(main().props.hidden, false);
    await collapse();
    await act(async () => { await runtime.panel.openEditor('new'); });
    assert.equal(main().props.hidden, false);
    assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 1);
    await act(async () => { renderer!.root.findByProps({ className: 'drawer-header' }).findByType('button').props.onClick(); });
    assert.deepEqual(toolbar, [['journey.tasks.toggle', 'journey.toggleTasks', 'noteToolbar']]);
    assert.deepEqual(chromeStyles, ['/plugin/journey/host.css']);
    assert.equal(commands.get('journey.toggleTasks').iconName, 'journey-tasks-icon');
    assert.equal(renderer!.root.findAllByProps({ 'aria-label': '关闭面板' }).length, 0);
    const restore = async () => act(async () => { await commands.get('journey.toggleTasks').execute(); });
    await restore();
    assert.equal(visibility.at(-1), false);
    await restore();
    assert.equal(visibility.at(-1), true);
    await collapse();
    isCollapsed();
    assert.match(html.get(miniId)!, /<svg/);
    assert.doesNotMatch(html.get(miniId)!, /JOURNEY TASKS|&lt;&lt;/);
    const ready = await handlers.get(miniId)!({ action: 'miniReady', protocolVersion: 1, requestId: 'mini-label' });
    assert.equal(ready.label, '恢复面板');
    assert.equal((await handlers.get(miniId)!({ action: 'command' })).ok, false);
    await restore();
    assert.equal(visibility.at(-1), false);
    assert.equal(hostVisible.get(miniId), false, 'toolbar hides both views when collapsed');
    await restore();
    assert.equal(main().props.hidden, false);
    hostVisible.set(mainId, false); // Joplin can hide panels independently of our command.
    await restore();
    assert.equal(visibility.at(-1), true, 'toggle must read actual host visibility');
    assert.equal((await runtime.panel.handleMessage({ action: 'closePanel' })).ok, false);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    Object.keys(values).forEach((name, index) => { const old = originals[index]; if (old) Object.defineProperty(globalThis, name, old); else delete (globalThis as any)[name]; });
    runtime.dispose();
  }
});

test('issue75: failed switches roll back and concurrent toolbar clicks are serialized', async () => {
  const { PanelController } = await import('../../src/panel/controller');
  const main = 'journey.tasks.panel', mini = 'journey.tasks.mini';
  const visible = new Map<string, boolean>();
  let failHide = '';
  const api = { settings: new MemoryJoplin().settings, views: { panels: {
    create: async (id: string) => id, setHtml: async () => {}, addScript: async () => {}, onMessage: async () => {}, postMessage() {},
    visible: async (id: string) => visible.get(id) ?? false,
    show: async (id: string, value: boolean) => {
      if (id === failHide && !value) { failHide = ''; throw new Error('Host rejected visibility change'); }
      visible.set(id, value);
    },
  } } };
  // Match Joplin's mutable namespace proxy, including the cached optional-method trap.
  const namespaceProxy = (path: string[] = []): any => new Proxy(() => {}, {
    get: (_target, key: string) => {
      const next = path.length ? path : [];
      next.push(key); return namespaceProxy(next);
    },
    apply: (_target, _receiver, args) => {
      const callPath = [...path]; path.pop();
      const key = callPath.pop()!;
      const owner = callPath.reduce((value: any, part) => value[part], api);
      return owner[key](...args);
    },
  });
  const panel = new PanelController(namespaceProxy(), { snapshot: async () => ({ preferences: { language: 'en' } }) } as any);
  await panel.initialize(); await panel.enableCompact(); await panel.show();
  const collapse = () => panel.handleMessage({ action: 'collapsePanel', protocolVersion: 1, requestId: 'collapse' });
  failHide = main;
  assert.equal((await collapse()).ok, false);
  assert.equal(visible.get(main), true); assert.equal(visible.get(mini), false);
  assert.equal((await collapse()).compact, true);
  failHide = mini;
  await assert.rejects(panel.show(), /Host rejected/);
  assert.equal(visible.get(main), false); assert.equal(visible.get(mini), true);
  await panel.show();
  await Promise.all([panel.toggle(), panel.toggle()]);
  assert.equal(visible.get(main), true); assert.equal(visible.get(mini), false);
  await Promise.all([collapse(), panel.toggle()]);
  assert.equal(visible.get(main), false); assert.equal(visible.get(mini), false, 'collapse and toolbar click retain arrival order across label reads');
});

test('issue75: hosts without desktop chrome CSS keep the content-only fallback', async () => {
  const { PanelController } = await import('../../src/panel/controller');
  const calls: boolean[] = [];
  const panel = new PanelController({ views: { panels: {
    create: async () => 'main', setHtml: async () => {}, addScript: async () => {}, onMessage: async () => {}, postMessage() {},
    show: async (_id: string, value: boolean) => { calls.push(value); },
  } } } as any, {} as any);
  await panel.initialize(); await panel.show();
  const reply = await panel.handleMessage({ action: 'collapsePanel', protocolVersion: 1, requestId: 'fallback' });
  assert.deepEqual(reply, { ok: true, compact: false });
  assert.deepEqual(calls, [true]);
});

test('issue75: restart restores local hidden, collapsed and expanded states; explicit show overrides memory', async () => {
  const { LOCAL_SETTINGS_PREFIX } = await import('../../src/shared/pluginIdentity');
  const key = LOCAL_SETTINGS_PREFIX + 'panelMode';
  for (const savedMode of ['hidden', 'collapsed', 'expanded'] as const) {
    const host = new MemoryJoplin() as any;
    host.namespace = DEFAULT_PLUGIN_ID;
    host.plugins = { installationDir: async () => '/plugin' };
    host.window = { loadChromeCssFile: async () => {} };
    let visible = new Map<string, boolean>();
    let calls: Array<[string, boolean]> = [];
    let commands = new Map<string, any>();
    const main = 'journey.tasks.panel', mini = 'journey.tasks.mini';
    const boot = async () => {
      visible = new Map(); calls = []; commands = new Map();
      host.commands = { register: async (command: any) => commands.set(command.name, command), execute: async () => {} };
      host.views = { panels: {
        create: async (id: string) => { visible.set(id, true); return id; },
        setHtml: async () => {}, addScript: async () => {}, onMessage: async () => {}, postMessage() {},
        visible: async (id: string) => visible.get(id),
        show: async (id: string, value: boolean) => { visible.set(id, value); calls.push([id, value]); },
      } };
      return startPlugin(host);
    };
    const first = await boot();
    try {
      assert.equal(visible.get(main), true, 'first use retains the expanded default');
      if (savedMode === 'collapsed') await first.panel.handleMessage({ protocolVersion: 1, requestId: 'collapse', action: 'collapsePanel' });
      else if (savedMode === 'hidden') await commands.get('journey.toggleTasks').execute();
      else await commands.get('journey.showTasks').execute();
      assert.equal(host.settingsValues.get(key), savedMode);
    } finally { first.dispose(); }
    const second = await boot();
    try {
      assert.equal(visible.get(main), savedMode === 'expanded', savedMode);
      assert.equal(visible.get(mini), savedMode === 'collapsed', savedMode);
      if (savedMode !== 'expanded') assert.ok(calls.every(([id, shown]) => id !== main || !shown), 'startup never explicitly opens the remembered hidden main panel');
      assert.equal(host.settingsValues.get(key), savedMode, 'startup does not overwrite the saved state');
      if (savedMode === 'hidden') await commands.get('journey.toggleTasks').execute();
      else await commands.get('journey.showTasks').execute();
      assert.equal(visible.get(main), true); assert.equal(visible.get(mini), false);
      assert.equal(host.settingsValues.get(key), 'expanded');
    } finally { second.dispose(); }
    const third = await boot();
    try { assert.equal(visible.get(main), true); assert.equal(visible.get(mini), false); }
    finally { third.dispose(); }
  }
});
