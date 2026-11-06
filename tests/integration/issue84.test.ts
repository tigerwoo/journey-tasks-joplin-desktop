import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SeriesEditor } from '../../src/panel/App';
import { TranslationProvider } from '../../src/i18n/react';
import { createTranslator } from '../../src/i18n';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { MemoryJoplin } from '../support/memory-joplin';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import type { RestoreFirstTarget, ApplicationCommand } from '../../src/services/applicationTypes';
import type { RecurrenceRule, SeriesDefinition } from '../../src/shared/models';

type Command = ApplicationCommand extends infer T ? T extends ApplicationCommand ? Omit<T, 'requestId'> : never : never;
const date = (date: string) => ({ kind: 'allDay' as const, date, zone: 'UTC' });
for (const mode of ['continuous', 'archive'] as const) for (const end of ['count', 'until'] as const) {
  test(`issue84 ${mode}/${end}: edit ended definitions and resume exactly once, preserving history`, async () => {
    const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
    host.notebooks.set('book', { id: 'book', title: 'Book' });
    let sequence = 0;
    const notices: { message: string; target?: RestoreFirstTarget }[] = [];
  const options = { now: () => Date.parse('2026-11-10T12:00:00Z'), onNotice: (message: string, target?: RestoreFirstTarget) => notices.push({ message, target }), randomId: () => (++sequence).toString(16).padStart(32, '0') };
    let app = new TaskApplication(host, options); await app.initialize();
    const send = (command: Command) => app.dispatch({ ...command, requestId: `84-${++sequence}` } as ApplicationCommand);
    const series = async () => (await app.snapshot()).series[0]!;
    const save = async (patch: Partial<SeriesDefinition>, currentSchedule?: ReturnType<typeof date>) => {
      const s = await series(); return send({ action: 'reviseSeries', seriesId: s.seriesId, revisionId: s.definition!.revisionId,
        definition: { ...s.definition!, ...patch }, currentSchedule });
    };
    const rule: RecurrenceRule = { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled',
      end: end === 'count' ? { kind: 'count', count: 1 } : { kind: 'until', date: '2026-11-01' } };
    const made = await send({ action: 'createTask', input: { title: '84', notebookId: 'book', mode, schedule: date('2026-11-01'), recurrence: rule } });
    assert.equal(made.status, 'saved');
    assert.equal((await send({ action: 'complete', seriesId: made.seriesId! })).status, 'saved');
    const ended = await series(); assert.equal(ended.status, 'ended');
    const history = ended.occurrences[0]!;
    assert.equal((await save({ priority: 'high', reminder: { enabled: true } })).status, 'saved');
    assert.equal((await series()).status, 'ended');
    assert.deepEqual((await series()).occurrences, ended.occurrences);
    assert.equal((await save({ anchor: date('2026-11-01'), rule: { ...rule, interval: 2 } })).code, 'SERIES_NO_DATE');
    assert.equal((await save({ anchor: date('2026-10-31') })).code, 'SERIES_ANCHOR_HISTORY');
    const expanded: RecurrenceRule = { ...rule, end: end === 'count' ? { kind: 'count', count: 3 } : { kind: 'until', date: '2026-11-10' } };
    const append = app.journal.append.bind(app.journal);
    if (end === 'count') {
      app.journal.append = async (...args) => {
        if (args[1].kind === 'Advance') throw new Error('Continuation write failed');
        return append(...args);
      };
      const failed = await save({ rule: expanded });
      assert.equal(failed.status, 'error');
      assert.equal((await series()).status, 'ended');
      app.journal.append = append;
    }
    const result = await save({ rule: expanded }); assert.equal(result.status, 'saved', result.message);
    let resumed = await series(); assert.equal(resumed.status, 'active');
    assert.equal(resumed.consumedCount, 1); assert.equal(resumed.occurrences.length, 2);
    assert.deepEqual(resumed.occurrences.find(o => o.occurrenceId === history.occurrenceId), history);
    assert.equal(resumed.occurrences.find(o => o.occurrenceId === resumed.activeOccurrenceId)!.scheduled.date, '2026-11-02');
    assert.equal(host.notes.size, mode === 'archive' ? 2 : 1);
    app.dispose(); app = new TaskApplication(host, options); await app.initialize();
    assert.equal((await send({ action: 'refresh' })).status, 'saved');
    resumed = await series(); assert.equal(resumed.occurrences.length, 2);
    assert.equal((await save({ anchor: date('2026-11-04'), rule: { ...expanded, interval: 2 } })).status, 'saved');
    resumed = await series();
    assert.equal(resumed.occurrences.find(o => o.occurrenceId === resumed.activeOccurrenceId)!.scheduled.date, '2026-11-04');
    assert.equal((await save({}, date('2026-11-05'))).status, 'saved');
    assert.equal((await series()).definition!.anchor.date, '2026-11-04');
    assert.equal((await send({ action: 'complete', seriesId: made.seriesId! })).status, 'saved');
    resumed = await series();
    assert.equal(resumed.occurrences.find(o => o.occurrenceId === resumed.activeOccurrenceId)!.scheduled.date, '2026-11-06');
    if (end === 'count') {
      assert.equal((await send({ action: 'deleteTask', noteId: made.noteId!, seriesId: made.seriesId!, scope: 'stop' })).status, 'saved');
      assert.equal((await send({ action: 'complete', seriesId: made.seriesId! })).status, 'saved');
      assert.equal((await save({})).code, 'SERIES_NO_DATE');
      assert.equal((await series()).status, 'ended');
      assert.equal((await save({ rule: { ...expanded, end: { kind: 'count', count: 4 } }, anchor: date('2026-11-08') })).status, 'saved');
      resumed = await series(); assert.equal(resumed.status, 'active');
      assert.equal(resumed.consumedCount, 3);
      assert.equal(resumed.occurrences.find(o => o.occurrenceId === resumed.activeOccurrenceId)!.scheduled.date, '2026-11-08');
    }
    app.dispose();
  });
}

