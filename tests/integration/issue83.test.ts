import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SeriesEditor } from '../../src/panel/App';
import { TranslationProvider } from '../../src/i18n/react';
import { createTranslator, translateMessage } from '../../src/i18n';
import { stableHash } from '../../src/domain/identity';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { MemoryJoplin } from '../support/memory-joplin';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import type { ApplicationCommand } from '../../src/services/applicationTypes';
import type { RecurrenceRule } from '../../src/shared/models';

type CommandInput<T = ApplicationCommand> = T extends ApplicationCommand ? Omit<T, 'requestId'> : never;

const daily: RecurrenceRule = { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } };
async function setup(mode: 'continuous' | 'archive', converted = false, rule = daily) {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  let sequence = 0, request = 0;
  const options = { now: () => Date.parse('2026-11-10T12:00:00Z'), randomId: () => (++sequence).toString(16).padStart(32, '0') };
  let app = new TaskApplication(host, options); await app.initialize();
  const dispatch = (command: CommandInput) => app.dispatch({ ...command, requestId: `issue83-${++request}` } as ApplicationCommand);
  const made = await dispatch({ action: 'createTask', input: { title: 'Resume', notebookId: 'book', mode,
    schedule: { kind: 'allDay', date: '2026-11-01', zone: 'UTC' }, ...(!converted ? { recurrence: rule } : {}) } });
  assert.equal(made.status, 'saved', made.message);
  if (converted) assert.equal((await dispatch({ action: 'editTask', noteId: made.noteId!, patch: { recurrence: rule, mode } })).status, 'saved');
  const series = async () => (await app.snapshot()).series[0]!;
  const send = async (command: CommandInput) => {
    const result = await dispatch(command);
    assert.equal(result.status, 'saved', result.message); return result;
  };
  const stop = async () => { const s = await series(); return send({ action: 'deleteTask', noteId: made.noteId!, seriesId: s.seriesId, scope: 'stop' }); };
  const saveRule = async (rule = daily) => { const s = await series(); return send({ action: 'reviseSeries', seriesId: s.seriesId, revisionId: s.definition!.revisionId, definition: { ...s.definition!, rule } }); };
  const complete = async () => send({ action: 'complete', seriesId: (await series()).seriesId });
  const restart = async () => { app.dispose(); app = new TaskApplication(host, options); await app.initialize(); };
  return { host, made, series, send, stop, saveRule, complete, restart, dispatch, journal: () => app.journal, snapshot: () => app.snapshot({ view: 'all', showCompleted: true }) };
}

for (const mode of ['continuous', 'archive'] as const) for (const converted of [false, true]) {
  test(`issue83 ${mode}, converted=${converted}: saving rules resumes the same series after repeated stops and restarts`, async () => {
    const ctx = await setup(mode, converted);
    await ctx.complete();
    const original = await ctx.series();
    for (let round = 0; round < 2; round++) {
      await ctx.stop(); await ctx.restart();
      const before = await ctx.series();
      assert.equal(before.status, 'ended');
      const current = before.occurrences.find(o => o.occurrenceId === before.activeOccurrenceId)!;
      const notes = ctx.host.notes.size;
      await ctx.saveRule({ ...daily, interval: 2 });
      const resumed = await ctx.series();
      assert.equal(resumed.seriesId, original.seriesId);
      assert.equal(resumed.status, 'active');
      assert.equal(resumed.activeOccurrenceId, before.activeOccurrenceId);
      assert.deepEqual(resumed.occurrences.filter(o => o.resolution !== 'open'), before.occurrences.filter(o => o.resolution !== 'open'), 'rule changes preserve resolved history');
      assert.equal(resumed.occurrences.find(o => o.occurrenceId === resumed.activeOccurrenceId)!.scheduled.date, round === 0 ? '2026-11-03' : '2026-11-05');
      assert.equal(ctx.host.notes.size, notes, 'saving cannot create another current task');
      await ctx.restart();
      assert.equal((await ctx.series()).status, 'active');
      await ctx.complete(); await ctx.restart();
      const after = await ctx.series();
      assert.equal(after.consumedCount, before.consumedCount + 1);
      const next = after.occurrences.find(o => o.occurrenceId === after.activeOccurrenceId)!;
      assert.equal(next.scheduled.date, round === 0 ? '2026-11-05' : '2026-11-07');
      assert.equal(ctx.host.notes.size, notes + (mode === 'archive' ? 1 : 0));
      assert.equal((await ctx.snapshot()).tasks.filter(t => !t.historical && !t.completedAt).length, 1);
    }
  });

  test(`issue83 ${mode}, converted=${converted}: completion while stopped waits for saving rules, then advances once`, async () => {
    const ctx = await setup(mode, converted);
    await ctx.stop(); await ctx.complete(); await ctx.restart();
    assert.equal((await ctx.series()).status, 'ended');
    assert.equal((await ctx.series()).consumedCount, 0);
    await ctx.saveRule(); await ctx.restart();
    const resumed = await ctx.series();
    assert.equal(resumed.status, 'active'); assert.equal(resumed.consumedCount, 1);
    assert.equal(resumed.occurrences.length, 2);
    assert.equal(ctx.host.notes.size, mode === 'archive' ? 2 : 1);
  });
}

