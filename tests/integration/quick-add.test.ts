import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuickAddTask } from '../../src/panel/QuickAddTask';
import { LocalIntentStore, defaultPreferences } from '../../src/adapters/joplin/localIntentStore';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';

function markup(preferences = defaultPreferences, folders = [{ id: 'book', title: '工作' }]) {
  return renderToStaticMarkup(React.createElement(QuickAddTask, {
    preferences, folders, today: '2026-10-27', busy: false,
    onPreferences: async () => undefined, onCreate: async () => undefined,
  }));
}

test('quick add shows its notebook and date defaults, falls back from deleted notebooks, and disables creation without a notebook', () => {
  assert.match(markup(), /添加任务至“工作”/);
  assert.match(markup(), /今天/);
  assert.match(markup({ ...defaultPreferences, quickAddDate: 'none' }), /无日期/);
  assert.match(markup({ ...defaultPreferences, quickAddDate: 'tomorrow' }), /明天/);
  assert.match(markup({ ...defaultPreferences, quickAddDate: '2026-11-02' }), /11月2日/);
  assert.match(markup({ ...defaultPreferences, quickAddNotebookId: 'deleted' }), /添加任务至“工作”/);
  assert.match(markup(defaultPreferences, []), /placeholder="选择笔记本"[^>]*disabled=""/);
});

test('quick-add defaults survive restart and invalid patches leave saved preferences intact', async () => {
  const host = new MemoryJoplin();
  const store = new LocalIntentStore(host, () => 'device');
  await store.initialize();
  for (const quickAddDate of ['today', 'tomorrow', 'none', '2026-12-31']) {
    await store.savePreferences({ quickAddDate, quickAddNotebookId: 'work' });
    const restarted = new LocalIntentStore(host, () => 'device');
    assert.equal((await restarted.preferences()).quickAddDate, quickAddDate);
    assert.equal((await restarted.preferences()).quickAddNotebookId, 'work');
  }
  const before = await store.preferences();
  for (const quickAddDate of ['2026-02-30', '', 'invalid', 123]) {
    await assert.rejects(() => store.savePreferences({ quickAddDate } as any));
    assert.deepEqual(await store.preferences(), before);
  }
});

test('quick-add all-day and undated payloads create native tasks in the chosen notebook without reminders', async () => {
  const host = new MemoryJoplin();
  host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('work', { id: 'work', title: '工作' });
  let sequence = 0;
  const app = new TaskApplication(host, { now: () => Date.parse('2026-10-27T02:00:00Z'), randomId: () => (++sequence).toString(16).padStart(32, '0') });
  await app.initialize();
  for (const date of ['', '2026-10-28']) {
    const result = await app.dispatch({ action: 'createTask', requestId: 'quick-add:' + date, input: {
      title: '快速添加', notebookId: 'work', reminder: { enabled: false },
      schedule: date ? { kind: 'allDay', date, zone: 'Asia/Shanghai' } : { kind: 'none' },
    } });
    assert.equal(result.status, 'saved', result.message);
    const task = (await app.snapshot({ view: 'all' })).tasks.find(task => task.noteId === result.noteId)!;
    assert.equal(task.notebookId, 'work');
    assert.equal(task.schedule.kind, date ? 'allDay' : 'none');
    if (task.schedule.kind !== 'none') assert.equal(task.schedule.date, date);
    assert.equal(task.reminder.enabled, false);
    assert.equal(task.seriesId, undefined);
  }
  assert.equal(host.notes.size, 2);
});