async function reviewSetup(mode: 'continuous' | 'archive', rule: RecurrenceRule, schedule: import('../../src/shared/models').DatedSchedule = date('2026-11-01'), reminderEnabled = false) {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  let sequence = 0;
  const notices: { message: string; target?: RestoreFirstTarget }[] = [];
  const options = { now: () => Date.parse('2026-11-10T12:00:00Z'), onNotice: (message: string, target?: RestoreFirstTarget) => notices.push({ message, target }), randomId: () => (++sequence).toString(16).padStart(32, '0') };
  let app = new TaskApplication(host, options); await app.initialize();
  const send = (command: Command) => app.dispatch({ ...command, requestId: `review84-${++sequence}` } as ApplicationCommand);
  const made = await send({ action: 'createTask', input: { title: 'Review 84', notebookId: 'book', mode, schedule, recurrence: rule, reminder: { enabled: reminderEnabled, allDayTime: '09:00' } } });
  assert.equal(made.status, 'saved', made.message);
  const series = async () => (await app.snapshot()).series[0]!;
  const save = async (patch: Partial<SeriesDefinition>) => {
    const s = await series(); return send({ action: 'reviseSeries', seriesId: s.seriesId, revisionId: s.definition!.revisionId, definition: { ...s.definition!, ...patch } });
  };
  const complete = async () => { const r = await send({ action: 'complete', seriesId: made.seriesId! }); assert.equal(r.status, 'saved', r.message); };
  const restart = async () => { app.dispose(); app = new TaskApplication(host, options); await app.initialize(); };
  return { host, made, series, save, send, complete, restart, notices, application: () => app, snapshot: () => app.snapshot({ view: 'all', showCompleted: true }), dispose: () => app.dispose() };
}
const reviewDaily: RecurrenceRule = { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } };
for (const mode of ['continuous', 'archive'] as const) {
  test(`issue84 review ${mode}: same-day anchor and time changes preserve completed history`, async () => {
    const timed = (time: string) => ({ kind: 'timed' as const, date: '2026-11-01', time, zone: 'UTC', instant: Date.parse(`2026-11-01T${time}:00Z`), offsetMinutes: 0 });
    const ctx = await reviewSetup(mode, reviewDaily, timed('08:00'));
    try {
      await ctx.complete();
      const history = (await ctx.series()).occurrences.filter(o => o.consumed);
      const result = await ctx.save({ anchor: timed('09:00') }); assert.equal(result.status, 'saved', result.message);
      const after = await ctx.series();
      assert.deepEqual(after.occurrences.filter(o => o.consumed), history);
      const current = after.occurrences.find(o => o.occurrenceId === after.activeOccurrenceId)!;
      assert.equal(current.scheduled.date, '2026-11-02');
      assert.equal(current.scheduled.kind === 'timed' && current.scheduled.time, '09:00');
      await ctx.restart(); assert.equal((await ctx.series()).status, 'active');
    } finally { ctx.dispose(); }
    const days = await reviewSetup(mode, reviewDaily);
    try {
      await days.complete(); await days.complete();
      const before = await days.series();
      assert.equal((await days.save({ anchor: date('2026-11-02') })).status, 'saved');
      const after = await days.series();
      assert.deepEqual(after.occurrences.filter(o => o.consumed), before.occurrences.filter(o => o.consumed));
      assert.equal(after.occurrences.find(o => o.occurrenceId === after.activeOccurrenceId)!.scheduled.date, '2026-11-03');
      assert.equal((await days.save({ anchor: date('2026-11-01') })).code, 'SERIES_ANCHOR_HISTORY');
    } finally { days.dispose(); }
  });

  test(`issue84 review ${mode}: completion-based continuation uses the last completion date`, async () => {
    const rule: RecurrenceRule = { ...reviewDaily, basis: 'completed', interval: 7, end: { kind: 'count', count: 1 } };
    const ctx = await reviewSetup(mode, rule);
    try {
      await ctx.complete();
      const history = (await ctx.series()).occurrences[0]!;
      const result = await ctx.save({ rule: { ...rule, end: { kind: 'count', count: 3 } } });
      assert.equal(result.status, 'saved', result.message);
      const after = await ctx.series();
      assert.equal(after.occurrences.find(o => o.occurrenceId === after.activeOccurrenceId)!.scheduled.date, '2026-11-17');
      assert.deepEqual(after.occurrences.find(o => o.occurrenceId === history.occurrenceId), history);
      await ctx.restart(); assert.equal((await ctx.series()).occurrences.length, 2);
      assert.equal(ctx.host.notes.size, mode === 'archive' ? 2 : 1);
    } finally { ctx.dispose(); }
  });

  test(`issue84 review ${mode}: tightening count abandons and consumes the current period`, async () => {
    const ctx = await reviewSetup(mode, reviewDaily);
    try {
      await ctx.complete(); await ctx.complete();
      const before = await ctx.series(), tail = before.occurrences.find(o => o.occurrenceId === before.activeOccurrenceId)!;
      const rule: RecurrenceRule = { ...reviewDaily, end: { kind: 'count', count: 2 } };
      assert.equal((await ctx.save({ rule })).status, 'saved');
      let after = await ctx.series();
      assert.equal(after.status, 'ended'); assert.equal(after.activeOccurrenceId, undefined);
      assert.equal(after.consumedCount, 3);
      assert.deepEqual(after.occurrences.filter(o => o.occurrenceId !== tail.occurrenceId), before.occurrences.filter(o => o.occurrenceId !== tail.occurrenceId));
      assert.equal(after.occurrences.find(o => o.occurrenceId === tail.occurrenceId)!.resolution, 'skipped');
      assert.ok(ctx.host.notes.get(tail.carrierNoteId)!.todo_completed);
      assert.equal(ctx.host.notes.get(tail.carrierNoteId)!.todo_due, 0);
      await ctx.restart(); assert.equal((await ctx.series()).status, 'ended');
      assert.equal((await ctx.save({ priority: 'high' })).status, 'saved');
      const heads = (await ctx.series()).definition!.revisionId;
      assert.equal((await ctx.save({ rule: { ...rule, end: { kind: 'count', count: 3 } } })).code, 'SERIES_NO_DATE');
      assert.equal((await ctx.series()).definition!.revisionId, heads);
      assert.equal((await ctx.save({ rule: { ...rule, end: { kind: 'count', count: 5 } } })).status, 'saved');
      after = await ctx.series(); assert.equal(after.status, 'active'); assert.equal(after.consumedCount, 3);
      assert.notEqual(after.activeOccurrenceId, tail.occurrenceId);
      await ctx.restart(); assert.equal((await ctx.series()).occurrences.length, 4);
    } finally { ctx.dispose(); }
  });

  for (const end of [{ kind: 'count' as const, count: 10 }, { kind: 'until' as const, date: '2026-11-30' }]) {
    test(`issue84 review ${mode}/${end.kind}: changing the end condition still replaces a postponement`, async () => {
      const ctx = await reviewSetup(mode, reviewDaily);
      try {
        await ctx.complete();
        const before = await ctx.series();
        const current = before.occurrences.find(o => o.occurrenceId === before.activeOccurrenceId);
        assert.ok(current);
        assert.equal((await ctx.send({ action: 'changeDate', noteId: current.carrierNoteId, schedule: date('2026-11-20') })).status, 'saved');
        assert.equal((await ctx.save({ rule: { ...reviewDaily, end } })).status, 'saved');
        const after = await ctx.series(), tail = after.occurrences.find(o => o.occurrenceId === after.activeOccurrenceId)!;
        assert.equal(tail.scheduled.date, '2026-11-02'); assert.equal(tail.deferred, undefined);
      } finally { ctx.dispose(); }
    });
  }
}