for (const mode of ['continuous', 'archive'] as const) {
  test(`issue83 ${mode}: reopening a completed task and changing mode cannot resume repetition`, async () => {
    const ctx = await setup(mode); await ctx.stop(); await ctx.complete();
    await ctx.send({ action: 'reopen', seriesId: (await ctx.series()).seriesId });
    const s = await ctx.series();
    await ctx.send({ action: 'switchMode', seriesId: s.seriesId, revisionId: s.definition!.revisionId, mode: mode === 'archive' ? 'continuous' : 'archive' });
    await ctx.restart();
    assert.equal((await ctx.series()).status, 'ended');
    assert.equal((await ctx.series()).occurrences.length, 1);
  });

  test(`issue83 ${mode}: resumed repetition still obeys its count limit`, async () => {
    const rule: RecurrenceRule = { ...daily, end: { kind: 'count', count: 2 } };
    const ctx = await setup(mode, false, rule);
    await ctx.complete(); await ctx.stop(); await ctx.saveRule(rule); await ctx.complete(); await ctx.restart();
    assert.equal((await ctx.series()).status, 'ended');
    assert.equal((await ctx.series()).consumedCount, 2);
    assert.equal((await ctx.series()).occurrences.length, 2);
  });
}

for (const mode of ['continuous', 'archive'] as const) {
  test(`issue83 ${mode}: stale rule submissions cannot resume a newly stopped series`, async () => {
    const ctx = await setup(mode);
    const stale = await ctx.series();
    await ctx.saveRule({ ...daily, interval: 2 }); await ctx.stop();
    const result = await ctx.dispatch({ action: 'reviseSeries', seriesId: stale.seriesId,
      revisionId: stale.definition!.revisionId, definition: stale.definition! });
    assert.equal(result.code, 'STALE_REVISION');
    await ctx.restart();
    assert.equal((await ctx.series()).status, 'ended');
  });

  test(`issue83 ${mode}: a missing execution note cannot be recreated by saving rules`, async () => {
    const ctx = await setup(mode); await ctx.complete(); await ctx.stop();
    const s = await ctx.series();
    const current = s.occurrences.find(o => o.occurrenceId === s.activeOccurrenceId)!;
    ctx.host.notes.get(current.carrierNoteId)!.deleted_time = 123;
    const result = await ctx.dispatch({ action: 'reviseSeries', seriesId: s.seriesId,
      revisionId: s.definition!.revisionId, definition: { ...s.definition!, rule: { ...daily, interval: 2 } } });
    assert.equal(result.code, 'SERIES_CURRENT_UNAVAILABLE');
    assert.equal((await ctx.series()).status, 'ended');
    assert.equal((await ctx.series()).definition!.revisionId, s.definition!.revisionId);
    assert.equal(ctx.host.notes.get(current.carrierNoteId)!.deleted_time, 123);
  });

  test(`issue83 ${mode}: resuming cannot generate beyond the rule deadline`, async () => {
    const rule: RecurrenceRule = { ...daily, end: { kind: 'until', date: '2026-11-01' } };
    const ctx = await setup(mode, false, rule); await ctx.stop(); await ctx.saveRule(rule);
    await ctx.complete(); await ctx.restart();
    assert.equal((await ctx.series()).status, 'ended');
    assert.equal((await ctx.series()).occurrences.length, 1);
    assert.equal(ctx.host.notes.size, 1);
  });
}

