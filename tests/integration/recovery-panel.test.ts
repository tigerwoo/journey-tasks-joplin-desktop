import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { App, TaskForm } from '../../src/panel/App';
import { TaskList } from '../../src/panel/TaskViews';
import { TaskApplication } from '../../src/services/taskApplication';
import { PanelController } from '../../src/panel/controller';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

for (const failure of ['missing-first', 'damaged-template'] as const) test(`${failure}: no recovery drawer, retry or sync buttons; task editor stays populated`, async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  const app = new TaskApplication(host); await app.initialize();
  await app.dispatch({ action: 'savePreferences', requestId: 'language', preferences: { language: 'zh-CN', defaultView: 'all' } });
  const made = await app.dispatch({ action: 'createTask', requestId: 'create', input: {
    title: 'Visible current task', notebookId: 'book', mode: 'archive', schedule: { kind: 'allDay', date: '2026-01-01', zone: 'UTC' },
    recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
  } });
  await app.dispatch({ action: 'complete', requestId: 'first', noteId: made.noteId! });
  if (failure === 'missing-first') {
    host.notes.get(made.noteId!)!.deleted_time = 123;
    await app.dispatch({ action: 'refresh', requestId: 'deleted' });
  } else {
    host.notes.get(made.noteId!)!.body = '<!-- template:start -->\nbroken template';
    const series = (await app.snapshot()).series[0]!;
    const result = await app.dispatch({ action: 'complete', requestId: 'broken-template', seriesId: made.seriesId, occurrenceId: series.activeOccurrenceId });
    assert.equal(result.code, 'TEMPLATE_FORMAT');
    await app.dispatch({ action: 'savePreferences', requestId: 'show-completed', preferences: { showCompleted: true } });
  }
  const controller = new PanelController({} as any, app);
  const names = ['window', 'document', 'webviewApi'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const noop = () => {};
  Object.assign(globalThis, {
    window: { addEventListener: noop, removeEventListener: noop },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null,
      querySelector: () => null, activeElement: null },
    webviewApi: { onMessage: noop, postMessage: (message: any) => controller.handleMessage(message) },
  });
  let renderer: ReactTestRenderer | undefined;
  const text = (node: any): string => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 0);
    assert.equal(renderer!.root.findAllByProps({ className: 'warning' }).length, failure === 'missing-first' ? 0 : 1);
    for (const warning of renderer!.root.findAllByProps({ className: 'warning' })) {
      assert.equal(warning.findAllByType('button').length, 0, 'diagnostics must recover automatically without manual action buttons');
    }
    assert.doesNotMatch(text(renderer!.root), /查看系列|重试生成下一期|重新读取同步数据/);
    const list = renderer!.root.findAllByType(TaskList).find(list => list.props.items.some((item: any) => item.kind === 'actual' && !item.historical))!;
    const current = list.props.items.find((item: any) => item.kind === 'actual' && !item.historical);
    assert.ok(current);
    await act(async () => list.props.onSelect(current));
    assert.equal(renderer!.root.findAllByType(TaskForm).length, 1);
    const buttons = renderer!.root.findAllByType('button').map(text);
    if (failure === 'missing-first') {
      assert.ok(!buttons.includes('修改重复规则'));
      assert.ok(!buttons.includes('结束重复'));
    }
    assert.doesNotMatch(text(renderer!.root), /查看系列|重试生成下一期|重新读取同步数据/);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    names.forEach((name, i) => { const original = originals[i]; if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); });
  }
});