test('issue84 review: editor previews completion-based continuation and count retirement before saving', async () => {
  const ctx = await reviewSetup('continuous', { ...reviewDaily, basis: 'completed', interval: 7, end: { kind: 'count', count: 1 } });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let renderer: ReactTestRenderer | undefined;
  try {
    await ctx.complete();
    const series = await ctx.series();
    await act(async () => {
      renderer = create(React.createElement(TranslationProvider, { locale: 'en', children: React.createElement(SeriesEditor, {
        definition: series.definition!, consumedCount: 1, ended: true, history: series.occurrences,
        busy: false, onInsertTemplate() {}, onSave() {},
      }) }));
    });
    const countInput = () => renderer!.root.findAllByType('input').find(input => input.props.max === 100000)!;
    await act(async () => countInput().props.onChange({ target: { value: '3' } }));
    assert.ok(JSON.stringify(renderer!.toJSON()).includes('2026-11-17'));
    await act(async () => renderer!.unmount());
    renderer = undefined;
    await act(async () => {
      renderer = create(React.createElement(TranslationProvider, { locale: 'en', children: React.createElement(SeriesEditor, {
        definition: { ...series.definition!, rule: { ...reviewDaily, end: { kind: 'count', count: 3 } } },
        consumedCount: 2, currentSchedule: date('2026-11-03'), history: series.occurrences,
        busy: false, onInsertTemplate() {}, onSave() {},
      }) }));
    });
    await act(async () => countInput().props.onChange({ target: { value: '2' } }));
    const rendered = JSON.stringify(renderer!.toJSON());
    assert.ok(rendered.includes(createTranslator('en')('field.seriesCountExhausted')));
    assert.ok(!rendered.includes(createTranslator('en')('backend.SERIES_NO_DATE')));
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    ctx.dispose();
  }
});