for (const locale of ['zh-CN', 'en'] as const) test(`issue83 ${locale}: a stopped editor explains resume and hides stop`, async () => {
  const ctx = await setup('continuous');
  const s = await ctx.series();
  const render = (ended: boolean) => renderToStaticMarkup(React.createElement(TranslationProvider, { locale,
    children: React.createElement(SeriesEditor, { definition: s.definition!, consumedCount: s.consumedCount,
      currentSchedule: s.occurrences[0]!.scheduled, ended, busy: false, onInsertTemplate() {}, onStop() {}, onSave() {} }) }));
  const t = createTranslator(locale);
  const active = render(false), stopped = render(true);
  assert.ok(stopped.includes(t('field.seriesResumeHint')));
  assert.ok(stopped.includes('role="status"'));
  assert.ok(!stopped.includes(t('actions.endRepeat')));
  assert.ok(active.includes(t('actions.endRepeat')));
  assert.ok(!active.includes(t('field.seriesResumeHint')));
});

for (const mode of ['continuous', 'archive'] as const) {
  test(`issue83 ${mode}: a failed restore reports saved rules and preserves the storage error for diagnosis`, async () => {
    const ctx = await setup(mode); await ctx.stop();
    const before = await ctx.series();
    const journal = ctx.journal(), append = journal.append.bind(journal);
    journal.append = async (...args) => {
      if (args[1].kind === 'Restore') throw new Error('Restore storage unavailable');
      return append(...args);
    };
    const result = await ctx.dispatch({ action: 'reviseSeries', seriesId: before.seriesId,
      revisionId: before.definition!.revisionId, definition: { ...before.definition!, rule: { ...daily, interval: 3 } } });
    assert.equal(result.status, 'error'); assert.equal(result.code, 'SERIES_RESUME_PENDING');
    assert.match(result.message!, /Restore storage unavailable/);
    assert.match(translateMessage(result.message!, 'zh-CN', result.code), /规则已保存.*刷新后重新保存/);
    assert.match(translateMessage(result.message!, 'en', result.code), /Rules saved.*Refresh/);
    const failed = await ctx.series();
    assert.equal(failed.status, 'ended');
    assert.equal(failed.definition!.rule.interval, 3);
    assert.notEqual(failed.definition!.revisionId, before.definition!.revisionId);
    const diagnostics = (await ctx.snapshot()).diagnostics.filter(d => d.code === 'SERIES_RESUME_PENDING');
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!.message, /Restore storage unavailable/);
    await ctx.restart();
    assert.equal((await ctx.series()).status, 'ended', 'refreshing does not implicitly retry an unwritten restore');
    await ctx.saveRule({ ...daily, interval: 3 }); await ctx.restart();
    assert.equal((await ctx.series()).status, 'active');
    assert.equal((await ctx.series()).occurrences.length, 1);
    assert.equal(ctx.host.notes.size, 1);
  });

  for (const failure of ['journal-write', 'receipt-cleanup'] as const) {
    test(`issue83 ${mode}: ${failure} failure can be retried without duplicate restore or stale receipts`, async () => {
      const ctx = await setup(mode); await ctx.complete(); await ctx.stop();
      const before = await ctx.series();
      const key = `v3:ended:${stableHash(before.seriesId)}`;
      const notes = ctx.host.notes.size;
      if (failure === 'journal-write') {
        const write = ctx.host.data.userDataSet;
        let fail = true;
        ctx.host.data.userDataSet = async (type, id, key, value) => {
          if (fail && (value as { kind?: string })?.kind === 'Restore') {
            fail = false;
            throw new Error('Restore write failed');
          }
          return write(type, id, key, value);
        };
      } else ctx.host.failNext('userDataDelete', `${ctx.made.noteId!}/${key}`);
      const result = await ctx.dispatch({ action: 'reviseSeries', seriesId: before.seriesId,
        revisionId: before.definition!.revisionId, definition: before.definition! });
      assert.equal(result.status, 'error'); assert.equal(result.code, 'SERIES_RESUME_PENDING');
      await ctx.restart();
      assert.equal((await ctx.series()).status, 'active', 'a durable restore intent is replayed');
      await ctx.saveRule(); await ctx.restart();
      assert.equal((await ctx.series()).status, 'active');
      assert.equal(ctx.host.notes.size, notes);
      for (const id of ctx.host.notes.keys()) assert.equal(await ctx.host.data.userDataGet(1, id, key), undefined);
      const root = await ctx.journal().gateway.getNote(ctx.made.noteId!);
      const operations = await ctx.journal().operations(root!, before.seriesId);
      assert.equal(operations.filter(op => op.kind === 'Restore').length, 1);
      assert.ok(!(await ctx.snapshot()).diagnostics.some(d => d.code === 'SERIES_RESUME_PENDING'));
    });
  }
}