for (const mode of ['continuous', 'archive'] as const) for (const basis of ['scheduled', 'completed'] as const) {
  for (const currentDate of ['2026-11-01', '2026-11-10', '2026-11-20']) for (const end of ['count', 'until'] as const) {
    test(`issue84 acceptance ${mode}/${basis}/${currentDate}/${end}: rule contraction consumes even a future current period`, async () => {
      const ctx = await reviewSetup(mode, { ...reviewDaily, basis }, date(currentDate));
      try {
        const rule: RecurrenceRule = { ...reviewDaily, basis, end: end === 'count' ? { kind: 'count', count: 1 } : { kind: 'until', date: '2026-10-31' } };
        if (end === 'count') {
          // A count restriction can only exclude an already generated tail after history exists.
          await ctx.send({ action: 'changeDate', noteId: ctx.made.noteId!, schedule: date('2026-11-01') });
          await ctx.complete();
        }
        assert.equal((await ctx.save({ rule })).status, 'saved');
        const s = await ctx.series(); assert.equal(s.status, 'ended');
        assert.equal(s.consumedCount, end === 'count' ? 2 : 1);
        const tail = s.occurrences.at(-1)!; assert.equal(tail.resolution, 'skipped');
        const native = ctx.host.notes.get(tail.carrierNoteId)!;
        assert.ok(native.todo_completed); assert.equal(native.todo_due, 0);
        await ctx.restart(); assert.equal((await ctx.series()).status, 'ended');
        assert.equal((await ctx.save({ rule: { ...reviewDaily, basis } })).status, 'saved');
        const resumed = await ctx.series(); assert.equal(resumed.status, 'active');
        assert.equal(resumed.consumedCount, s.consumedCount);
      } finally { ctx.dispose(); }
    });
  }
  for (const later of mode === 'archive' ? [false, true] : [false]) {
    test(`issue84 acceptance ${mode}/${basis}/${later}: deleting the current note pauses and restoring resumes`, async () => {
      const ctx = await reviewSetup(mode, { ...reviewDaily, basis });
      try {
        if (later) await ctx.complete();
        const before = await ctx.series(), current = before.occurrences.find(o => o.occurrenceId === before.activeOccurrenceId)!;
        assert.equal((await ctx.send({ action: 'deleteNativeTask', noteId: current.carrierNoteId })).status, 'saved');
        assert.ok(ctx.host.notes.get(current.carrierNoteId)!.deleted_time);
        assert.ok(ctx.notices.some(n => n.target?.noteId === current.carrierNoteId));
        const count = ctx.notices.length;
        await ctx.send({ action: 'refresh' }); assert.equal(ctx.notices.length, count);
        assert.equal((await ctx.send({ action: 'restoreFirstNote', noteId: current.carrierNoteId, seriesId: before.seriesId })).status, 'saved');
        const after = await ctx.series(); assert.equal(after.status, 'active');
        assert.equal(after.activeOccurrenceId, before.activeOccurrenceId); assert.equal(after.consumedCount, before.consumedCount);
        assert.ok(!ctx.host.notes.get(current.carrierNoteId)!.deleted_time);
        await ctx.restart(); assert.equal((await ctx.series()).status, 'active');
      } finally { ctx.dispose(); }
    });
    test(`issue84 acceptance ${mode}/${basis}/${later}: detached current note can convert back or stop`, async () => {
      const ctx = await reviewSetup(mode, { ...reviewDaily, basis });
      try {
        if (later) await ctx.complete();
        const before = await ctx.series(), current = before.occurrences.find(o => o.occurrenceId === before.activeOccurrenceId)!;
        await ctx.host.data.put(['notes', current.carrierNoteId], {}, { is_todo: 0, todo_due: 0, todo_completed: 0 });
        await ctx.send({ action: 'refresh' });
        assert.equal(ctx.host.notes.get(current.carrierNoteId)!.is_todo, 0);
        assert.equal((await ctx.series()).status, 'waiting');
        assert.ok(ctx.notices.some(n => n.target?.convert));
        assert.equal((await ctx.send({ action: 'restoreFirstNote', seriesId: before.seriesId, noteId: current.carrierNoteId, convert: true })).status, 'saved');
        assert.equal(ctx.host.notes.get(current.carrierNoteId)!.is_todo, 1);
        assert.equal((await ctx.series()).status, 'active');
        await ctx.host.data.put(['notes', current.carrierNoteId], {}, { is_todo: 0 });
        await ctx.send({ action: 'refresh' });
        assert.equal((await ctx.send({ action: 'dismissDetached', seriesId: before.seriesId, noteId: current.carrierNoteId })).status, 'saved');
        assert.equal((await ctx.series()).status, 'ended');
        assert.equal(ctx.host.notes.get(current.carrierNoteId)!.is_todo, 0);
        await ctx.restart(); assert.equal(ctx.host.notes.get(current.carrierNoteId)!.is_todo, 0);
        assert.equal((await ctx.save({})).status, 'saved');
        assert.equal((await ctx.series()).status, 'active');
        assert.equal(ctx.host.notes.get(current.carrierNoteId)!.is_todo, 1);
      } finally { ctx.dispose(); }
    });
  }
  test(`issue84 acceptance ${mode}/${basis}: delete entire naturally ended series`, async () => {
    const ctx = await reviewSetup(mode, { ...reviewDaily, basis, end: { kind: 'count', count: 1 } });
    try {
      await ctx.complete(); const s = await ctx.series();
      assert.equal((await ctx.send({ action: 'deleteTask', noteId: ctx.made.noteId!, seriesId: s.seriesId, scope: 'history' })).status, 'saved');
      assert.ok([...ctx.host.notes.values()].every(n => n.deleted_time));
      assert.equal((await ctx.snapshot()).series.length, 0);
      await ctx.restart(); assert.equal((await ctx.snapshot()).series.length, 0);
    } finally { ctx.dispose(); }
  });
}

test('issue84 acceptance: converting archive history to notes leaves the active series and template unchanged', async () => {
  const ctx = await reviewSetup('archive', reviewDaily);
  try {
    await ctx.complete(); await ctx.complete();
    const before = await ctx.series();
    const past = before.occurrences.filter(o => o.consumed);
    for (const row of past) await ctx.host.data.put(['notes', row.carrierNoteId], {}, { is_todo: 0 });
    await ctx.send({ action: 'refresh' });
    assert.equal((await ctx.series()).status, 'active'); assert.equal(ctx.notices.length, 0);
    for (const row of past) assert.equal(ctx.host.notes.get(row.carrierNoteId)!.is_todo, 0);
    await ctx.complete(); assert.equal((await ctx.series()).consumedCount, 3);
    for (const row of past) assert.equal(ctx.host.notes.get(row.carrierNoteId)!.is_todo, 0);
  } finally { ctx.dispose(); }
});

for (const edited of [false, true]) for (const ruleConflict of [false, true]) test(`issue84 acceptance: resolve divergent advance candidates and preserve edited notes (${edited}/${ruleConflict})`, async () => {
  const ctx = await reviewSetup('archive', reviewDaily);
  try {
    await ctx.complete();
    const app = ctx.application(), before = await ctx.series();
    const operations = await app.journal.operations<import('../../src/shared/models').DomainOperation>((await app.gateway.getNote(before.controlNoteId))!, before.seriesId);
    const original = operations.find((op): op is Extract<import('../../src/shared/models').DomainOperation, { kind: 'Advance' }> => op.kind === 'Advance')!;
    const current = original.payload.next!;
    const candidateId = 'f'.repeat(32);
    const other = structuredClone(original);
    other.opId = 'zz-concurrent-advance'; other.deviceId = 'other-device'; other.deviceSeq = 1;
    other.payload.next = { ...current, scheduled: date('2026-11-04'), carrierNoteId: candidateId };
    other.payload.candidateNoteId = candidateId;
    const { stableHash } = await import('../../src/domain/identity'); other.payloadHash = stableHash(other.payload);
    const note = ctx.host.notes.get(current.carrierNoteId)!;
    ctx.host.seedNote({ ...note, id: candidateId, user_data: '{}' });
    const meta = (await app.journal.readCarriers((await app.gateway.getNote(current.carrierNoteId))!))[0]!;
    await app.journal.writeCarrier(candidateId, { ...meta, snapshot: { ...meta.snapshot!, schedule: date('2026-11-04') }, creationHash: stableHash({ title: note.title, body: note.body }) });
    await app.journal.append(before.controlNoteId, other, before.seriesId);
    if (ruleConflict) for (const branch of ['branch-a', 'branch-b']) {
      const definition = { ...before.definition!, revisionId: branch, parentRevisionIds: [before.definition!.revisionId], priority: branch === 'branch-a' ? 'high' as const : 'low' as const };
      const payload = { definition };
      await app.journal.append(before.controlNoteId, { ...other, opId: branch, kind: 'ReviseSeries', payload, payloadHash: stableHash(payload), parents: original.parents }, before.seriesId);
    }
    await ctx.send({ action: 'refresh' });
    const conflict = await ctx.series(); assert.equal(conflict.status, 'pausedConflict');
    assert.equal(conflict.advanceChoices?.length, 2);
    if (ruleConflict) {
      assert.equal((await ctx.send({ action: 'keepOccurrence', seriesId: before.seriesId, opId: other.opId })).code, 'SERIES_CONFLICT');
      assert.equal((await ctx.send({ action: 'resolveConflict', seriesId: before.seriesId, definition: conflict.revisionChoices[0]!, revisionIds: conflict.revisionIds })).status, 'saved');
      assert.equal((await ctx.series()).status, 'pausedConflict');
    }
    if (edited) await ctx.host.data.put(['notes', current.carrierNoteId], {}, { body: 'Keep my edits' });
    assert.equal((await ctx.send({ action: 'keepOccurrence', seriesId: before.seriesId, opId: other.opId })).status, 'saved');
    const after = await ctx.series(); assert.equal(after.status, 'active', JSON.stringify({ after, diagnostics: (await ctx.snapshot()).diagnostics }));
    const selected = after.occurrences.find(o => o.occurrenceId === after.activeOccurrenceId)!;
    assert.equal(selected.scheduled.date, '2026-11-04'); assert.equal(selected.carrierNoteId, candidateId);
    assert.equal(!!ctx.host.notes.get(current.carrierNoteId)!.deleted_time, !edited);
    if (edited) { assert.equal(ctx.host.notes.get(current.carrierNoteId)!.body, 'Keep my edits'); assert.ok(ctx.notices.some(n => n.message.includes('Review 84'))); }
    await ctx.restart(); assert.equal((await ctx.series()).status, 'active');
    await ctx.complete(); const next = await ctx.series();
    assert.equal(next.occurrences.find(o => o.occurrenceId === next.activeOccurrenceId)!.scheduled.date, '2026-11-05');
  } finally { ctx.dispose(); }
});

for (const mode of ['continuous', 'archive'] as const) test(`issue84 acceptance ${mode}: reopening the final period preserves ended status and count`, async () => {
  const ctx = await reviewSetup(mode, { ...reviewDaily, end: { kind: 'count', count: 1 } });
  try {
    await ctx.complete(); const before = await ctx.series(), last = before.occurrences[0]!;
    if (mode === 'archive') {
      await ctx.host.data.put(['notes', last.carrierNoteId], {}, { todo_completed: 0 });
      await ctx.send({ action: 'refresh' });
    } else await ctx.send({ action: 'reopen', seriesId: before.seriesId, occurrenceId: last.occurrenceId });
    let after = await ctx.series(); assert.equal(after.status, 'ended'); assert.equal(after.consumedCount, 1);
    assert.equal(after.occurrences[0]!.resolution, 'open'); assert.equal(after.activeOccurrenceId, undefined);
    await ctx.restart(); after = await ctx.series(); assert.equal(after.status, 'ended'); assert.equal(after.consumedCount, 1);
    assert.equal((await ctx.send({ action: 'complete', seriesId: before.seriesId, occurrenceId: last.occurrenceId })).status, 'saved');
    assert.equal((await ctx.series()).occurrences.length, 1); assert.equal(ctx.host.notes.size, 1);
  } finally { ctx.dispose(); }
});

for (const mode of ['continuous', 'archive'] as const) for (const basis of ['scheduled', 'completed'] as const) {
  test(`issue84 latest report ${mode}/${basis}: explicit conversion restores a cleared reminder after history and restart`, async () => {
    const ctx = await reviewSetup(mode, { ...reviewDaily, basis }, date('2026-11-01'), true);
    try {
      await ctx.complete();
      const before = await ctx.series(), current = before.occurrences.find(o => o.occurrenceId === before.activeOccurrenceId)!;
      const expectedDue = ctx.host.notes.get(current.carrierNoteId)!.todo_due;
      assert.ok(expectedDue);
      await ctx.host.data.put(['notes', current.carrierNoteId], {}, { is_todo: 0, todo_due: 0 });
      await ctx.send({ action: 'refresh' });
      await ctx.restart();
      const result = await ctx.send({ action: 'restoreFirstNote', noteId: current.carrierNoteId, seriesId: before.seriesId, convert: true });
      assert.equal(result.status, 'saved', result.message);
      assert.equal(ctx.host.notes.get(current.carrierNoteId)!.todo_due, expectedDue);
      assert.equal(ctx.host.notes.get(current.carrierNoteId)!.is_todo, 1);
      await ctx.send({ action: 'refresh' }); await ctx.restart();
      assert.equal(ctx.host.notes.get(current.carrierNoteId)!.todo_due, expectedDue);
      assert.equal((await ctx.series()).activeOccurrenceId, before.activeOccurrenceId);
      assert.equal((await ctx.series()).consumedCount, before.consumedCount);
    } finally { ctx.dispose(); }
  });
}

test('issue84 latest report: deleting a series requires an explicit scope', async () => {
  const ctx = await reviewSetup('archive', reviewDaily);
  try {
    await ctx.complete();
    const before = await ctx.series(), notes = structuredClone([...ctx.host.notes.values()]);
    const result = await ctx.send({ action: 'deleteTask', noteId: ctx.made.noteId!, seriesId: before.seriesId });
    assert.equal(result.code, 'UNSUPPORTED_ACTION');
    assert.deepEqual([...ctx.host.notes.values()], notes);
    assert.deepEqual(await ctx.series(), before);
  } finally { ctx.dispose(); }
});

for (const basis of ['scheduled', 'completed'] as const) test(`issue84 latest report archive/${basis}: permanently deleted current note has an honest editor hint`, async () => {
  const ctx = await reviewSetup('archive', { ...reviewDaily, basis });
  let renderer: ReactTestRenderer | undefined;
  try {
    await ctx.complete();
    const before = await ctx.series(), current = before.occurrences.find(o => o.occurrenceId === before.activeOccurrenceId)!;
    await ctx.send({ action: 'deleteNativeTask', noteId: current.carrierNoteId });
    await ctx.host.data.delete(['notes', current.carrierNoteId], { permanent: 1 });
    await ctx.send({ action: 'refresh' }); await ctx.restart();
    const ended = await ctx.series();
    assert.equal(ended.status, 'ended'); assert.equal(ended.resumeUnavailable, true);
    const result = await ctx.save({}); assert.equal(result.code, 'SERIES_CURRENT_UNAVAILABLE');
    assert.equal((await ctx.series()).definition!.revisionId, ended.definition!.revisionId);
    assert.equal((await ctx.series()).consumedCount, before.consumedCount);
    let saves = 0;
    await act(async () => {
      renderer = create(React.createElement(TranslationProvider, { locale: 'zh-CN', children: React.createElement(SeriesEditor, {
        definition: ended.definition!, ended: true, resumeUnavailable: ended.resumeUnavailable,
        consumedCount: ended.consumedCount, currentSchedule: current.scheduled,
        busy: false, onInsertTemplate() {}, onSave() { saves++; },
      }) }));
    });
    const rendered = JSON.stringify(renderer!.toJSON()), t = createTranslator('zh-CN');
    assert.ok(rendered.includes(t('backend.SERIES_CURRENT_UNAVAILABLE')));
    assert.ok(!rendered.includes(t('field.seriesResumeHint')));
    assert.equal(renderer!.root.findByProps({ className: 'primary full' }).props.disabled, true);
    await act(async () => renderer!.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.equal(saves, 0);
  } finally { if (renderer) await act(async () => renderer!.unmount()); ctx.dispose(); }
});

test('issue84 latest report: explicit conversion still preserves native edits during projection', async () => {
  const ctx = await reviewSetup('continuous', reviewDaily, date('2026-11-01'), true);
  try {
    await ctx.complete();
    const before = await ctx.series(), current = before.occurrences.find(o => o.occurrenceId === before.activeOccurrenceId)!;
    await ctx.host.data.put(['notes', current.carrierNoteId], {}, { is_todo: 0, todo_due: 0 });
    await ctx.send({ action: 'refresh' });
    const app = ctx.application(), append = app.journal.append.bind(app.journal);
    const changedDue = Date.parse('2026-11-20T15:00:00Z');
    app.journal.append = async (...args) => {
      const result = await append(...args);
      if (args[1].kind === 'ProjectionIntent' && args[1].payload.phase.includes(':restore:'))
        await ctx.host.data.put(['notes', current.carrierNoteId], {}, { todo_due: changedDue });
      return result;
    };
    const result = await ctx.send({ action: 'restoreFirstNote', seriesId: before.seriesId, noteId: current.carrierNoteId, convert: true });
    assert.equal(result.code, 'NATIVE_CHANGED');
    assert.equal(ctx.host.notes.get(current.carrierNoteId)!.todo_due, changedDue);
    assert.equal(ctx.host.notes.get(current.carrierNoteId)!.is_todo, 0);
  } finally { ctx.dispose(); }
});
